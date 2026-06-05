'use strict';
// audit225 guard: chmod-set mode must survive through statSync (edge_stat) AND
// fstatSync on a kernel fd (edge_fstat kernel-fd branch) — not the filetype default.
const fs = require('fs');
const assert = require('assert');
const p = '/p-statmode.txt';
fs.writeFileSync(p, 'x');
fs.chmodSync(p, 0o600);
const m1 = fs.statSync(p).mode & 0o777;
const fd = fs.openSync(p, 'r');
const m2 = fs.fstatSync(fd).mode & 0o777;
fs.closeSync(fd);
assert.strictEqual(m1, 0o600, 'statSync mode should be 0o600, got 0o' + m1.toString(8));
assert.strictEqual(m2, 0o600, 'fstatSync(kernel fd) mode should be 0o600, got 0o' + m2.toString(8));
