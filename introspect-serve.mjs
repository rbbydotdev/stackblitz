#!/usr/bin/env node
// introspect-serve.mjs — the WC runtime-autopsy driver, served on :3000 (the
// readable channel; the xterm terminal is a canvas). Set as the .stackblitzrc
// startCommand so it auto-runs on tab load.
//
// Robustness lessons from WC: child.kill() can't always terminate a wedged
// child, so run() MUST resolve on its own timeout (never wait only on `close`).
// And the probe (the HOW) is the crown jewel, so we run it FIRST and serve
// incrementally — a later test that wedges WC can't cost us the probe data.
//
// It (1) runs introspect-probe.mjs with the embedder flags to capture HOW, then
// (2) runs each RED-wall test as its own `node <flags> <test>` subprocess for
// GROUND-TRUTH pass/fail, updating the served report after each. `?file=<path>`
// downloads any container source file.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { here, parallelDir, idsFromListFile, parseFlags } from './corpus-lib.mjs';

const PROBE_FLAGS = ['--expose-internals', '--expose-gc', '--experimental-vm-modules'];

// Resolve on close OR on timeout (WC kill is unreliable; never hang on `close`).
function run(args, { cwd = here, timeout = 12000 } = {}) {
  return new Promise((res) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); res(r); } };
    let c;
    try { c = spawn(process.execPath, args, { cwd }); }
    catch (e) { return finish({ code: -1, out, err: String(e), killed: false }); }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} finish({ code: null, out, err, killed: true }); }, timeout);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => finish({ code, out, err, killed: false }));
    c.on('error', (e) => finish({ code: -1, out, err: err + String(e), killed: false }));
  });
}

// Scout where WC keeps its node runtime on the virtual FS (for "download code").
function fsScout() {
  const out = {};
  for (const p of ['/', '/usr', '/usr/lib', '/bin', '/.jsh', process.execPath]) {
    try { out[p] = statSync(p).isDirectory() ? readdirSync(p).slice(0, 60) : `file ${statSync(p).size}b`; }
    catch (e) { out[p] = '__err ' + String(e).slice(0, 80); }
  }
  return out;
}

async function flagMatrix() {
  const out = {};
  const combos = [[], ['--expose-gc'], ['--expose-gc', '--experimental-vm-modules'], ['--expose-internals', '--expose-gc'], ['--expose-internals', '--expose-gc', '--experimental-vm-modules']];
  for (const c of combos) {
    const { out: o, err } = await run([...c, '-e', 'console.log(JSON.stringify({gc:typeof global.gc, weakref:typeof WeakRef, finreg:typeof FinalizationRegistry}))'], { timeout: 8000 });
    out[c.join(' ') || '(none)'] = (o || err).trim().slice(0, 200);
  }
  // Is an unhandled rejection fatal in WC? (if not, gc-missing tests "pass" falsely)
  const rej = await run(['-e', 'Promise.reject(new Error("UNHANDLED_PROBE")); setTimeout(()=>console.log("SURVIVED"),100)'], { timeout: 8000 });
  out['__unhandledRejection'] = { exit: rej.code, killed: rej.killed, stdoutTail: rej.out.slice(-120), stderrTail: rej.err.slice(-200) };
  // What does calling a missing global.gc() do to exit code?
  const gcm = await run(['--expose-internals', '--expose-gc', '--experimental-vm-modules', '-e', '(async()=>{ if(typeof global.gc!=="function"){console.log("NO_GC"); await global.gc(); } })().then(()=>console.log("OK")); setTimeout(()=>console.log("END"),100)'], { timeout: 8000 });
  out['__gcMissingCall'] = { exit: gcm.code, stdoutTail: gcm.out.slice(-160), stderrTail: gcm.err.slice(-200) };
  return out;
}

let REPORT = {
  status: 'RUNNING', startedAt: new Date().toISOString(),
  env: { node: process.version, versions: process.versions, execPath: process.execPath, fsScout: fsScout() },
  probe: { __pending: true }, tests: [], progress: 'starting',
};
const save = () => { try { mkdirSync(resolve(here, 'results'), { recursive: true }); writeFileSync(resolve(here, 'results', 'introspect.json'), JSON.stringify(REPORT, null, 2)); } catch {} };

(async () => {
  // 1) PROBE FIRST (the mechanism). 35s cap; resolves even if a gc() probe wedges.
  REPORT.progress = 'running probe';
  const { out, err, code, killed } = await run([...PROBE_FLAGS, resolve(here, 'introspect-probe.mjs')], { timeout: 35000 });
  try { REPORT.probe = JSON.parse(out); }
  catch { REPORT.probe = { __probeError: true, killed, exit: code, stdoutTail: out.slice(-3000), stderrTail: err.slice(-1500) }; }
  save();

  // flag-matrix: which flag combo yields global.gc, and is an unhandled
  // rejection fatal? (settles why test-internal-util-weakreference passes.)
  REPORT.progress = 'flag matrix';
  REPORT.flagMatrix = await flagMatrix();
  save();

  // 2) RED-wall tests, ground-truth pass/fail, served incrementally.
  const ids = idsFromListFile(resolve(here, 'redwall.txt')).filter((id) => existsSync(resolve(parallelDir, id)));
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    REPORT.progress = `tests ${i + 1}/${ids.length}: ${id}`;
    const file = resolve(parallelDir, id);
    const flags = parseFlags(readFileSync(file, 'utf8'));
    const { code: c2, err: e2, killed: k2 } = await run([...flags, file], { timeout: 12000 });
    REPORT.tests.push({ test: id, flags, exit: c2, status: k2 ? 'TIMEOUT' : (c2 === 0 ? 'PASS' : 'FAIL'), stderrTail: e2 ? e2.slice(-1200) : '' });
    save();
  }
  const pass = REPORT.tests.filter((t) => t.status === 'PASS').length;
  REPORT.summary = { tests: REPORT.tests.length, pass, fail: REPORT.tests.length - pass };
  REPORT.status = 'DONE'; REPORT.finishedAt = new Date().toISOString(); REPORT.progress = 'done';
  save();
  console.log(`introspect done: ${pass}/${REPORT.tests.length} RED-wall tests pass in WC`);
})().catch((e) => { REPORT.status = 'ERROR'; REPORT.error = String(e && e.stack || e); save(); });

http.createServer((q, r) => {
  try {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/file') {
      const f = u.searchParams.get('p');
      r.setHeader('content-type', 'text/plain; charset=utf-8');
      try { r.end(readFileSync(f, 'utf8')); } catch (e) { r.statusCode = 404; r.end(String(e)); }
      return;
    }
    r.setHeader('content-type', 'application/json; charset=utf-8');
    r.end(JSON.stringify(REPORT, null, 2));
  } catch (e) { r.statusCode = 500; r.end(String(e)); }
}).listen(3000, () => console.log('introspect server on :3000  (/, /file?p=<path>)'));
