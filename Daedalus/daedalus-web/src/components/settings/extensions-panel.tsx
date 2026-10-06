import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatSkillOrigin, type SkillOrigin } from '@daedalus/core'
import { api } from '../../api/client'
import type { ExtensionStatus } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
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

  useEffect(() => {
    void load()
  }, [load])

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
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">Skills</p>
            {status.skills.length === 0 ? (
              <p className="text-muted">none found (.daedalus/skills, ~/.daedalus/skills, ~/.claude/skills, …)</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {status.skills.map((skill) => (
                  <li key={`${skill.origin ?? 'workspace'}:${skill.name}`} data-testid="extension-skill-entry">
                    <span className="text-foreground">{skill.name}</span>
                    {skill.origin ? <span className="text-muted"> ({formatSkillOrigin(skill.origin as SkillOrigin)})</span> : null}
                    {skill.description ? <span className="block truncate text-[10px] text-muted">{skill.description}</span> : null}
                  </li>
                ))}
              </ul>
            )}
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
                    <Badge tone="info">configured</Badge>
                    <span className="text-foreground">{server.name}</span>
                    <span className="text-muted">{server.extensions.join(', ')}</span>
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
