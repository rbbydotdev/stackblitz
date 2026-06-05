// corpus-lib.mjs — shared helpers for the supervisor (run-corpus.mjs) and the
// worker (corpus-worker.mjs). No side effects on import.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const parallelDir = resolve(here, "test", "parallel");

export function outPaths(outDir) {
  return {
    outDir,
    progressPath: resolve(outDir, "progress.jsonl"),
    inflightPath: resolve(outDir, "inflight.json"),
    resultsPath: resolve(outDir, "corpus-results.json"),
    summaryPath: resolve(outDir, "corpus-summary.md"),
  };
}

export function selectTests(filters, limit) {
  let tests = readdirSync(parallelDir)
    .filter((f) => f.startsWith("test-") && f.endsWith(".js"))
    .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
    .sort();
  if (limit > 0) tests = tests.slice(0, limit);
  return tests;
}

// Collect every `// Flags: ...` line from a test header and flatten to argv.
export function parseFlags(src) {
  const flags = [];
  const re = /^\/\/ Flags:(.*)$/gm;
  let m;
  while ((m = re.exec(src))) {
    for (const f of m[1].trim().split(/\s+/)) if (f) flags.push(f);
  }
  return flags;
}

// Read the resume ledger (one JSON object per line); last line wins per test,
// partial/corrupt lines (from a crash mid-append) are skipped.
export function readLedger(progressPath) {
  const map = new Map();
  if (!existsSync(progressPath)) return map;
  for (const line of readFileSync(progressPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); if (e && e.test) map.set(e.test, e); } catch { /* partial line */ }
  }
  return map;
}

// Read inflight.json → array of { test, startedAt, pid }. Tolerant of the older
// plain-string form and of a partial write.
export function readInflight(inflightPath) {
  if (!existsSync(inflightPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(inflightPath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => (typeof e === "string" ? { test: e, startedAt: 0, pid: null } : e)).filter((e) => e && e.test);
  } catch { return []; }
}
