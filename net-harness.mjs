#!/usr/bin/env node
// net-harness.mjs — characterize this runtime's networking BEHAVIOR (not just
// pass/fail). Each probe exercises ONE primitive in isolation, timeout-guarded
// so a behavior WC can't do in-container (it falls back to the host-localhost
// gate and hangs) shows up as HANG instead of wedging the run.
//
// Run:  node net-harness.mjs          (paste the matrix back)
//       node net-harness.mjs --json   (machine-readable; writes net-capabilities.json)
//
// The matrix is the spec for edgejs: OK = WC does it in-container (replicate it),
// HANG = WC bounces it to the host gate (replicate or stub the loopback path),
// FAIL = unsupported (decide: implement or leave a stub/interface).

import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const PROBE_MS = 4000;
const CHILD = new URL("./_net_harness_child.cjs", import.meta.url).pathname;
writeFileSync(CHILD, `
const [,, mode, portS] = process.argv; const port = +portS;
setTimeout(() => process.exit(3), 3000);
if (mode === 'http') {
  require('http').get({ host: '127.0.0.1', port }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ process.stdout.write(d); process.exit(0); }); }).on('error', e => { process.stderr.write(e.message); process.exit(1); });
} else {
  const c = require('net').connect(port, '127.0.0.1', () => c.write('xtcp'));
  c.on('data', d => { process.stdout.write(d); c.end(); process.exit(0); });
  c.on('error', e => { process.stderr.write(e.message); process.exit(1); });
}
`);
const crossProc = (mode, port) => new Promise((res) => {
  const ch = spawn(process.execPath, [CHILD, mode, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; ch.stdout.on("data", d => out += d); ch.stderr.on("data", d => err += d);
  ch.on("close", (code) => res({ code, out, err }));
  setTimeout(() => { try { ch.kill("SIGKILL"); } catch {} }, PROBE_MS - 200);
});

// probe wrapper: fn(setCleanup) → resolve {result,detail} | throw (FAIL) | never (HANG)
async function probe(name, note, fn) {
  let cleanup = () => {};
  const timeout = new Promise((r) => setTimeout(() => r({ result: "HANG", detail: `no result in ${PROBE_MS}ms (likely host-gate fallback)` }), PROBE_MS));
  let out;
  try {
    out = await Promise.race([
      Promise.resolve(fn((c) => { cleanup = c; })).then((r) => r || { result: "OK", detail: "" }).catch((e) => ({ result: "FAIL", detail: String(e && e.message || e).slice(0, 70) })),
      timeout,
    ]);
  } catch (e) { out = { result: "FAIL", detail: String(e && e.message || e).slice(0, 70) }; }
  try { cleanup(); } catch {}
  return { name, note, ...out };
}

const httpServer = (handler) => http.createServer(handler);

const probes = [
  // ---- loopback substrate ----
  ["http same-proc 127.0.0.1", "literal loopback IP", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("ok")); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => http.get({ host: "127.0.0.1", port: s.address().port }, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res({ result: d === "ok" ? "OK" : "FAIL", detail: d })); }).on("error", rej));
  })],
  ["http same-proc localhost", "hostname resolution", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("ok")); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, () => http.get({ host: "localhost", port: s.address().port }, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res({ result: d === "ok" ? "OK" : "FAIL", detail: d })); }).on("error", rej));
  })],
  ["http same-proc default host", "no host (Node default)", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("ok")); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, () => http.get({ port: s.address().port }, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res({ result: d === "ok" ? "OK" : "FAIL", detail: d })); }).on("error", rej));
  })],
  ["http CROSS-proc", "child node → parent server", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("xproc")); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", async () => { const r = await crossProc("http", s.address().port); res({ result: r.code === 0 && r.out === "xproc" ? "OK" : "FAIL", detail: `code=${r.code} out=${r.out} ${r.err.slice(0, 40)}` }); });
  })],
  ["net raw same-proc", "raw TCP echo", (cln) => new Promise((res, rej) => {
    const s = net.createServer((c) => c.on("data", (d) => c.write(d))); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const c = net.connect(s.address().port, "127.0.0.1", () => c.write("ping")); c.on("data", (d) => res({ result: d.toString() === "ping" ? "OK" : "FAIL", detail: d.toString() })); c.on("error", rej); });
  })],
  ["net raw CROSS-proc", "child → parent raw TCP", (cln) => new Promise((res, rej) => {
    const s = net.createServer((c) => c.on("data", (d) => c.write(d))); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", async () => { const r = await crossProc("tcp", s.address().port); res({ result: r.code === 0 && r.out === "xtcp" ? "OK" : "FAIL", detail: `code=${r.code} out=${r.out}` }); });
  })],
  ["connect refused", "closed port → ECONNREFUSED", (cln) => new Promise((res) => {
    const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => { const c = net.connect(port, "127.0.0.1"); cln(() => c.destroy()); c.on("connect", () => res({ result: "FAIL", detail: "connected to a closed port" })); c.on("error", (e) => res({ result: e.code === "ECONNREFUSED" ? "OK" : "FAIL", detail: e.code })); }); });
  })],

  // ---- socket lifecycle (the WC weak spot) ----
  ["keep-alive reuse", "Agent reuses one socket for 2 reqs", (cln) => new Promise((res, rej) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let created = 0; const orig = agent.createConnection.bind(agent);
    agent.createConnection = (...a) => { created++; return orig(...a); }; // count real sockets opened
    const s = httpServer((_q, r) => r.end("k")); cln(() => { s.close(); agent.destroy(); });
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const port = s.address().port;
      http.get({ port, agent }, (r) => { r.resume(); r.on("end", () => {
        setTimeout(() => { // let the socket return to the pool before req #2
          http.get({ port, agent }, (r2) => { r2.resume(); r2.on("end", () => res({ result: created === 1 ? "OK" : "FAIL", detail: `${created} socket(s) opened for 2 reqs` })); }).on("error", rej);
        }, 80);
      }); }).on("error", rej);
    });
  })],
  ["client abort mid-flight", "req.destroy() → server 'aborted'", (cln) => new Promise((res, rej) => {
    const s = httpServer((req) => { req.on("aborted", () => res({ result: "OK", detail: "server saw abort" })); }); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const req = http.get({ port: s.address().port }, () => {}); req.on("error", () => {}); setTimeout(() => req.destroy(), 150); });
  })],
  ["server destroy (RST)", "server.destroy → client ECONNRESET", (cln) => new Promise((res, rej) => {
    const s = net.createServer((c) => c.destroy()); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const c = net.connect(s.address().port, "127.0.0.1"); c.on("error", (e) => res({ result: ["ECONNRESET", "EPIPE"].includes(e.code) ? "OK" : "FAIL", detail: e.code })); c.on("close", () => res({ result: "OK", detail: "closed" })); });
  })],
  ["half-close", "allowHalfOpen: client ends, server writes", (cln) => new Promise((res, rej) => {
    const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on("end", () => { c.end("after-half"); }); }); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const c = net.connect({ port: s.address().port, host: "127.0.0.1", allowHalfOpen: true }, () => c.end()); let d = ""; c.on("data", (x) => d += x); c.on("end", () => res({ result: d === "after-half" ? "OK" : "FAIL", detail: d })); c.on("error", rej); });
  })],
  ["raw net → http server", "net.connect + raw GET to http", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("raw")); cln(() => s.close());
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const c = net.connect(s.address().port, "127.0.0.1", () => c.write("GET / HTTP/1.0\r\n\r\n")); let d = ""; c.on("data", (x) => d += x); c.on("end", () => res({ result: /raw/.test(d) ? "OK" : "FAIL", detail: d.split("\r\n")[0] })); c.on("error", rej); });
  })],

  // ---- binding ----
  ["listen 0.0.0.0", "bind all, connect 127.0.0.1", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end("ok")); cln(() => s.close());
    s.on("error", (e) => res({ result: "FAIL", detail: e.code || e.message }));
    s.listen(0, "0.0.0.0", () => http.get({ host: "127.0.0.1", port: s.address().port }, (r) => { r.resume(); r.on("end", () => res({ result: "OK", detail: "" })); }).on("error", rej));
  })],
  ["listen fixed port", "bind a chosen port (not 0)", (cln) => new Promise((res) => {
    const s = httpServer((_q, r) => r.end("ok")); cln(() => s.close());
    s.on("error", (e) => res({ result: "FAIL", detail: e.code || e.message }));
    s.listen(18099, "127.0.0.1", () => http.get({ host: "127.0.0.1", port: 18099 }, (r) => { r.resume(); r.on("end", () => res({ result: "OK", detail: "port 18099" })); }).on("error", (e) => res({ result: "FAIL", detail: e.code })));
  })],

  // ---- udp ----
  ["dgram udp4 loopback", "send/recv on 127.0.0.1", (cln) => new Promise((res) => {
    const srv = dgram.createSocket("udp4"); cln(() => { try { srv.close(); } catch {} });
    srv.on("error", (e) => res({ result: "FAIL", detail: e.message })); srv.on("message", (m) => res({ result: m.toString() === "udp" ? "OK" : "FAIL", detail: m.toString() }));
    srv.bind(0, "127.0.0.1", () => { const cli = dgram.createSocket("udp4"); cli.send("udp", srv.address().port, "127.0.0.1", (e) => { if (e) res({ result: "FAIL", detail: e.message }); try { cli.close(); } catch {} }); });
  })],

  // ---- upgrade (websocket handshake substrate) ----
  ["http upgrade event", "server 'upgrade' fires", (cln) => new Promise((res, rej) => {
    const s = httpServer((_q, r) => r.end()); cln(() => s.close());
    s.on("upgrade", (_req, sock) => { res({ result: "OK", detail: "upgrade fired" }); sock.destroy(); });
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const req = http.request({ port: s.address().port, headers: { Connection: "Upgrade", Upgrade: "websocket" } }); req.on("error", () => {}); req.end(); });
  })],
];

const want = process.argv.includes("--json");
const results = [];
for (const [name, note, fn] of probes) results.push(await probe(name, note, fn));

console.log(`\nnetworking capability matrix — node ${process.version} ${process.platform}/${process.arch}\n`);
const icon = (r) => (r === "OK" ? "✅" : r === "HANG" ? "⛔HANG" : "❌FAIL");
for (const r of results) console.log(`${icon(r.result).padEnd(7)} ${r.name.padEnd(26)} ${r.note}${r.detail ? "  — " + r.detail : ""}`);
const c = (s) => results.filter((r) => r.result === s).length;
console.log(`\nOK ${c("OK")}  HANG ${c("HANG")}  FAIL ${c("FAIL")}   (HANG = bounced to host gate; OK = in-container)`);

if (want) {
  writeFileSync(new URL("./net-capabilities.json", import.meta.url), JSON.stringify({ runtime: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2) + "\n");
  console.log("\nwrote net-capabilities.json");
}
try { unlinkSync(CHILD); } catch {}
process.exit(0); // probes leave open handles (servers/agents/dgram); exit cleanly
