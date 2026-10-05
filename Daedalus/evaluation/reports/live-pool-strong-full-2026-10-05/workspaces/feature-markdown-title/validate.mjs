import assert from 'node:assert/strict';
import { firstLine, extractTitle } from './src/markdown.js';
assert.equal(firstLine('# Hello\nbody'), '# Hello');
assert.equal(extractTitle('intro\n# Daedalus Report\n## Details'), 'Daedalus Report');
assert.equal(extractTitle('## Not level one\nbody'), '');
console.log('markdown validation passed');
