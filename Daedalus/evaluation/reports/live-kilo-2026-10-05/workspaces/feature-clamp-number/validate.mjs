import assert from 'node:assert/strict';
import { add, subtract, clamp } from './src/math.js';
assert.equal(add(2, 3), 5);
assert.equal(subtract(5, 3), 2);
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(99, 0, 10), 10);
console.log('clamp validation passed');
