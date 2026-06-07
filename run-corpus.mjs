#!/usr/bin/env node
// run-corpus.mjs — SUPERVISOR for the Node test/parallel corpus on StackBlitz
// WebContainer. It owns the ledgers and keeps the sweep making forward progress
// no matter how badly a test misbehaves:
//
//   - It spawns corpus-worker.mjs to actually run tests (one real `node` per
//     test; engine chosen via probe.mjs — child_process ≈ 28ms vs worker 132ms,
//     and `// Flags:` are honored as real argv).
//   - It watches progress.jsonl grow. If progress stalls for STALL_MS, it kills
//     the worker's whole process tree (+ any test PIDs from inflight.json) and
//     respawns — auto-recovering soft hangs with no babysitting.
//   - Any test that was in-flight when a worker/the container died is marked
//     `crash` and SKIPPED on the next pass, so a poison test that wedges WC is
//     stepped over instead of re-hit forever. (A *total* WC freeze still needs a
//     manual container restart + re-run; after that, inflight-skip carries on.)
//
// Usage:
//   node run-corpus.mjs                       # full corpus
//   node run-corpus.mjs fs                     # names containing "fs"
//   node run-corpus.mjs test-fs- test-buffer-  # multiple filters (OR)
//   node run-corpus.mjs --manifest=<file>      # run exactly the ids in <file> (one/line, # comments)
//   node run-corpus.mjs --list fs              # print matching tests, don't run
//   node run-corpus.mjs --fresh                # wipe progress + inflight, restart
//   node run-corpus.mjs --help
//
// Env knobs:
//   CONCURRENCY=4          parallel child processes in the worker
//   TEST_TIMEOUT_MS=30000  per-test wall-clock cap before SIGKILL (then reap)
//   STALL_MS=90000         no-progress window before the supervisor kills+respawns
//                          the worker (must exceed TEST_TIMEOUT_MS)
//   LIMIT=0                cap number of tests (0 = no cap)
//   OUT=results            output directory (relative to cwd)
//   MAX_NOPROGRESS=4       consecutive no-progress worker cycles before giving up

import { readFileSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { here, outPaths, resolveTestSet, readLedger, readInflight } from "./corpus-lib.mjs";
import { writeJsonResults, writeSummaryMd } from "./corpus-format.mjs";

const argv = process.argv.slice(2);
const opts = argv.filter((a) => a.startsWith("--"));
const filters = argv.filter((a) => !a.startsWith("--"));
const LIST_ONLY = opts.includes("--list");
const FRESH = opts.includes("--fresh");
const HELP = opts.includes("--help") || opts.includes("-h");

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "", 10) || 4;
const TIMEOUT = parseInt(process.env.TEST_TIMEOUT_MS || "", 10) || 30000;
const STALL_MS = parseInt(process.env.STALL_MS || "", 10) || Math.max(90000, TIMEOUT * 2 + 15000);
const LIMIT = parseInt(process.env.LIMIT || "", 10) || 0;
const MAX_NOPROGRESS = parseInt(process.env.MAX_NOPROGRESS || "", 10) || 4;
const outDir = resolve(process.cwd(), process.env.OUT || "results");
const { progressPath, inflightPath, resultsPath, summaryPath } = outPaths(outDir);

// --manifest=<file> runs exactly the ids in that file (one per line, # comments);
// otherwise the positional substring filters select the set.
const MANIFEST = opts.find((a) => a.startsWith("--manifest="))?.slice(11);
const listFile = MANIFEST ? resolve(process.cwd(), MANIFEST) : null;
const cfg = { filters, limit: LIMIT, timeout: TIMEOUT, concurrency: CONCURRENCY, outDir, listFile };
const ALL = resolveTestSet({ listFile, filters, limit: LIMIT });

