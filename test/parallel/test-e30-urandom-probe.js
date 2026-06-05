'use strict';
// P5d guard: /dev/urandom served by the kernel devfs chardev (random) after the
// vfds interception was gated off kernel-on. Must open + read random (non-zero) bytes.
const fs = require('fs');
const assert = require('assert');
const fd = fs.openSync('/dev/urandom', 'r');
const buf = Buffer.alloc(32);
const n = fs.readSync(fd, buf, 0, 32, null);   // null → sequential fd_read (how urandom is read)
fs.closeSync(fd);
assert.strictEqual(n, 32, '/dev/urandom read should return 32, got ' + n);
assert.ok(buf.some((b) => b !== 0),
  '/dev/urandom must fill with random bytes; got all-zero ' + buf.toString('hex'));
