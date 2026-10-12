import { useCallback, useEffect, useRef } from 'react'
import { ApiError, api, type ResearchPlanResult } from '../../api/client'
import { useDaedalusStore } from '../../state/taskStore'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Agentic Research plumbing: plan (staged for review in the left
 * panel), run ("Jalankan riset" — execute → verify → report), progress
 * polling, and re-read of a staged plan. The staged plan, planning /
 * running flags, progress events, and the last report live in the
 * shared store so the composer controls, the left plan panel, the
 * center report view, and the right panels all read the same state —
 * no parallel panel-local copies. The web only calls the server's
 * /research endpoints; it never runs the engine itself.
 */
export function useResearch() {
  const planning = useDaedalusStore((state) => state.researchPlanning)
  const planError = useDaedalusStore((state) => state.researchPlanError)
  const planId = useDaedalusStore((state) => state.researchPlanId)
  const plan = useDaedalusStore((state) => state.researchPlan)
  const running = useDaedalusStore((state) => state.researchRunning)
  const progress = useDaedalusStore((state) => state.researchProgress)
  const report = useDaedalusStore((state) => state.researchReport)
  const runError = useDaedalusStore((state) => state.researchRunError)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Kunci in-flight: cegah double-submit sebelum re-render menonaktifkan tombol. */
  const runRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** Stage a research plan for the question. On success the plan lands in the store for review. */
  const planResearch = useCallback(async (question: string): Promise<boolean> => {
    const store = useDaedalusStore.getState()
    if (!question.trim() || store.researchPlanning) return false
    store.setResearchPlanning(true)
    store.setResearchPlanError(null)
    try {
      const response: ResearchPlanResult = await api.researchPlan(question.trim())
      store.setResearchPlan(response.planId, response.plan)
      store.setResearchReport(null)
      store.setResearchRunError(null)
      store.setResearchProgress([])
      return true
    } catch (error: unknown) {
      store.setResearchPlanError(messageOf(error))
      return false
    } finally {
      useDaedalusStore.getState().setResearchPlanning(false)
    }
  }, [])

  /**
   * Run the staged plan (the "Jalankan riset" gate). Polls progress while
   * running. Double-submit aman: kunci ref + server menjawab 409
   * already_running bila run untuk plan ini sudah berjalan (bukan 410
   * "kedaluwarsa" yang menyesatkan). Bila request putus di tengah jalan
   * (timeout/proxy), client memulihkan via /research/run-status/:planId
   * lalu mengambil laporan yang sudah selesai.
   */
  const runResearch = useCallback(async (): Promise<boolean> => {
    const store = useDaedalusStore.getState()
    const stagedId = store.researchPlanId
    if (!stagedId || store.researchRunning || runRef.current) return false
    runRef.current = true
    store.setResearchRunning(true)
    store.setResearchRunError(null)
    store.setResearchProgress([])
    store.setResearchPreviewSourceId(null)
    const poll = async (): Promise<void> => {
      try {
        const res = await api.researchProgress(stagedId)
        useDaedalusStore.getState().setResearchProgress(res.events)
      } catch {
        /* progress is best-effort; the run result is authoritative */
      }
    }
    pollRef.current = setInterval(() => void poll(), 2000)
    /** Tunggu run yang sudah berjalan di server, lalu ambil laporannya. */
    const recoverRunning = async (): Promise<boolean> => {
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const st = await api.researchRunStatus(stagedId)
          await poll()
          if (st.status === 'done' && st.reportId) {
            const rep = await api.researchGetReport(st.reportId)
            const s = useDaedalusStore.getState()
            s.setResearchReport(rep.report)
            s.setResearchPlan(null, null)
            return true
          }
          if (st.status === 'idle') return false
        } catch {
          /* coba lagi */
        }
      }
      return false
    }
    try {
      const response = await api.researchRun(stagedId)
      store.setResearchReport(response.report)
      store.setResearchPlan(null, null)
      return true
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        // Run sudah berjalan (double-submit / tab lain): pulihkan, jangan error.
        store.setResearchRunError('Riset untuk rencana ini sudah berjalan — menunggu selesai…')
        const ok = await recoverRunning()
        if (ok) store.setResearchRunError(null)
        else store.setResearchRunError('Riset selesai/tidak ditemukan — buat ulang rencana bila perlu.')
        return ok
      }
      if (error instanceof ApiError && error.status === 410) {
        store.setResearchRunError('Rencana kedaluwarsa — buat ulang rencana riset.')
        store.setResearchPlan(null, null)
      } else if (error instanceof ApiError && error.status === 422) {
        const issues = (error.data as { issues?: Array<{ message?: string } | string> } | null)?.issues ?? []
        const first = issues.length > 0
          ? typeof issues[0] === 'string' ? issues[0] : (issues[0]?.message ?? 'verify gate menolak klaim')
          : 'verify gate menolak klaim'
        store.setResearchRunError(`Verify gate gagal — tanpa laporan: ${first}`)
      } else {
        // Kemungkinan request putus saat server masih jalan: coba pulihkan.
        store.setResearchRunError('Koneksi terputus saat riset berjalan — mencoba memulihkan…')
        const ok = await recoverRunning()
        if (ok) store.setResearchRunError(null)
        else store.setResearchRunError(`${messageOf(error)} — coba buat ulang rencana riset.`)
        return ok
      }
      return false
    } finally {
      stopPolling()
      runRef.current = false
      useDaedalusStore.getState().setResearchRunning(false)
      void poll()
    }
  }, [stopPolling])

  /** Re-read a staged plan (e.g. after a reload). */
  const getPlan = useCallback(async (stagedId: string): Promise<boolean> => {
    try {
      const response = await api.researchGetPlan(stagedId)
      useDaedalusStore.getState().setResearchPlan(response.planId, response.plan)
      return true
    } catch {
      return false
    }
  }, [])

  return { planning, planError, planId, plan, running, progress, report, runError, planResearch, runResearch, getPlan }
}
