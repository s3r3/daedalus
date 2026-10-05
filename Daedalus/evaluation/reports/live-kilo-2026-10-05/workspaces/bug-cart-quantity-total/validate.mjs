import assert from 'node:assert/strict';
import { total } from './src/cart.js';
assert.equal(total([]), 0);
assert.equal(total([{ price: 10, quantity: 2 }, { price: 5, quantity: 3 }]), 35);
console.log('cart validation passed');
