import { existsSync, readFileSync } from 'node:fs';
import type { ValidationResult } from '../contracts.ts';
import type { Validator, ValidatorOptions } from '../validation/index.ts';
import { deckPaths, type DeckSpec } from './deck.ts';
import { validateDeck } from './store.ts';

/**
 * The Slide domain's validator: a slide task is validated against its
 * deck (validateDeck over deck/deck.json), never against the workspace's
 * coding checks. Without this, a slide task run inside a code repo dies
 * on the repo's npm test/lint/build — validation commands that say
 * nothing about the deck (the owner's laptop run, 2026-10-08).
 * A missing deck is a failed check with the remedy named, so the loop's
 * recovery turns push toward create_deck instead of a markdown draft.
 */
export class DeckValidator implements Validator {
  async validate(options: ValidatorOptions): Promise<ValidationResult> {
    const root = options.workspaceRoot;
    const paths = deckPaths(root);
    const check = (status: 'pass' | 'fail', exit_code: number, summary: string): ValidationResult => ({
      checks: [{ name: 'deck', cmd: 'validate_deck', status, exit_code, summary, diagnostics: [] }],
    });
    if (!existsSync(paths.file)) {
      return check('fail', 1, 'no deck exists yet (deck/deck.json) — build the deck with create_deck and add_slide, then validate_deck');
    }
    let deck: DeckSpec;
    try {
      deck = JSON.parse(readFileSync(paths.file, 'utf8')) as DeckSpec;
    } catch (error) {
      return check('fail', 1, `deck/deck.json is unreadable: ${String(error)}`);
    }
    const issues = validateDeck(deck, { root });
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      const first = errors.slice(0, 5).map((issue) => issue.message).join('; ');
      return check('fail', 1, `deck has ${errors.length} validation error(s): ${first}`);
    }
    return check('pass', 0, `deck valid (${deck.slides?.length ?? 0} slides${issues.length ? `, ${issues.length} warning(s)` : ''})`);
  }
}
