import assert from 'node:assert/strict';
import { slugify } from './src/slug.js';
assert.equal(slugify(' Hello Daedalus World! '), 'hello-daedalus-world');
assert.equal(slugify('Modes, Tools & Validation'), 'modes-tools-validation');
assert.equal(slugify('---Already--Safe---'), 'already-safe');
console.log('slug validation passed');
