import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiptLine } from './src/receipt.js';
import { formatPrice } from './src/format.js';
assert.equal(formatPrice(1234), '$12.34');
assert.equal(receiptLine('Coffee', 350), 'Coffee: $3.50');
assert.match(readFileSync('./src/receipt.js', 'utf8'), /formatPrice/);
console.log('price format refactor validation passed');
