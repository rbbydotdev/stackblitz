#!/usr/bin/env node
// serve-matrix.mjs — runs net-harness.mjs and serves its output on :3000 as
// plain text, so the StackBlitz preview (DOM, readable) shows the capability
// matrix without needing to read the canvas terminal. Used as the .stackblitzrc
// startCommand so it auto-runs on tab load.
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let out = "";
let done = false;

const child = spawn(process.execPath, ["net-harness.mjs"], { cwd: here });
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
child.on("close", (code) => { done = true; out += `\n[net-harness exited ${code}]\n`; });
child.on("error", (e) => { done = true; out += `\n[spawn error: ${e.message}]\n`; });

http.createServer((q, r) => {
  r.setHeader("content-type", "text/plain; charset=utf-8");
  r.end(`STATUS: ${done ? "DONE" : "RUNNING"}\n\n${out || "(starting…)"}`);
}).listen(3000, () => console.log("matrix server on :3000"));
