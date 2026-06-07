# edgejs ↔ WebContainer Test Parity — FINAL

How we used StackBlitz WebContainer (WC) as a yardstick to scope exactly which
Node features `edgejs-web` needs to support, what we found, and how to drive it
to parity.

---

## TL;DR

- **WC is the right yardstick** for edgejs: it's a real Node (v22.22.0) running in
  a browser sandbox — the *same class of runtime* as edgejs. **What WC can't do, a
  browser-Node generally can't do either.** So we target *what WC passes*, not all
  of Node.
- We ran the **full `test/parallel` corpus (3,791 tests) inside WC**: **1,672 pass**
  → that's the target set. The rest are WC's own ceiling (correctly excluded).
- Of those 1,672 targets, **edgejs currently fails ~365** → the work queue.
- The networking timeouts were **investigated and confirmed real WC gaps** (http2,
  tls, cluster, dgram are genuinely broken in WC) — **not** false negatives from our
  harness or our free account. So the target set is solid; nothing hidden.
- **First concrete fix:** ~44 tests fail in edgejs with one `RangeError: offset is
  out of bounds` (a SharedArrayBuffer serialization bug).

---

## Why we did this

edgejs-web runs Node-style code in the browser. To know *which* Node features it
must support, we needed a realistic ceiling — not "all of Node" (impossible in a
sandbox), but "what's achievable for a browser-Node." StackBlitz WebContainer is
exactly that reference. Running the Node test corpus inside WC tells us the
achievable target; running it inside edgejs tells us the gap.

---

## What we found (the numbers)

**Full WC run** (`node v22.22.0 linux/x64`, child_process engine, one real `node`
per test):

| | count |
|---|---:|
| total | 3,791 |
| **pass** (the targets) | **1,672** (44.1%) |
| fail | 1,622 |
| timeout | 390 |
| crash | 20 |
| skip | 87 |

