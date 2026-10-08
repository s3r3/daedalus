import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Slide } from '../../types'
import RightPanel from '../RightPanel'

const slide: Slide = {
  id: 'slide-1',
  pageNumber: 1,
  imageUrl: 'data:image/png;base64,one',
  imageBase64: 'one',
  prompt: 'Prompt'
}

describe('RightPanel export state', () => {
  it('shows indeterminate loading for generative editable PPTX without percentage progress', () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })

    render(
      <RightPanel
        slides={[slide]}
        selectedSlideId="slide-1"
        onSlideSelect={vi.fn()}
        onExport={vi.fn()}
        isExporting
        exportProgress={70}
        exportFormat="generative_editable_pptx"
      />
    )

    expect(screen.getByText('正在导出高保真可编辑 PPTX')).toBeInTheDocument()
    expect(screen.queryByText('70%')).not.toBeInTheDocument()
  })
})
