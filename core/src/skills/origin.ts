/** Skill origin taxonomy + its human label — pure, browser-safe (the Web renders origin badges). */

export type SkillOrigin = 'workspace' | 'global' | 'claude' | 'codex' | 'opencode' | 'kilo';

/** Human label for an origin, e.g. `global · claude` for a Claude Code skill. */
export function formatSkillOrigin(origin: SkillOrigin): string {
  switch (origin) {
    case 'workspace':
      return 'workspace';
    case 'global':
      return 'global';
    default:
      return `global · ${origin}`;
  }
}