**edgejs vs the 1,672 targets** (diffed against edge's own corpus results):

| | count | meaning |
|---|---:|---|
| aligned | ~1,305 | edge already passes ✅ |
| **gap** | **~365** | WC-pass, edge-fail → **the work queue** |
| edge-ahead | 708 | edge passes where WC *fails* (real-wasm OpenSSL etc. — edge already beats WC) |

**Keystone clusters in the 365** (one root cause → many flips):

- **`offset is out of bounds` — 44** — edge SharedArrayBuffer serialization bug
  (cluster/dgram/net). **Start here.**
- `mustCall mismatch (deferred)` — 64 — architectural (libuv self-drain).
- `https.request outbound TLS not available` — 9 — wire to the working tls layer.
- `EBADF read` (stdin/tty) — 8 — also gates several `repl` tests.

---

## The capability boundary (what WC supports = what edge must support)

Measured directly with `net-harness.mjs` (isolated, loopback, no Pro) —
**OK 14 / HANG 2 / FAIL 4**:

**WC supports → edgejs must match:**
- http + raw TCP loopback, **same- and cross-process**
- `localhost` / `127.0.0.1` / default host resolution
- `ECONNREFUSED` on closed ports
- server destroy (RST), half-close
- `listen(0.0.0.0)`, fixed ports
- http `upgrade` event, `dns.lookup`

**WC does NOT support (real gaps — each a concrete internal error, *not* our
harness/account):**
- **http2** — `n.consume is not a function`
- **tls** loopback — handshake never completes (pure self-connection, so *not* the
  Pro/CORS gate — confirmed)
- **cluster** — `onread is not a function`
- **dgram / UDP** — `u.getAsyncId is not a function`
- keep-alive socket reuse (opens a new socket per request)
- client-abort propagation (server never sees the abort)

> These are WC's ceiling. edge is **not** required to match them for parity —
> though with real OpenSSL wasm, edge could later *exceed* WC on tls/http2.

**WC environment quirks found along the way:** `--expose-gc` is a no-op,
`crypto.generateKeyPairSync('rsa')` is broken, `os.totalmem()`→NaN,
`process.memoryUsage().rss`→0, `node -e` parses input as TypeScript, and
`net.getDefaultAutoSelectFamilyAttemptTimeout()` returns `undefined` (this one
crashed `test/common/index.js` at load and failed *every* test until guarded).

---

## How we worked through it

1. **Built a faithful WC corpus runner** — one real `node <testfile>` per test
   (chosen after probing: `child_process` spawn ≈ 28 ms vs `worker_threads` ≈ 132 ms,
   and worker `execArgv` is silently dropped so per-test `// Flags:` only work via
   real argv). Honest exit codes + `mustCall`-at-exit, unlike an in-worker runner.
2. **Hardened it** — a supervisor watches `progress.jsonl`; on a stall it kills the
   worker tree and respawns; an inflight ledger marks poison tests `crash` and skips
   them, so a test that wedges WC can't freeze the sweep.
3. **Fixed the harness vs measured the runtime** — one `common/index.js` crash was
   ours (guarded); after that, failures were real signal.
4. **Diffed WC-pass vs edge results** (`corpus-compare.mjs`) → the gap + keystones.
5. **Chased the networking timeouts properly.** The key correction: *a timeout in
   our run ≠ WC lacks the feature* — it could be our harness or our (free, no-Pro)
   account. So we built **behavior probes** (`net-harness.mjs`) that assert WC's real
   support in isolation over loopback (no Pro needed). The verdict: the big
   networking subsystems are **genuinely broken in WC**, so the timeouts were
   correctly excluded — not an under-count.
6. **Automated the WC loop** via a Chrome-control MCP: push → refresh the StackBlitz
   tab → `serve-matrix.mjs` runs the harness and serves the result on `:3000` →
   read it from the preview (the terminal is a canvas, so unreadable; the `:3000`
   preview is DOM text). No Pro required.

---

## The toolkit

**In this repo (`rbbydotdev/stackblitz`, runs inside WC):**

| file | purpose |
|---|---|
| `run-corpus.mjs` | supervisor: ledgers, stall watchdog, inflight-skip; `--manifest=<file>`, `--label`, `FRESH=1` |
| `corpus-worker.mjs` | runs `node <test>` per test (child_process engine) |
| `corpus-lib.mjs` | shared: test selection, flag parsing, ledgers, manifest resolution |
| `corpus-format.mjs` | results JSON + summary (matches the edgejs corpus schema) |
| `net-harness.mjs` | networking **behavior** probes → capability matrix (loopback, no Pro) |
| `serve-matrix.mjs` | runs net-harness and serves output on `:3000` for the automated read loop |
| `net-timeouts.txt` | the 255 net-transport tests that timed out (for targeted re-runs) |
| `WEBCONTAINER_NETWORKING.md` | how WC networking works (CORS proxy, host-localhost, LNA) |

**In the edgejs repo (analysis side):**

- `browser-target/scripts/corpus-compare.mjs` — diff WC-pass vs edge → gap.
- `browser-target/scripts/corpus-groups/stackblitz-passing.txt` — the **1,672 targets**.
- `browser-target/scripts/corpus-groups/stackblitz-gap.txt` — the **~365 work queue** (reason-annotated).
- `corpus/runs/stackblitz-gap/` — edge's results on the gap (owned, isolated dir).

### How to run

```sh
# Full WC corpus (inside WC):
node run-corpus.mjs

# Just a list (e.g. re-run timeouts):
OUT=net-timeouts node run-corpus.mjs --manifest=net-timeouts.txt

# Networking capability matrix:
node net-harness.mjs            # add --json for net-capabilities.json

# Automated read loop (no manual paste): set .stackblitzrc startCommand to
# "node serve-matrix.mjs", refresh the tab, read :3000.
```

```sh
# edge side (in the edgejs repo), run the targets through edgejs + diff:
cd browser-target && npm run corpus:pick -- --group=stackblitz-gap --label=stackblitz-gap
node browser-target/scripts/corpus-compare.mjs   # regenerates stackblitz-gap.txt
```

---

## Next steps — driving edgejs to WC parity

1. **Fix the SAB keystone (44 tests).** `RangeError: offset is out of bounds` in
   edge's SharedArrayBuffer serialization (cluster/dgram/net). One root cause →
   ~44 flips. Highest leverage.
2. **Wire `https.request` to the working tls layer (9).** edge passes `tls` but
   gates `https.request` with "outbound TLS not available."
3. **Fix `EBADF` stdin/tty reads (8)** — also unlocks a chunk of `repl`.
4. **Then the architectural mustCall-deferred (64)** — its own campaign
   (libuv-wasix self-drain).
5. **Re-measure after each** — run the gap group through edgejs and re-diff; the
   gap count is the parity score.

**Optional / later:** edge could *exceed* WC on tls/http2 (real OpenSSL wasm) — a
"beat WC," not "match WC," campaign.

### Two open caveats (small)
- A few of the 1,672 may be WC **false positives** (stubbed default values not
  deeply asserted) — not yet audited; likely few.
- Non-networking exclusions (some `child`/`fs`/`inspector` timeouts) were trusted
  as WC-fails but not probed one-by-one like networking was.

---

*Parity score = (1,672 − gap) / 1,672. Today: ~1,305 / 1,672 ≈ 78%. Close the 365.*
