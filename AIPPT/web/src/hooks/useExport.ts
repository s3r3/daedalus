import { useState, useCallback } from 'react'
import { Slide, ExportFormat, GenerationConfig } from '../types'
import { exportPresentation, canExport } from '../services/exportService'

/**
 * 导出状态
 */
export interface ExportState {
  isExporting: boolean
  progress: number
  error: string | null
  format: ExportFormat | null
}

/**
 * 导出 Hook 返回值
 */
export interface UseExportReturn {
  state: ExportState
  canExport: boolean
  startExport: (format: ExportFormat) => Promise<void>
  clearError: () => void
}

/**
 * 导出功能 Hook
 * 
 * @param slides 幻灯片列表
 * @returns 导出状态和方法
 */
export function useExport(
  slides: Slide[],
  aspectRatio: GenerationConfig['aspectRatio']
): UseExportReturn {
  const [state, setState] = useState<ExportState>({
    isExporting: false,
    progress: 0,
    error: null,
    format: null
  })

  const canExportSlides = canExport(slides)

  const startExport = useCallback(async (format: ExportFormat) => {
    if (!canExportSlides) {
      setState(prev => ({
        ...prev,
        error: '没有可导出的幻灯片'
      }))
      return
    }

    setState({
      isExporting: true,
      progress: 0,
      error: null,
      format
    })

    try {
      await exportPresentation(
        { slides, format, aspectRatio },
        {
          onStart: () => {
            setState(prev => ({
              ...prev,
              progress: format === 'generative_editable_pptx' ? 0 : 5
            }))
          },
          onProgress: (progress) => {
            if (format !== 'generative_editable_pptx') {
              setState(prev => ({ ...prev, progress }))
            }
          },
          onComplete: () => {
            setState({
              isExporting: false,
              progress: 100,
              error: null,
              format: null
            })
          },
          onError: (error) => {
            setState({
              isExporting: false,
              progress: 0,
              error,
              format: null
            })
          }
        }
      )
    } catch {
      // Error already handled by callback
    }
  }, [slides, canExportSlides, aspectRatio])

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }))
  }, [])

  return {
    state,
    canExport: canExportSlides,
    startExport,
    clearError
  }
}
