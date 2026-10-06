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

/**
 * Panel layout the user arranged by hand: the Chat panel's height and, when
 * the wide three-column layout is on screen, the two side column widths.
 * The user drags these once and expects them back on the next visit, so
 * they persist alongside the composer defaults — clamped to ranges that can
 * never collapse a panel out of reach.
 */
export const CHAT_HEIGHT_KEY = 'daedalus.web.chat-height.v1'
export const TERMINAL_HEIGHT_KEY = 'daedalus.web.terminal-height.v1'
export const COLUMN_WIDTHS_KEY = 'daedalus.web.column-widths.v1'

export const CHAT_HEIGHT = { min: 140, max: 720, default: 320 } as const
export const TERMINAL_HEIGHT = { min: 120, max: 560, default: 180 } as const
export const COLUMN_WIDTHS = {
  left: { min: 240, max: 480, default: 320 },
  right: { min: 280, max: 560, default: 360 },
} as const

export type ColumnWidths = { left: number; right: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function loadChatHeight(storage: Storage | undefined = defaultStorage()): number {
  if (!storage) return CHAT_HEIGHT.default
  try {
    const parsed = Number(storage.getItem(CHAT_HEIGHT_KEY))
    return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, CHAT_HEIGHT.min, CHAT_HEIGHT.max) : CHAT_HEIGHT.default
  } catch {
    return CHAT_HEIGHT.default
  }
}

export function saveChatHeight(height: number, storage: Storage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(CHAT_HEIGHT_KEY, String(clamp(height, CHAT_HEIGHT.min, CHAT_HEIGHT.max)))
  } catch {
    /* unavailable storage just keeps the height session-local */
  }
}

export function loadTerminalHeight(storage: Storage | undefined = defaultStorage()): number {
  if (!storage) return TERMINAL_HEIGHT.default
  try {
    const parsed = Number(storage.getItem(TERMINAL_HEIGHT_KEY))
    return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, TERMINAL_HEIGHT.min, TERMINAL_HEIGHT.max) : TERMINAL_HEIGHT.default
  } catch {
    return TERMINAL_HEIGHT.default
  }
}

export function saveTerminalHeight(height: number, storage: Storage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(TERMINAL_HEIGHT_KEY, String(clamp(height, TERMINAL_HEIGHT.min, TERMINAL_HEIGHT.max)))
  } catch {
    /* unavailable storage just keeps the height session-local */
  }
}

export function loadColumnWidths(storage: Storage | undefined = defaultStorage()): ColumnWidths {
  const fallback: ColumnWidths = { left: COLUMN_WIDTHS.left.default, right: COLUMN_WIDTHS.right.default }
  if (!storage) return fallback
  try {
    const raw = storage.getItem(COLUMN_WIDTHS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { left?: unknown; right?: unknown }
    return {
      left: typeof parsed.left === 'number' && Number.isFinite(parsed.left) ? clamp(parsed.left, COLUMN_WIDTHS.left.min, COLUMN_WIDTHS.left.max) : fallback.left,
      right: typeof parsed.right === 'number' && Number.isFinite(parsed.right) ? clamp(parsed.right, COLUMN_WIDTHS.right.min, COLUMN_WIDTHS.right.max) : fallback.right,
    }
  } catch {
    return fallback
  }
}

export function saveColumnWidths(widths: ColumnWidths, storage: Storage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(
      COLUMN_WIDTHS_KEY,
      JSON.stringify({
        left: clamp(widths.left, COLUMN_WIDTHS.left.min, COLUMN_WIDTHS.left.max),
        right: clamp(widths.right, COLUMN_WIDTHS.right.min, COLUMN_WIDTHS.right.max),
      }),
    )
  } catch {
    /* unavailable storage just keeps the widths session-local */
  }
}
