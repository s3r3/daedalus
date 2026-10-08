import { Code2, Presentation } from 'lucide-react'
import { useDaedalusStore, type WebDomain } from '../../state/taskStore'
import { saveDomain } from '../../state/prefs'
import { cn } from '../../lib/utils'

/**
 * Domain switcher (Agentic Coding | Agentic Slide). Domains are what the
 * harness produces, not how autonomously it works: switching re-skins the
 * center canvas around the same workspace, chat, and core. The choice
 * persists as a browser pref (App also mirrors store changes back).
 */
const OPTIONS: Array<{ domain: WebDomain; label: string; Icon: typeof Code2 }> = [
  { domain: 'coding', label: 'Coding', Icon: Code2 },
  { domain: 'slide', label: 'Slide', Icon: Presentation },
]

export function DomainSwitch() {
  const domain = useDaedalusStore((state) => state.domain)
  const setDomain = useDaedalusStore((state) => state.setDomain)

  const choose = (next: WebDomain): void => {
    setDomain(next)
    saveDomain(next)
  }

  return (
    <div
      data-testid="domain-switch"
      role="group"
      aria-label="product domain"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5"
    >
      {OPTIONS.map(({ domain: value, label, Icon }) => {
        const active = domain === value
        return (
          <button
            key={value}
            type="button"
            data-testid={`domain-${value}`}
            aria-pressed={active}
            onClick={() => choose(value)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold transition-colors',
              active ? 'bg-primary text-on-primary' : 'text-muted hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}
