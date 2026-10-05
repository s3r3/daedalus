import assert from 'node:assert/strict';
import { formatDate } from './src/date.js';
assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
assert.equal(formatDate(new Date(2026, 11, 25)), '2026-12-25');
console.log('date validation passed');
