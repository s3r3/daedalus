import assert from 'node:assert/strict';
import { DEFAULT_TIMEOUT_MS, timeoutFor } from './src/jobs.js';
import { DEFAULT_TIMEOUT_MS as CONFIG_TIMEOUT } from './src/config.js';
assert.equal(CONFIG_TIMEOUT, 30000);
assert.equal(DEFAULT_TIMEOUT_MS, 30000);
assert.equal(timeoutFor({ fast: true }), 1000);
assert.equal(timeoutFor({}), 30000);
console.log('timeout config refactor validation passed');
