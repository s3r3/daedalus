import assert from 'node:assert/strict';
import { normalizeInput, normalize_input } from './src/input.js';
assert.equal(normalizeInput('  Daedalus '), 'daedalus');
assert.equal(normalize_input('  CORE '), 'core');
console.log('normalize refactor validation passed');
