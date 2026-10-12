import { Telescope } from 'lucide-react'
import { useDaedalusStore } from '../../state/taskStore'
import { useResearch } from '../research/useResearch'
import { cn } from '../../lib/utils'

/**
 * Research composer controls: domain Research mengganti mode picker
 * dengan satu alur — tulis pertanyaan riset, "Buat rencana riset"
 * men-stage rencana di panel kiri untuk review, dan "Jalankan riset"
 * di panel kiri adalah satu-satunya confirmation gate. Ask/Manual/
 * Auto/Plan tidak ada di domain ini.
 */
export function ResearchComposerControls() {
  const goal = useDaedalusStore((state) => state.composer.goal)
  const plan = useDaedalusStore((state) => state.researchPlan)
  const { planResearch, planning, planError } = useResearch()

  const createPlan = (): void => {
    void planResearch(goal)
  }

  return (
    <>
      <span
        className="inline-flex items-center rounded border border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
        data-testid="research-mode-badge"
      >
        <Telescope className="mr-1 size-3" aria-hidden />
        Research
      </span>
      <button
        type="button"
        data-testid="research-plan-create"
        onClick={createPlan}
        disabled={goal.trim().length === 0 || planning}
        title="Susun rencana riset dari pertanyaan — di-review di panel kiri sebelum dijalankan"
        className={cn(
          'rounded border border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/20 disabled:opacity-50',
        )}
      >
        {planning ? 'Menyusun rencana…' : 'Buat rencana riset'}
      </button>
      {plan ? (
        <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px]" data-testid="research-plan-chip">
          Rencana: <span className="font-medium">{plan.subQuestions.length} sub-pertanyaan</span>
        </span>
      ) : null}
      {planError ? (
        <span className="text-[10px] text-red-300" data-testid="research-plan-error">Gagal menyusun rencana: {planError}</span>
      ) : null}
      <span className="text-[10px] text-muted">
        Tulis pertanyaan riset di bawah, lalu Buat rencana — rencana di-review di panel kiri, dijalankan dengan
        "Jalankan riset". Enter juga membuat rencana.
      </span>
    </>
  )
}
