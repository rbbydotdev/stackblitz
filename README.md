# edgejs-web — Node corpus on StackBlitz WebContainer

Runs the real **Node.js `test/parallel`** suite (3,792 tests) inside a StackBlitz
WebContainer to measure what WebContainer's native `node` actually covers. The
output is written in the **same schema** as the edgejs corpus runner
(`corpus/full/corpus-results.json`) so the two can be diffed directly — what WC
passes that edgejs fails = the target list.

## Why this is the gold-standard baseline

WebContainer runs a real `node` (v22, linux/x64) with a real process model, so
each test runs as its own `node <file>` child process. Exit code 0 = pass, and
`process.on('exit')` / `mustCall`-at-exit verification fire for real — none of
the hidden-pass inflation the in-worker edgejs runner has.

The engine is `child_process` per test (not worker_threads): the WC probe showed
spawn ≈ 28 ms vs worker ≈ 132 ms, and — decisively — worker `execArgv` is
silently dropped in WC while real argv `// Flags:` are honored.

## Getting it onto StackBlitz

This folder is ~74 MB / ~10k files (the test suite + fixtures). Two ways in:

1. **GitHub import (recommended).** Push this folder to a repo, then open
   `https://stackblitz.com/github/<you>/<repo>`. Robust for the file count.
2. **Drag-drop.** New WebContainer project on stackblitz.com → drag the folder
   in. Works but the browser may struggle with this many files.

There are **no dependencies** — nothing to `npm install`.

## Running (in the jsh shell)

Always smoke-test first to confirm `child_process` spawning works in your WC:

```sh
node run-corpus.mjs test-path-      # ~16 tests, should finish in seconds
```

Then run by module, or the whole thing:

```sh
node run-corpus.mjs fs              # every test with "fs" in the name
node run-corpus.mjs test-buffer-    # exact prefix
node run-corpus.mjs                 # FULL corpus (~3,787 tests)
```

The full run is resumable: results stream to `results/progress.jsonl` and a
re-run skips what's already done, so Ctrl-C is safe. Estimated full run ≈
startup (~2 min) + test runtimes; module-by-module is the comfortable way.

### Knobs (env vars)

```sh
CONCURRENCY=8 node run-corpus.mjs            # parallel children (default 4)
TEST_TIMEOUT_MS=30000 node run-corpus.mjs fs # per-test kill cap (default 30s)
STALL_MS=90000 node run-corpus.mjs           # supervisor kill+respawn window
LIMIT=50 node run-corpus.mjs                  # cap count (quick sample)
node run-corpus.mjs --fresh                   # wipe progress + inflight, restart
node run-corpus.mjs --list fs                 # print matching tests, don't run
```

## Resilience (why it won't lock up)

`run-corpus.mjs` is a **supervisor**; it spawns `corpus-worker.mjs` to run the
tests and watches `progress.jsonl` grow. Node's own suite contains tests that
spawn servers/workers/forks — some of which WebContainer can't reap — so a long
sweep can otherwise wedge the container.

- **Soft stall** (worker still alive but a test is stuck): if progress stops for
  `STALL_MS`, the supervisor kills the worker's whole process tree and respawns
  it — automatically, mid-run.
- **Poison test** (one that wedges WC): every test is written to
  `results/inflight.json` (with its PID) the moment it starts. Whatever killed
  it, the next pass marks it **`crash`** and **skips** it, and reaps its orphaned
  PID — so the sweep steps over it instead of re-hitting it forever.
- **Total WC freeze** (whole WASM thread starved): the in-process supervisor
  can't rescue this — **manually restart the StackBlitz container and re-run**.
  Inflight-skip then steps past the culprit automatically.

> Progress lives in untracked `results/`. If reloading the container resets the
> filesystem, commit or download `results/progress.jsonl` before restarting so
> the resume ledger survives.

## Output

Written to `results/`:

- `corpus-results.json` — full per-test results + per-module aggregates (edgejs schema; adds `crash`/`skip`).
- `corpus-summary.md` — human-readable per-module pass-rate table.
- `progress.jsonl` — append-only resume ledger.
- `inflight.json` — tests currently running (used by the supervisor to skip wedgers).

Result statuses: `pass` / `fail` / `timeout` (killed at the per-test cap) /
`crash` (wedged WC, killed+skipped by the supervisor) / `skip` (`common.skip`).

**To get results back:** download `results/corpus-results.json` from the
StackBlitz file tree (right-click → download), or `cat results/corpus-summary.md`
in the shell and copy the table.

## Known WebContainer gaps (from the probe — expect these as failures)

These are real WC limitations, not runner bugs. They'll show up as honest
failures and are part of the coverage map:

- **`--expose-gc` is a no-op** — `global.gc` never appears. Tests calling
  `global.gc()` fail (~40 tests carry this flag).
- **`crypto.generateKeyPairSync('rsa')` is broken** (`createJob(...).run is not
  a function`) — keypair-generation tests fail. (Hashing + `webcrypto.subtle`
  work.)
- **`os.totalmem()` → NaN**, **`process.memoryUsage().rss` → 0** — the few
  tests asserting on these fail.
- **`--expose-internals` works**, so the ~247 internals tests can run.

## Files

```
run-corpus.mjs      supervisor: ledgers, stall watchdog, inflight-skip recovery
corpus-worker.mjs   worker: runs `node <test>` per test (child_process engine)
corpus-lib.mjs      shared helpers (test selection, flag parsing, ledgers)
corpus-format.mjs   bucketing + summary writer (matches edgejs schema)
package.json        no deps; `npm run smoke` / `npm run full`
test/parallel/      3,792 Node test files
test/common/        test helpers (required by ~all tests; index.js has one WC patch)
test/fixtures/      fixture data (~653 tests need it)
```

`test/common/index.js` carries one WebContainer fix: `net.getDefault­AutoSelect­FamilyAttemptTimeout()`
returns `undefined` in WC, which made the original line throw `ERR_OUT_OF_RANGE`
at load and fail *every* test; it's guarded to load cleanly (real
autoSelectFamily tests still run against WC and fail honestly).
