import { useEffect } from 'react'
import { useDaedalusStore } from '../../state/taskStore'
import { SettingsPanel } from './settings-panel'

/**
 * The settings surface the top-bar button opens: a modal over the workbench,
 * so provider/session changes are made in place instead of hunting for a
 * panel in a column. Everything inside is the real SettingsPanel — the same
 * controls, wired to the gateway; this wrapper owns only open/close.
 */
export function SettingsDialog() {
  const setSettingsOpen = useDaedalusStore((state) => state.setSettingsOpen)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setSettingsOpen])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-surface-base/70 p-3 sm:items-center sm:p-6"
      data-testid="settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="settings"
    >
      <div className="absolute inset-0" aria-hidden="true" onClick={() => setSettingsOpen(false)} data-testid="settings-backdrop" />
      <div className="relative max-h-[90vh] w-[min(760px,94vw)] overflow-y-auto">
        <SettingsPanel onClose={() => setSettingsOpen(false)} />
      </div>
    </div>
  )
}
