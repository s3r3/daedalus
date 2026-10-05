import assert from 'node:assert/strict';
import { csvRow, quoteCsvCell } from './src/csv.js';
assert.equal(csvRow(['a', 'b']), 'a,b');
assert.equal(quoteCsvCell('plain'), 'plain');
assert.equal(quoteCsvCell('a,b'), '"a,b"');
assert.equal(quoteCsvCell('say "hi"'), '"say ""hi"""');
assert.equal(quoteCsvCell('line1\nline2'), '"line1\nline2"');
console.log('csv validation passed');
