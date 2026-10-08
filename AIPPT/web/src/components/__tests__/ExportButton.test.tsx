import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ExportButton from '../ExportButton'

describe('ExportButton', () => {
  it('shows raster PPTX and high-fidelity editable PPTX as distinct options', () => {
    const onExport = vi.fn()
    render(<ExportButton onExport={onExport} />)

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))

    expect(screen.getByText('PPTX 格式')).toBeInTheDocument()
    expect(screen.getByText('每页保存为整页图片')).toBeInTheDocument()
    expect(screen.getByText('高保真可编辑 PPTX')).toBeInTheDocument()
    expect(screen.getByText('重建文本、形状和图片元素')).toBeInTheDocument()

    fireEvent.click(screen.getByText('PPTX 格式'))
    expect(onExport).toHaveBeenLastCalledWith('pptx')

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByText('高保真可编辑 PPTX'))
    expect(onExport).toHaveBeenLastCalledWith('generative_editable_pptx')
  })
})
