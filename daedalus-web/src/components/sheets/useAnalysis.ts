import { useCallback } from 'react'
import { ApiError, api, type AnalysisDataset, type AnalysisPlanResult } from '../../api/client'
import { useDaedalusStore, type AnalysisRunError } from '../../state/taskStore'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Structured issues from a 422 verify_failed body; [] when the body carries none. */
function verifyFailedIssues(data: unknown): Array<{ message: string; [key: string]: unknown }> {
  if (data && typeof data === 'object' && Array.isArray((data as { issues?: unknown }).issues)) {
    return (data as { issues: Array<{ message: string; [key: string]: unknown }> }).issues
  }
  return []
}

/**
 * Mode Analis plumbing: plan (staged for review in the Blueprint
 * panel), run (compute → verify → insight report), and re-read of a
 * staged plan. The staged dataset, plan, planning/running flags, and
 * the last run's outcome live in the shared store so the composer
 * controls (dataset + "Buat rencana"), the Blueprint panel (plan
 * review + "Jalankan analisis"), and the Laporan panel (insight +
 * verify verdict) all read the same state — no parallel panel-local
 * copies. The web only calls the server's /sheets/analyze endpoints;
 * it never runs the engine itself.
 */
export function useAnalysis() {
  const dataset = useDaedalusStore((state) => state.analysisDataset)
  const planning = useDaedalusStore((state) => state.analysisPlanning)
  const planError = useDaedalusStore((state) => state.analysisPlanError)
  const plan = useDaedalusStore((state) => state.analysisPlan)
  const running = useDaedalusStore((state) => state.analysisRunning)
  const result = useDaedalusStore((state) => state.analysisResult)
  const runError = useDaedalusStore((state) => state.analysisRunError)

  /**
   * Stage an analysis plan for the question + dataset. On success the
   * plan lands in the store for review in the Blueprint panel and any
   * previous run outcome is cleared.
   */
  const planAnalysis = useCallback(async (question: string, stagedDataset: AnalysisDataset | null): Promise<boolean> => {
    const store = useDaedalusStore.getState()
    if (!question.trim() || !stagedDataset || store.analysisPlanning) return false
    store.setAnalysisPlanning(true)
    store.setAnalysisPlanError(null)
    try {
      const response: AnalysisPlanResult = await api.sheetsAnalyzePlan(question.trim(), stagedDataset)
      store.setAnalysisPlan({
        planId: response.planId,
        plan: response.plan,
        profiles: response.profiles,
        complexity: response.complexity ?? null,
      })
      store.setAnalysisResult(null)
      store.setAnalysisRunError(null)
      return true
    } catch (error: unknown) {
      store.setAnalysisPlanError(messageOf(error))
      return false
    } finally {
      store.setAnalysisPlanning(false)
    }
  }, [])

  /**
   * Run a staged plan. 422 verify_failed lists the issues and shows no
   * report; 410 plan_expired asks for a fresh plan; other failures
   * surface as a plain error.
   */
  const runAnalysis = useCallback(async (planId: string): Promise<boolean> => {
    const store = useDaedalusStore.getState()
    if (!planId || store.analysisRunning) return false
    store.setAnalysisRunning(true)
    store.setAnalysisRunError(null)
    try {
      const response = await api.sheetsAnalyzeRun(planId)
      store.setAnalysisResult(response)
      store.setAnalysisRunError(null)
      return true
    } catch (error: unknown) {
      let runErr: AnalysisRunError
      if (error instanceof ApiError && error.status === 422) {
        runErr = { code: 'verify_failed', message: messageOf(error), issues: verifyFailedIssues(error.data) }
      } else if (error instanceof ApiError && error.status === 410) {
        runErr = { code: 'plan_expired', message: messageOf(error) }
      } else {
        runErr = { code: 'error', message: messageOf(error) }
      }
      store.setAnalysisResult(null)
      store.setAnalysisRunError(runErr)
      return false
    } finally {
      store.setAnalysisRunning(false)
    }
  }, [])

  /** Re-read a staged plan by id (e.g. after a reload). False on 404. */
  const getPlan = useCallback(async (planId: string): Promise<boolean> => {
    const store = useDaedalusStore.getState()
    if (!planId) return false
    try {
      const response = await api.sheetsAnalyzeGetPlan(planId)
      store.setAnalysisPlan({ planId, plan: response.plan, profiles: response.profiles, complexity: null })
      return true
    } catch {
      return false
    }
  }, [])

  return { dataset, planning, planError, plan, running, result, runError, planAnalysis, runAnalysis, getPlan }
}
