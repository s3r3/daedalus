import type { AgentMode } from '@daedalus/core'
import { AGENT_MODE_ORDER } from '@daedalus/core/interaction/modes'

/**
 * Browser-side persistence for the composer's run defaults (PLAN.md §3.4: the
 * gateway session is shared with the CLI, but the Web UI also remembers its
 * own defaults). Providers and the session live on the server (providers are
 * saved to disk there); these prefs only seed the composer, and every value
 * here is written into the next task payload the composer submits, so a
 * persisted value is a value that actually takes effect.
 */
export type ComposerPrefs = {
  mode?: AgentMode
  autoApprove?: boolean
  thinking?: boolean
  providerId?: string
  model?: string
  maxIterations?: number
  modelPool?: string
  modelStrategy?: 'failover' | 'round-robin'
}

export const COMPOSER_PREFS_KEY = 'daedalus.web.composer-defaults.v1'

const MODES: ReadonlySet<string> = new Set(AGENT_MODE_ORDER)

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}

export function loadComposerPrefs(storage: Storage | undefined = defaultStorage()): ComposerPrefs {
  if (!storage) return {}
  try {
    const raw = storage.getItem(COMPOSER_PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const prefs: ComposerPrefs = {}
    if (typeof parsed.mode === 'string' && MODES.has(parsed.mode)) prefs.mode = parsed.mode as AgentMode
    if (typeof parsed.autoApprove === 'boolean') prefs.autoApprove = parsed.autoApprove
    if (typeof parsed.thinking === 'boolean') prefs.thinking = parsed.thinking
    if (typeof parsed.providerId === 'string') prefs.providerId = parsed.providerId
    if (typeof parsed.model === 'string') prefs.model = parsed.model
    if (typeof parsed.maxIterations === 'number' && Number.isFinite(parsed.maxIterations)) {
      prefs.maxIterations = Math.min(100, Math.max(1, Math.round(parsed.maxIterations)))
    }
    if (typeof parsed.modelPool === 'string') prefs.modelPool = parsed.modelPool
    if (parsed.modelStrategy === 'failover' || parsed.modelStrategy === 'round-robin') prefs.modelStrategy = parsed.modelStrategy
    return prefs
  } catch {
    return {}
  }
}

export function saveComposerPrefs(prefs: ComposerPrefs, storage: Storage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(COMPOSER_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage can be unavailable (private mode, quota); defaults just stay session-local */
  }
}

/** The persistable slice of a composer state — drafts and flags stay out. */
export function composerPrefsOf(composer: {
  mode: AgentMode
  autoApprove: boolean
  thinking: boolean
  providerId: string
  model: string
  maxIterations: number
  modelPool: string
  modelStrategy: 'failover' | 'round-robin'
}): ComposerPrefs {
  return {
    mode: composer.mode,
    autoApprove: composer.autoApprove,
    thinking: composer.thinking,
    providerId: composer.providerId,
    model: composer.model,
    maxIterations: composer.maxIterations,
    modelPool: composer.modelPool,
    modelStrategy: composer.modelStrategy,
  }
}
