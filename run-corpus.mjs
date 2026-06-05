#!/usr/bin/env node
// run-corpus.mjs — run the Node.js test/parallel corpus inside a StackBlitz
// WebContainer and emit pass/fail in the edgejs corpus schema.
//
// Engine: one real `node <testfile>` child process per test. Chosen after
// probing the live WebContainer (probe.mjs):
//   - child_process spawn ≈ 28 ms vs worker_threads ≈ 132 ms per test
//   - per-test `// Flags:` are honored as real argv (worker execArgv is
//     SILENTLY DROPPED in WC), and exit codes + process.on('exit')/mustCall
//     verification are the genuine article — no hidden-pass inflation.
//
// Usage:
//   node run-corpus.mjs                       # full test/parallel corpus
//   node run-corpus.mjs fs                     # only names containing "fs"
//   node run-corpus.mjs test-fs- test-buffer-  # multiple filters (OR)
//   node run-corpus.mjs --list fs              # print the matching list, don't run
//   node run-corpus.mjs --fresh                # ignore prior progress, start over
//   node run-corpus.mjs --help
//
// Env knobs:
//   CONCURRENCY=4          parallel child processes (WC reports 8 cpus)
//   TEST_TIMEOUT_MS=30000  per-test wall-clock cap before SIGKILL (then reap)
//   LIMIT=0                cap number of tests run (0 = no cap)
//   OUT=results            output directory (relative to cwd)
//
// Resumability: every finished test appends one line to <OUT>/progress.jsonl;
// a re-run skips tests already recorded there (so Ctrl-C is safe). `--fresh`
// wipes the ledger first.

import {
  readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import { writeJsonResults, writeSummaryMd } from "./corpus-format.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const parallelDir = resolve(here, "test", "parallel");

const argv = process.argv.slice(2);
const opts = argv.filter((a) => a.startsWith("--"));
const filters = argv.filter((a) => !a.startsWith("--"));
const LIST_ONLY = opts.includes("--list");
const FRESH = opts.includes("--fresh");
const HELP = opts.includes("--help") || opts.includes("-h");

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "", 10) || 4;
const TIMEOUT = parseInt(process.env.TEST_TIMEOUT_MS || "", 10) || 30000;
const LIMIT = parseInt(process.env.LIMIT || "", 10) || 0;
const outDir = resolve(process.cwd(), process.env.OUT || "results");
const progressPath = resolve(outDir, "progress.jsonl");
const resultsPath = resolve(outDir, "corpus-results.json");
const summaryPath = resolve(outDir, "corpus-summary.md");

const SKIP_RE = /^1\.\.0\s*#\s*skip/im; // common.skip() prints "1..0 # Skipped: <reason>"
const OUTPUT_CAP = 200_000; // bytes captured per stream before we stop appending

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
}

function selectTests() {
  let tests = readdirSync(parallelDir)
    .filter((f) => f.startsWith("test-") && f.endsWith(".js"))
    .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
    .sort();
  if (LIMIT > 0) tests = tests.slice(0, LIMIT);
  return tests;
}

// Collect every `// Flags: ...` line from a test header and flatten to argv.
function parseFlags(src) {
  const flags = [];
  const re = /^\/\/ Flags:(.*)$/gm;
  let m;
  while ((m = re.exec(src))) {
    for (const f of m[1].trim().split(/\s+/)) if (f) flags.push(f);
  }
  return flags;
}

// Read the resume ledger; last line wins per test, partial/corrupt lines skipped.
function readLedger() {
  const map = new Map();
  if (!existsSync(progressPath)) return map;
  for (const line of readFileSync(progressPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); if (e && e.test) map.set(e.test, e); } catch { /* partial line */ }
  }
  return map;
}

