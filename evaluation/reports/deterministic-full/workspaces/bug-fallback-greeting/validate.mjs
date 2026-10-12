import assert from 'node:assert/strict';
import { greet } from './src/greeting.js';
assert.equal(greet('Farid'), 'Hello, Farid');
assert.equal(greet(''), 'Hello, friend');
assert.equal(greet(null), 'Hello, friend');
assert.equal(greet(undefined), 'Hello, friend');
console.log('greeting validation passed');
