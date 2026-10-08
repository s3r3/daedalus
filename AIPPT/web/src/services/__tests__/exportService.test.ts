import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Slide } from '../../types'
import {
  buildExportRequestBody,
  exportPresentation,
  getDefaultExportFilename,
  getExportMimeType
} from '../exportService'

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function buildSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: 'slide-1',
    pageNumber: 1,
    imageUrl: 'data:image/png;base64,aW1hZ2UtMQ==',
    imageBase64: 'image-1',
    prompt: 'Prompt one',
    ...overrides
  }
}

describe('exportService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('builds the generative editable PPTX request body with slide ids and order', () => {
    const slides = [
      buildSlide({
        id: 'slide-b',
        pageNumber: 2,
        imageBase64: 'image-b',
        textMetadata: [{ text: 'Second', role: 'title', order: 1, style_hint: { font_size: 30 } }]
      }),
      buildSlide({
        id: 'slide-a',
        pageNumber: 1,
        imageBase64: undefined,
        imageUrl: 'data:image/png;base64,aW1hZ2UtYQ==',
        textMetadata: [{ text: 'First', role: 'body', order: 2 }]
      })
    ]

    expect(buildExportRequestBody({
      slides,
      format: 'generative_editable_pptx',
      aspectRatio: '4:3'
    })).toEqual({
      slides: [
        {
          image_base64: 'image-b',
          slide_id: 'slide-b',
          text_metadata: [
            { text: 'Second', role: 'title', order: 1, style_hint: { font_size: 30 } }
          ]
        },
        {
          image_base64: 'aW1hZ2UtYQ==',
          slide_id: 'slide-a',
          text_metadata: [{ text: 'First', role: 'body', order: 2, style_hint: {} }]
        }
      ],
      format: 'generative_editable_pptx',
      aspect_ratio: '4:3',
      slide_order: ['slide-b', 'slide-a'],
      editable_options: { fallback_policy: 'fail' }
    })
  })

  it('keeps raster PPTX requests on the existing compact contract', () => {
    expect(buildExportRequestBody({
      slides: [buildSlide()],
      format: 'pptx',
      aspectRatio: '16:9'
    })).toEqual({
      slides: [{ image_base64: 'image-1' }],
      format: 'pptx',
      aspect_ratio: '16:9'
    })
  })

  it('allows callers to select a generative editable fallback policy', () => {
    expect(buildExportRequestBody({
      slides: [buildSlide()],
      format: 'generative_editable_pptx',
      aspectRatio: '16:9',
      fallbackPolicy: 'text_editable_background'
    }).editable_options).toEqual({ fallback_policy: 'text_editable_background' })
  })

  it('uses PPTX filename and MIME handling for generative editable downloads', () => {
    expect(getDefaultExportFilename('generative_editable_pptx', new Date('2026-06-30T00:00:00Z')))
      .toBe('presentation_20260630.generative-editable.pptx')
    expect(getExportMimeType('generative_editable_pptx'))
      .toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('downloads backend filename for generative editable PPTX responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({
        'Content-Disposition': 'attachment; filename="deck.generative-editable.pptx"'
      }),
      blob: async () => new Blob(['pptx'], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      })
    } as Response)
    URL.createObjectURL = vi.fn(() => 'blob:deck')
    URL.revokeObjectURL = vi.fn()
    const click = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName) as HTMLElement
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { value: click })
      }
      return element
    })

    const onComplete = vi.fn()
    await exportPresentation({
      slides: [buildSlide({ textMetadata: [{ text: 'Title', role: 'title', order: 1 }] })],
      format: 'generative_editable_pptx',
      aspectRatio: '16:9'
    }, { onComplete })

    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.format).toBe('generative_editable_pptx')
    expect(request.editable_options).toEqual({ fallback_policy: 'fail' })
    expect(onComplete).toHaveBeenCalledWith('deck.generative-editable.pptx')
    expect(click).toHaveBeenCalled()
  })

  it('posts selected fallback policy through exportPresentation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: async () => new Blob(['pptx'])
    } as Response)
    URL.createObjectURL = vi.fn(() => 'blob:deck')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName) as HTMLElement
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { value: vi.fn() })
      }
      return element
    })

    await exportPresentation({
      slides: [buildSlide()],
      format: 'generative_editable_pptx',
      aspectRatio: '16:9',
      fallbackPolicy: 'text_editable_background'
    })

    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.editable_options).toEqual({ fallback_policy: 'text_editable_background' })
  })

  it('does not emit claimed percentage progress for generative editable exports', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: async () => new Blob(['pptx'])
    } as Response)
    URL.createObjectURL = vi.fn(() => 'blob:deck')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName) as HTMLElement
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { value: vi.fn() })
      }
      return element
    })
    const onProgress = vi.fn()

    await exportPresentation({
      slides: [buildSlide()],
      format: 'generative_editable_pptx',
      aspectRatio: '16:9'
    }, { onProgress })

    expect(onProgress).not.toHaveBeenCalled()
  })
})
