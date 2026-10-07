import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditorPane } from './components/editor/editor-pane'

vi.mock('./components/editor/monaco-editor', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="mock-monaco" aria-label="mock monaco" value={value} readOnly />,
}))

afterEach(() => cleanup())

describe('image preview in the file viewer', () => {
  test('an image file renders an <img> preview — no editor, no Save', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    render(
      <EditorPane
        path="src/assets/hero.png"
        content=""
        loading={false}
        error={null}
        size={13057}
        root="/workspace"
        kind="image"
        imageSrc={src}
        mediaType="image/png"
      />,
    )
    expect(screen.getByTestId('image-preview')).toBeTruthy()
    const img = screen.getByTestId('image-preview-img') as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe(src)
    expect(img.alt).toBe('hero.png')
    expect(screen.getByText('13057 bytes')).toBeTruthy()
    expect(screen.queryByTestId('editor-save')).toBeNull()
    expect(screen.queryByTestId('mock-monaco')).toBeNull()
    expect(screen.queryByTestId('editor-fallback')).toBeNull()
  })

  test('dimensions appear once the image has loaded', () => {
    render(
      <EditorPane
        path="src/assets/hero.png"
        content=""
        loading={false}
        error={null}
        size={10}
        root="/workspace"
        kind="image"
        imageSrc="data:image/png;base64,AAAA"
        mediaType="image/png"
      />,
    )
    const img = screen.getByTestId('image-preview-img') as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 800 })
    Object.defineProperty(img, 'naturalHeight', { value: 600 })
    fireEvent.load(img)
    expect(screen.getByTestId('image-preview-dimensions').textContent).toBe('800 × 600')
  })

  test('a text file still opens in the editor with Save, not the preview', async () => {
    render(<EditorPane path="src/main.ts" content={'export const a = 1\n'} loading={false} error={null} size={18} root="/workspace" kind="text" />)
    expect(await screen.findByTestId('mock-monaco')).toBeTruthy()
    expect(screen.getByTestId('editor-save')).toBeTruthy()
    expect(screen.queryByTestId('image-preview')).toBeNull()
    expect(screen.queryByTestId('image-preview-img')).toBeNull()
  })
})
