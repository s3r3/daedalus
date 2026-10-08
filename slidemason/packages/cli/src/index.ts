#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';

const main = defineCommand({
  meta: {
    name: 'slidemason',
    version: '0.1.0',
    description: 'Local-first presentation builder powered by agentic coding workflows',
  },
  subCommands: {
    init: () => import('./commands/init.js').then(m => m.default),
    ingest: () => import('./commands/ingest.js').then(m => m.default),
    validate: () => import('./commands/validate.js').then(m => m.default),
    dev: () => import('./commands/dev.js').then(m => m.default),
    build: () => import('./commands/build.js').then(m => m.default),
    'export-pdf': () => import('./commands/export-pdf.js').then(m => m.default),
    'export-static': () => import('./commands/export-static.js').then(m => m.default),
    'publish-github': () => import('./commands/publish-github.js').then(m => m.default),
  },
});

runMain(main);
