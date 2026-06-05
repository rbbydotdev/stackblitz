'use strict';

require('../common');
const fixtures = require('../common/fixtures');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const cwd = fixtures.path('test-runner', 'error-reporter-fail-fast');
const reporterPath = path.join(__dirname, '..', 'common', 'test-error-reporter.js');

test('all tests failures reported without FAIL_FAST flag', async () => {
  const args = [
    `--test-reporter=${reporterPath}`,
    '--test-concurrency=1',
    '--test',
    `${cwd}/*.mjs`,
  ];
  const cp = spawnSync(process.execPath, args);
  const failureCount = (cp.stdout.toString().match(/Test failure:/g) || []).length;
  assert.strictEqual(failureCount, 2);
});

test('FAIL_FAST stops test execution after first failure', async () => {
  const args = [
    `--test-reporter=${reporterPath}`,
    '--test-concurrency=1',
    '--test',
    `${cwd}/*.mjs`,
  ];
  const cp = spawnSync(process.execPath, args, { env: { ...process.env, FAIL_FAST: 'true' } });
  const failureCount = (cp.stdout.toString().match(/Test failure:/g) || []).length;
  assert.strictEqual(failureCount, 1);
});
