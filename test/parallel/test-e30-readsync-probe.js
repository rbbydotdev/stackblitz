'use strict';
// e30 regression guard — readSync(fd, Buffer.alloc(n)) must fill the buffer.
// Root cause: Buffer.alloc(n) [no fill] used to return a JS-heap FastBuffer that
// emnapi v2 couldn't alias to wasm memory, so the C++ read filled a mirror and the
// JS Buffer read zeros. Fixed by buffer-wasm-aliased's alloc-wasm-backed patch.
const fs = require('fs');
const assert = require('assert');
const p = '/probe-e30.txt';
fs.writeFileSync(p, 'HELLO-e30');
const fd = fs.openSync(p, 'r');
const buf = Buffer.alloc(16);                  // no fill → must still be wasm-backed
const n = fs.readSync(fd, buf, 0, 16, null);   // null position → sequential fd_read
fs.closeSync(fd);
const got = buf.toString('utf8', 0, n);
assert.strictEqual(n, 9, 'readSync should return 9, got ' + n);
assert.strictEqual(got, 'HELLO-e30',
  'readSync must fill Buffer.alloc; got ' + JSON.stringify(got)
  + ' hex=' + buf.subarray(0, 9).toString('hex'));
