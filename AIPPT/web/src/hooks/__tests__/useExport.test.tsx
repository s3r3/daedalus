import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Slide } from '../../types'
import { exportPresentation } from '../../services/exportService'
import { useExport } from '../useExport'

vi.mock('../../services/exportService', async () => {
  const actual = await vi.importActual<typeof import('../../services/exportService')>(
    '../../services/exportService'
  )
  return {
    ...actual,
    exportPresentation: vi.fn()
  }
})

const slide: Slide = {
  id: 'slide-1',
  pageNumber: 1,
  imageUrl: 'data:image/png;base64,one',
  imageBase64: 'one',
  prompt: 'Prompt'
}

describe('useExport', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('surfaces generative editable export errors through the real hook error state', async () => {
    vi.mocked(exportPresentation).mockImplementation(async (_config, callbacks) => {
      callbacks?.onStart?.()
      callbacks?.onError?.('provider timed out')
    })

    const { result } = renderHook(() => useExport([slide], '16:9'))

    await act(async () => {
      await result.current.startExport('generative_editable_pptx')
    })

    expect(result.current.state).toEqual({
      isExporting: false,
      progress: 0,
      error: 'provider timed out',
      format: null
    })
  })
})
