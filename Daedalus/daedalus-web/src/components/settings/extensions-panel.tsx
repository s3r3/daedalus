import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { formatSkillOrigin, type SkillOrigin } from '@daedalus/core/skills/origin'
import { api } from '../../api/client'
import type { ExtensionStatus } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { EmptyState, Panel } from '../common/panel'

/**
 * Real MCP / Skills / LSP status for the selected workspace. The gateway
 * reads the same `<workspace>/.daedalus` configuration the CLI and task runs
 * use; MCP entries are the result of an actual short-lived connection
 * attempt, so an offline server is shown as offline instead of guessed.
 */
export function ExtensionsPanel() {
  const root = useDaedalusStore((state) => state.workspace.root)
  const sessionRoot = useDaedalusStore((state) => state.session?.workspaceRoot)
  const effectiveRoot = root || sessionRoot || ''
  const [status, setStatus] = useState<ExtensionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [skillToggleError, setSkillToggleError] = useState<string | null>(null)
  const [skillToggling, setSkillToggling] = useState<string | null>(null)
  const [skillQuery, setSkillQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!effectiveRoot) {
      setStatus(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.extensionsStatus(effectiveRoot))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [effectiveRoot])

  // Per-workspace disable, persisted via the gateway into the same
  // .daedalus/skills.json the CLI and task runs read. Optimistic flip
  // first; on failure the previous state is restored and the error is
  // shown inline (never a silent no-op).
  const toggleSkill = useCallback(
    async (name: string, disabled: boolean): Promise<void> => {
      setSkillToggleError(null)
      setSkillToggling(name)
      setStatus((current) =>
        current
          ? { ...current, skills: current.skills.map((skill) => (skill.name === name ? { ...skill, disabled } : skill)) }
          : current,
      )
      try {
        await api.toggleSkill({ root: effectiveRoot, name, disabled })
        await load()
      } catch (caught) {
        setSkillToggleError(caught instanceof Error ? caught.message : String(caught))
        await load().catch(() => undefined)
      } finally {
        setSkillToggling(null)
      }
    },
    [effectiveRoot, load],
  )

  useEffect(() => {
    void load()
  }, [load])

  const visibleSkills = status ? filterSkills(status.skills, skillQuery) : []
  const skillGroupsVisible = skillGroups(visibleSkills)

  return (
    <Panel
      title="extensions"
      data-testid="extensions-panel"
      action={
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || !effectiveRoot} aria-label="refresh extensions">
          <RefreshCw /> refresh
        </Button>
      }
      bodyClassName="flex flex-col gap-2"
    >
      {!effectiveRoot ? <EmptyState title="No workspace selected" hint="Choose the shared workspace to inspect its MCP servers, skills, and language servers." /> : null}
      {effectiveRoot && loading && !status ? <p className="text-[11px] text-muted">checking extensions…</p> : null}
      {error ? (
        <p role="alert" className="text-[11px] text-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <div className="flex flex-col gap-2 text-[11px]">
          <section data-testid="extensions-mcp">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">MCP servers</p>
            {status.mcp.length === 0 ? (
              <p className="text-muted">none configured (.daedalus/mcp.json)</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {status.mcp.map((server) => (
                  <li key={server.name} className="flex items-center gap-1.5" data-testid="extension-mcp-entry">
                    <Badge tone={server.connected ? 'success' : 'error'}>{server.connected ? 'connected' : 'offline'}</Badge>
                    <span className="text-foreground">{server.name}</span>
                    <span className="text-muted">{server.toolCount} tools{server.error ? ` · ${server.error}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="extensions-skills">
            <p className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>Skills</span>
              {status.skills.length > 0 ? (
                <span className="normal-case tracking-normal" data-testid="extension-skills-count">
                  {skillQuery.trim()
                    ? `${visibleSkills.length} of ${status.skills.length}`
                    : `${status.skills.length} found`}
                </span>
              ) : null}
            </p>
            {skillToggleError ? (
              <p role="alert" className="mb-1 text-[10px] text-error" data-testid="extension-skills-error">
                Could not update skill state: {skillToggleError}
              </p>
            ) : null}
            {status.skills.length === 0 ? (
              <p className="text-muted">none found (.daedalus/skills, ~/.daedalus/skills, ~/.claude/skills, …)</p>
            ) : (
              <>
                <div className="relative mb-1.5">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <Input
                    type="search"
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                    placeholder="Search skills by name or description…"
                    aria-label="Search skills"
                    data-testid="extension-skills-search"
                    className="h-7 pl-7 text-[11px]"
                  />
                </div>
                {visibleSkills.length === 0 ? (
                  <p className="text-muted" data-testid="extension-skills-no-match">
                    no skills match “{skillQuery.trim()}”
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto pr-1" data-testid="extension-skills-scroll">
                    {skillGroupsVisible.map((group) => (
                <div key={group.origin} className="mb-2" data-testid="extension-skill-group" data-origin={group.origin}>
                  <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    <Badge tone="info">{formatSkillOrigin(group.origin as SkillOrigin)}</Badge>
                    <span>{group.origin}</span>
                  </p>
                  <ul className="flex flex-col gap-1">
                    {group.entries.map((skill) => (
                      <li key={`${skill.origin ?? 'workspace'}:${skill.name}`} data-testid="extension-skill-entry" className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="text-foreground">{skill.name}</span>
                          {skill.origin ? <span className="text-muted"> ({formatSkillOrigin(skill.origin as SkillOrigin)})</span> : null}
                          {skill.disabled ? (
                            <span className="text-warning" data-testid="extension-skill-disabled-note"> · disabled for this workspace</span>
                          ) : null}
                          {skill.description ? <span className="block truncate text-[10px] text-muted">{skill.description}</span> : null}
                          {skill.shadowedBy ? (
                            <span className="block text-[10px] text-muted" data-testid="extension-skill-shadowed">
                              shadowed by {formatSkillOrigin(skill.shadowedBy as SkillOrigin)} — not used; that copy wins
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!(skill.disabled ?? false)}
                          aria-label={`${skill.disabled ? 'Enable' : 'Disable'} skill ${skill.name} for this workspace`}
                          data-testid="extension-skill-toggle"
                          data-skill={skill.name}
                          disabled={skillToggling === skill.name}
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold disabled:opacity-60 ${
                            skill.disabled ? 'border-warning bg-warning/10 text-warning' : 'border-line bg-surface text-foreground hover:border-primary'
                          }`}
                          onClick={() => void toggleSkill(skill.name, !(skill.disabled ?? false))}
                        >
                          {skill.disabled ? 'disabled' : 'enabled'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {skillIndexOverflow(status.skills) > 0 ? (
              <p className="text-[10px] text-warning" data-testid="extension-skills-overflow">
                {skillIndexOverflow(status.skills)} more skill{skillIndexOverflow(status.skills) === 1 ? '' : 's'} not shown to the model —
                the prompt index caps at {SKILL_INDEX_CAP} enabled skills. Disable some above to free index slots; read_skill by name still
                reaches them.
              </p>
            ) : null}
          </section>

          <section data-testid="extensions-agents">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">Subagents</p>
            {!status.agents?.length ? (
              <p className="text-muted">none defined (.daedalus/agents)</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {status.agents.map((agent) => (
                  <li key={agent.name} data-testid="extension-agent-entry">
                    <span className="text-foreground">{agent.name}</span>
                    <span className="text-muted">{agent.mode ? ` · ${agent.mode}` : ''}{agent.model ? ` · ${agent.model}` : ''}{agent.tools ? ` · tools: ${agent.tools.join(', ')}` : ''}</span>
                    {agent.description ? <span className="block truncate text-[10px] text-muted">{agent.description}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="extensions-lsp">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">Language servers</p>
            {status.lsp.length === 0 ? (
              <p className="text-muted">none configured (.daedalus/lsp.json)</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {status.lsp.map((server) => (
                  <li key={server.name} className="flex items-center gap-1.5" data-testid="extension-lsp-entry">
                    <Badge tone="info">{server.auto ? 'auto' : 'configured'}</Badge>
                    <span className="text-foreground">{server.name}</span>
                    <span className="text-muted">{server.extensions.join(', ')}</span>
                    {server.auto ? <span className="text-muted">· starts on first use</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {status.problems.length > 0 ? (
            <p className="text-[10px] text-warning" data-testid="extensions-problems">
              {status.problems.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

/**
 * The prompt index caps at this many enabled skills (core
 * MAX_SKILLS_IN_PROMPT). Mirrored here so the overflow note names the
 * same number the prompt truncates at.
 */
const SKILL_INDEX_CAP = 40

/** Case-insensitive filter over name, description, and origin for the panel search box. */
function filterSkills(skills: ExtensionStatus['skills'], query: string): ExtensionStatus['skills'] {
  const needle = query.trim().toLowerCase()
  if (!needle) return skills
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      (skill.description ?? '').toLowerCase().includes(needle) ||
      (skill.origin ?? '').toLowerCase().includes(needle),
  )
}

/** Skill search order (workspace > daedalus global > the other tools' skill dirs); unknown origins last. */
const SKILL_ORIGIN_ORDER = ['workspace', 'global', 'claude', 'codex', 'opencode', 'kilo']

/** Group inventory entries by origin, in skill search order. */
function skillGroups(skills: ExtensionStatus['skills']): Array<{ origin: string; entries: ExtensionStatus['skills'] }> {
  const groups = new Map<string, ExtensionStatus['skills']>()
  for (const skill of skills) {
    const origin = skill.origin ?? 'unknown'
    groups.set(origin, [...(groups.get(origin) ?? []), skill])
  }
  return [...groups.entries()]
    .sort(
      ([a], [b]) =>
        (SKILL_ORIGIN_ORDER.indexOf(a) === -1 ? SKILL_ORIGIN_ORDER.length : SKILL_ORIGIN_ORDER.indexOf(a)) -
        (SKILL_ORIGIN_ORDER.indexOf(b) === -1 ? SKILL_ORIGIN_ORDER.length : SKILL_ORIGIN_ORDER.indexOf(b)),
    )
    .map(([origin, entries]) => ({ origin, entries }))
}

/** Enabled collision winners beyond the prompt-index cap (disabled and shadowed copies never reach the index). */
function skillIndexOverflow(skills: ExtensionStatus['skills']): number {
  const enabled = skills.filter((skill) => !skill.shadowedBy && !skill.disabled).length
  return Math.max(0, enabled - SKILL_INDEX_CAP)
}
