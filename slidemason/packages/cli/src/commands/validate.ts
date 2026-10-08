import { defineCommand } from 'citty';
import consola from 'consola';
import { validateBrief, validateOutline } from '@slidemason/core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineCommand({
  meta: { name: 'validate', description: 'Validate brief.json and outline.json' },
  run() {
    const generatedDir = resolve('generated');
    let hasErrors = false;

    // Validate brief
    const briefPath = resolve(generatedDir, 'brief.json');
    if (existsSync(briefPath)) {
      const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
      const result = validateBrief(brief);
      if (result.success) {
        consola.success('brief.json is valid');
      } else {
        consola.error('brief.json has errors:');
        for (const error of result.errors) consola.error(`  - ${error}`);
        hasErrors = true;
      }
    } else {
      consola.warn('brief.json not found in generated/');
    }

    // Validate outline
    const outlinePath = resolve(generatedDir, 'outline.json');
    if (existsSync(outlinePath)) {
      const outline = JSON.parse(readFileSync(outlinePath, 'utf-8'));
      const result = validateOutline(outline);
      if (result.success) {
        consola.success('outline.json is valid');
      } else {
        consola.error('outline.json has errors:');
        for (const error of result.errors) consola.error(`  - ${error}`);
        hasErrors = true;
      }
    } else {
      consola.warn('outline.json not found in generated/');
    }

    if (hasErrors) process.exit(1);
  },
});
