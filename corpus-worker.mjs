#!/usr/bin/env node
// corpus-worker.mjs — runs the actual tests. Spawned (and re-spawned) by the
// supervisor (run-corpus.mjs). It communicates ONLY through files so it stays
// robust even if the supervisor has to SIGKILL it:
//   - appends each finished test to progress.jsonl
//   - keeps inflight.json = the tests currently running, each with its child
//     PID, so the supervisor can (a) mark a wedged test `crash` and (b) reap
//     its orphaned process group if this worker is killed mid-test.
// Config arrives as JSON in CORPUS_CFG. Exits 0 when its slice is done.

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { parallelDir, outPaths, selectTests, parseFlags, readLedger } from "./corpus-lib.mjs";

const cfg = JSON.parse(process.env.CORPUS_CFG || "{}");
const { filters = [], limit = 0, timeout = 30000, concurrency = 4, outDir = "results" } = cfg;
const { progressPath, inflightPath } = outPaths(outDir);

const SKIP_RE = /^1\.\.0\s*#\s*skip/im;
const OUTPUT_CAP = 200_000;

// in-flight registry: test name → { startedAt, pid }. Mirrored to inflight.json
// on every change so the supervisor always has an up-to-date view.
const inFlight = new Map();
function writeInflight() {
  const arr = [...inFlight.entries()].map(([test, v]) => ({ test, startedAt: v.startedAt, pid: v.pid }));
  try { writeFileSync(inflightPath, JSON.stringify(arr)); } catch { /* best effort */ }
}

// Run one test as its own `node` process, supervised so a hung test can't wedge
// its slot. onSpawn(pid) is called once the child exists so the worker can
// record the PID for the supervisor's reaper.
function runOne(testName, onSpawn) {
  return new Promise((resolveOne) => {
    const testPath = resolve(parallelDir, testName);
    let flags = [];
    try { flags = parseFlags(readFileSync(testPath, "utf8")); } catch { /* unreadable → spawn fails below */ }
    const started = Date.now();
    let out = "", err = "", killed = false, settled = false;
    let child, killTimer, reapTimer, graceTimer;

    const hardKill = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* no group / gone */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const classify = (code) =>
      code === 0 ? (SKIP_RE.test(out) || SKIP_RE.test(err) ? "skip" : "pass") : "fail";

    const finalize = (status, code, signal, errorMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer); clearTimeout(reapTimer); clearTimeout(graceTimer);
      hardKill();
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
        cwd: parallelDir, env: process.env,
        stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
    } catch (e) {
      return finalize("fail", null, null, "spawn threw: " + e.message);
    }
    if (onSpawn) onSpawn(child.pid);

    child.stdout?.on("data", (d) => { if (out.length < OUTPUT_CAP) out += d; });
    child.stderr?.on("data", (d) => { if (err.length < OUTPUT_CAP) err += d; });
    child.on("error", (e) => finalize("fail", null, null, "spawn error: " + e.message));
    child.on("close", (code, signal) => finalize(killed ? "timeout" : classify(code), code, signal));
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finalize(killed ? "timeout" : classify(code), code, signal), 250);
    });
    killTimer = setTimeout(() => {
      killed = true;
      hardKill();
      reapTimer = setTimeout(() => finalize("timeout", null, "SIGKILL"), 3000);
    }, timeout);
  });
}

async function runPool(items, conc, work) {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) { const idx = i++; await work(items[idx]); }
  }));
}

async function main() {
  const all = selectTests(filters, limit);
  const done = readLedger(progressPath); // includes crash-marked tests → skipped
  const todo = all.filter((t) => !done.has(t));
  writeInflight(); // start clean ([])

  await runPool(todo, concurrency, async (testName) => {
    inFlight.set(testName, { startedAt: Date.now(), pid: null });
    writeInflight();
    const rec = await runOne(testName, (pid) => {
      const e = inFlight.get(testName); if (e) { e.pid = pid; writeInflight(); }
    });
    appendFileSync(progressPath, JSON.stringify(rec) + "\n");
    inFlight.delete(testName);
    writeInflight();
    console.log(`${rec.status.toUpperCase().padEnd(7)} ${rec.test} (${rec.durationMs}ms)`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