// Run one test as its own `node` process, with supervised resolution so a
// hung test can NEVER wedge its concurrency slot:
//   - 'close'        → clean finish (process exited + stdio pipes drained)
//   - 'exit'+grace   → process exited but 'close' lags because a grandchild
//                      (spawned server/worker) still holds the stdout pipe open
//   - reap timer     → after the timeout kill, WebContainer may surface neither
//                      'exit' nor 'close' for a SIGKILL'd child; force-finalize
// The `settled` guard makes every path idempotent. `detached:true` puts the
// child in its own process group so hardKill() reaps grandchildren too.
function runOne(testName) {
  return new Promise((resolveOne) => {
    const testPath = resolve(parallelDir, testName);
    let flags = [];
    try { flags = parseFlags(readFileSync(testPath, "utf8")); } catch { /* unreadable → spawn fails below */ }
    const started = Date.now();
    let out = "", err = "", killed = false, settled = false;
    let child, killTimer, reapTimer, graceTimer;

    const hardKill = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* no group / unsupported / gone */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };

    const classify = (code) =>
      code === 0 ? (SKIP_RE.test(out) || SKIP_RE.test(err) ? "skip" : "pass") : "fail";

    const finalize = (status, code, signal, errorMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer); clearTimeout(reapTimer); clearTimeout(graceTimer);
      hardKill(); // best-effort: never leave a process holding WC resources
      const rec = { test: testName, status, durationMs: Date.now() - started, exitCode: code ?? null };
      if (signal) rec.signal = signal;
      if (flags.length) rec.flags = flags;
      if (status === "fail" || status === "timeout") {
        let tail = (out + (err ? "\n--- stderr ---\n" + err : "")).trim();
        if (errorMsg) tail = (errorMsg + (tail ? "\n" + tail : "")).trim();
        rec.tail = tail.length > 1500 ? tail.slice(-1500) : tail;
      }
      resolveOne(rec);
    };

    try {
      child = spawn(process.execPath, [...flags, testPath], {
        cwd: parallelDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group → hardKill can reap grandchildren
      });
    } catch (e) {
      return finalize("fail", null, null, "spawn threw: " + e.message);
    }

    child.stdout?.on("data", (d) => { if (out.length < OUTPUT_CAP) out += d; });
    child.stderr?.on("data", (d) => { if (err.length < OUTPUT_CAP) err += d; });
    child.on("error", (e) => finalize("fail", null, null, "spawn error: " + e.message));

    // Clean path: process exited AND pipes drained.
    child.on("close", (code, signal) => finalize(killed ? "timeout" : classify(code), code, signal));
    // Process exited but 'close' is lagging (grandchild holds a pipe): don't
    // wait forever — finalize a beat later. If 'close' arrives first it wins.
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finalize(killed ? "timeout" : classify(code), code, signal), 250);
    });

    // Hard per-test cap → supervisor. Kill, then force-finalize even if WC
    // never reports exit/close for the killed child. This is what stops freezes.
    killTimer = setTimeout(() => {
      killed = true;
      hardKill();
      reapTimer = setTimeout(() => finalize("timeout", null, "SIGKILL"), 3000);
    }, TIMEOUT);
  });
}

async function runPool(items, concurrency, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx]); }
  }));
}

async function main() {
  if (HELP) { usage(); return; }
  mkdirSync(outDir, { recursive: true });
  const all = selectTests();

  if (LIST_ONLY) {
    for (const t of all) console.log(t);
    console.log(`\n${all.length} tests match`);
    return;
  }

  if (FRESH) { try { rmSync(progressPath, { force: true }); } catch { /* none */ } }
  const done = readLedger();
  const todo = all.filter((t) => !done.has(t));

  console.log(`[corpus] node ${process.version} ${process.platform}/${process.arch}, cpus=${os.cpus().length}`);
  console.log(`[corpus] engine=child_process concurrency=${CONCURRENCY} timeout=${TIMEOUT}ms`);
  console.log(`[corpus] ${all.length} selected, ${done.size} already done, ${todo.length} to run\n`);

  const startedAt = Date.now();
  let n = 0;
  await runPool(todo, CONCURRENCY, async (testName) => {
    const rec = await runOne(testName);
    appendFileSync(progressPath, JSON.stringify(rec) + "\n");
    n++;
    console.log(`[${String(n).padStart(4)}/${todo.length}] ${rec.status.toUpperCase().padEnd(7)} ${rec.test} (${rec.durationMs}ms)`);
  });
  const finishedAt = Date.now();

  // Merge the full ledger (prior + this run) into the schema'd outputs.
  const ledger = readLedger();
  const results = all.filter((t) => ledger.has(t)).map((t) => ledger.get(t));
  const summary = writeJsonResults(resultsPath, results, startedAt, finishedAt);
  writeSummaryMd(summaryPath, summary);

  console.log(`\n=== pass rate: ${summary.passRate}%  (${summary.pass}/${summary.totalTests}, excl-skip ${summary.passRateExclSkip}%) ===`);
  console.log(`pass ${summary.pass}  fail ${summary.fail}  timeout ${summary.timeout}  skip ${summary.skip}\n`);
  console.log("per-module:");
  for (const b of summary.perBucket) {
    console.log(`  ${b.bucket.padEnd(20)} ${String(b.pass).padStart(4)}/${String(b.total).padEnd(4)} (${b.passRate}%)`);
  }
  console.log(`\nwrote ${resultsPath}`);
  console.log(`wrote ${summaryPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