function usage() {
  console.log(readFileSync(new URL(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
}

const appendProgress = (rec) => appendFileSync(progressPath, JSON.stringify(rec) + "\n");
const clearInflight = () => { try { writeFileSync(inflightPath, "[]"); } catch { /* ignore */ } };

// Kill a test's whole process group (it was spawned detached), best effort.
function reapPid(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone / no group */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

// Mark the in-flight tests recorded by a dead worker as `crash` so they're
// skipped next pass, and reap any orphaned process groups. Returns marked names.
function harvestInflight(reason, onlyOldest) {
  const inflight = readInflight(inflightPath);
  const done = readLedger(progressPath);
  for (const e of inflight) reapPid(e.pid);
  let targets = inflight.filter((e) => !done.has(e.test));
  if (onlyOldest && targets.length > 1) {
    targets = [targets.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0]];
  }
  const marked = [];
  for (const e of targets) {
    appendProgress({ test: e.test, status: "crash", durationMs: 0, note: reason });
    marked.push(e.test);
  }
  clearInflight();
  return marked;
}

function spawnWorker() {
  return spawn(process.execPath, [resolve(here, "corpus-worker.mjs")], {
    cwd: here,
    detached: true, // own process group → we can nuke the whole tree on stall
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CORPUS_CFG: JSON.stringify(cfg) },
  });
}

function writeOutputs(startedAt) {
  const ledger = readLedger(progressPath);
  const all = ALL;
  const results = all.filter((t) => ledger.has(t)).map((t) => ledger.get(t));
  const summary = writeJsonResults(resultsPath, results, startedAt, Date.now());
  writeSummaryMd(summaryPath, summary);
  return summary;
}

async function runWorkerOnce() {
  // Returns "done" | "stall" | "exit:<code>"
  const worker = spawnWorker();
  return await new Promise((res) => {
    let lastCount = readLedger(progressPath).size;
    let lastGrow = Date.now();
    const poll = setInterval(() => {
      const count = readLedger(progressPath).size;
      if (count > lastCount) { lastCount = count; lastGrow = Date.now(); }
      if (Date.now() - lastGrow > STALL_MS) {
        clearInterval(poll);
        try { process.kill(-worker.pid, "SIGKILL"); } catch { /* ignore */ }
        try { worker.kill("SIGKILL"); } catch { /* ignore */ }
        res("stall");
      }
    }, 3000);
    worker.once("exit", (code, signal) => {
      clearInterval(poll);
      res(code === 0 ? "done" : `exit:${code ?? signal}`);
    });
  });
}

async function main() {
  if (HELP) { usage(); return; }
  mkdirSync(outDir, { recursive: true });
  const all = ALL;

  if (LIST_ONLY) {
    for (const t of all) console.log(t);
    console.log(`\n${all.length} tests match`);
    return;
  }

  if (FRESH) {
    try { rmSync(progressPath, { force: true }); } catch { /* none */ }
    try { rmSync(inflightPath, { force: true }); } catch { /* none */ }
  }

  console.log(`[supervisor] node ${process.version} ${process.platform}/${process.arch}, cpus=${os.cpus().length}`);
  console.log(`[supervisor] concurrency=${CONCURRENCY} per-test-timeout=${TIMEOUT}ms stall=${STALL_MS}ms`);

  // Recover poison tests left in-flight by a prior crashed/frozen run.
  const recovered = harvestInflight("in-flight when a prior run died; skipped to make progress", false);
  if (recovered.length) {
    console.log(`[supervisor] skipped ${recovered.length} suspected wedger(s) from a prior run: ${recovered.join(", ")}`);
  }

  const startedAt = Date.now();
  let noProgressCycles = 0;

  // Loud guard: if everything is already in this OUT's ledger, we'd silently
  // replay cached results (the classic "it just skipped them all" surprise).
  if (all.length && all.every((t) => readLedger(progressPath).has(t))) {
    console.log(`[supervisor] all ${all.length} selected test(s) are ALREADY recorded in ${outDir}/progress.jsonl`);
    console.log(`[supervisor] → nothing re-executed (results below are CACHED). To actually re-run:`);
    console.log(`[supervisor]   FRESH=1 node run-corpus.mjs ...   (wipe this ledger), or  OUT=<newdir> ...`);
  }

  while (true) {
    const done = readLedger(progressPath);
    const remaining = all.filter((t) => !done.has(t));
    if (remaining.length === 0) break;

    console.log(`[supervisor] ${all.length} selected, ${done.size} done, ${remaining.length} remaining — launching worker`);
    const before = done.size;
    const result = await runWorkerOnce();
    const after = readLedger(progressPath).size;

    if (result === "stall") {
      const marked = harvestInflight(`stalled WC for >${STALL_MS}ms; killed + skipped`, true);
      console.log(`[supervisor] STALL — killed worker tree${marked.length ? `, skipping poison: ${marked.join(", ")}` : ""}`);
    } else if (result.startsWith("exit:")) {
      const marked = harvestInflight(`worker exited abnormally (${result}); skipped`, true);
      console.log(`[supervisor] worker ${result}${marked.length ? `, skipping poison: ${marked.join(", ")}` : ""}`);
    } else {
      clearInflight(); // clean exit
    }

    if (after <= before && result !== "done") {
      noProgressCycles++;
      if (noProgressCycles >= MAX_NOPROGRESS) {
        console.error(`[supervisor] no progress for ${MAX_NOPROGRESS} cycles — aborting. ` +
          `Restart the WebContainer and re-run; progress is saved.`);
        break;
      }
    } else {
      noProgressCycles = 0;
    }
  }

  const summary = writeOutputs(startedAt);
  console.log(`\n=== pass rate: ${summary.passRate}%  (${summary.pass}/${summary.totalTests}, excl-skip ${summary.passRateExclSkip}%) ===`);
  console.log(`pass ${summary.pass}  fail ${summary.fail}  timeout ${summary.timeout}  crash ${summary.crash}  skip ${summary.skip}\n`);
  console.log("per-module:");
  for (const b of summary.perBucket) {
    console.log(`  ${b.bucket.padEnd(20)} ${String(b.pass).padStart(4)}/${String(b.total).padEnd(4)} (${b.passRate}%)`);
  }
  console.log(`\nwrote ${resultsPath}`);
  console.log(`wrote ${summaryPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
