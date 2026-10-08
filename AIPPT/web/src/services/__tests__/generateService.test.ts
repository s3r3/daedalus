import { describe, expect, it } from 'vitest'
import { convertToSlide } from '../generateService'

describe('generateService', () => {
  it('preserves text metadata from generated slide SSE payloads', () => {
    expect(convertToSlide({
      id: 'slide-1',
      page_number: 1,
      image_base64: 'aW1hZ2U=',
      prompt: 'Prompt',
      text_metadata: [
        { text: 'Quarterly Plan', role: 'title', order: 1, style_hint: { font_size: 30 } },
        { text: 'Revenue up 18%', role: 'body', order: 2, style_hint: {} }
      ]
    })).toMatchObject({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'aW1hZ2U=',
      imageUrl: 'data:image/png;base64,aW1hZ2U=',
      prompt: 'Prompt',
      textMetadata: [
        { text: 'Quarterly Plan', role: 'title', order: 1, style_hint: { font_size: 30 } },
        { text: 'Revenue up 18%', role: 'body', order: 2, style_hint: {} }
      ]
    })
  })

  it('defaults missing text metadata to an empty list', () => {
    expect(convertToSlide({
      id: 'slide-1',
      page_number: 1,
      image_base64: 'aW1hZ2U=',
      prompt: 'Prompt'
    }).textMetadata).toEqual([])
  })
})
