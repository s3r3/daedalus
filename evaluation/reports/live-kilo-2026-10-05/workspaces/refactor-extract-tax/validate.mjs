import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { totalWithTax } from './src/order.js';
import { calculateTax } from './src/tax.js';
assert.equal(calculateTax(100), 20);
assert.equal(totalWithTax(100), 120);
assert.match(readFileSync('./src/order.js', 'utf8'), /calculateTax/);
assert.doesNotMatch(readFileSync('./src/order.js', 'utf8'), /\* 0\.2/);
console.log('tax refactor validation passed');
