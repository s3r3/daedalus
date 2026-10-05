import assert from 'node:assert/strict';
import { first, unique } from './src/arrays.js';
assert.equal(first(['a', 'b']), 'a');
assert.deepEqual(unique(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
assert.deepEqual(unique([]), []);
console.log('unique validation passed');
