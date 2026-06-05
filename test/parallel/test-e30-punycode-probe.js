'use strict';
// ada-url shim guard: domainToUnicode decodes punycode (RFC 3492) for xn-- labels.
const url = require('url');
const assert = require('assert');
assert.strictEqual(url.domainToUnicode('xn--bcher-kva.com'), 'bücher.com', 'bücher');
assert.strictEqual(url.domainToUnicode('xn--maana-pta.com'), 'mañana.com', 'mañana');
assert.strictEqual(url.domainToUnicode('example.com'), 'example.com', 'ascii round-trip');
