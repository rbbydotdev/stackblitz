#!/usr/bin/env node
// introspect-serve.mjs — the WC runtime-autopsy driver, served on :3000 (the
// readable channel; the xterm terminal is a canvas). Set as the .stackblitzrc
// startCommand so it auto-runs on tab load.
//
// It (1) runs each RED-wall test as its own `node <flags> <test>` subprocess to
// get GROUND-TRUTH pass/fail (the gap list says WC passes these — confirm it),
// (2) runs introspect-probe.mjs with the embedder flags to capture HOW, and
// (3) serves the merged JSON. `?file=<path>` downloads any container source file
// (e.g. node_modules deps, or paths surfaced in the probe stack traces).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { here, parallelDir, idsFromListFile, parseFlags } from './corpus-lib.mjs';

const PROBE_FLAGS = ['--expose-internals', '--expose-gc', '--experimental-vm-modules'];
const TEST_TIMEOUT = 20000;

function run(args, { cwd = here, timeout = TEST_TIMEOUT } = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { cwd });
    let out = '', err = '', killed = false;
    const t = setTimeout(() => { killed = true; try { c.kill('SIGKILL'); } catch {} }, timeout);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { clearTimeout(t); res({ code, out, err, killed }); });
    c.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e), killed }); });
  });
}

async function runRedwallTests() {
  const manifest = resolve(here, 'redwall.txt');
  const ids = idsFromListFile(manifest).filter((id) => existsSync(resolve(parallelDir, id)));
  const results = [];
  for (const id of ids) {
    const file = resolve(parallelDir, id);
    const flags = parseFlags(readFileSync(file, 'utf8'));
    const { code, err, killed } = await run([...flags, file]);
    results.push({
      test: id, flags, exit: code, status: killed ? 'TIMEOUT' : (code === 0 ? 'PASS' : 'FAIL'),
      stderrTail: err ? err.slice(-1400) : '',
    });
  }
  return results;
}

async function runProbe() {
  const { out, err, code } = await run([...PROBE_FLAGS, resolve(here, 'introspect-probe.mjs')], { timeout: 30000 });
  try { return JSON.parse(out); } catch { return { __probeError: 'non-JSON output', exit: code, stdoutTail: out.slice(-2000), stderrTail: err.slice(-2000) }; }
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

let REPORT = { status: 'RUNNING', startedAt: new Date().toISOString() };

(async () => {
  const env = { node: process.version, versions: process.versions, execPath: process.execPath, fsScout: fsScout() };
  const [tests, probe] = await Promise.all([runRedwallTests(), runProbe()]);
  const pass = tests.filter((t) => t.status === 'PASS').length;
  REPORT = { status: 'DONE', finishedAt: new Date().toISOString(), env,
    summary: { tests: tests.length, pass, fail: tests.length - pass }, tests, probe };
  try { mkdirSync(resolve(here, 'results'), { recursive: true }); writeFileSync(resolve(here, 'results', 'introspect.json'), JSON.stringify(REPORT, null, 2)); } catch {}
  console.log(`introspect done: ${pass}/${tests.length} RED-wall tests pass in WC`);
})().catch((e) => { REPORT = { status: 'ERROR', error: String(e && e.stack || e) }; });

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
