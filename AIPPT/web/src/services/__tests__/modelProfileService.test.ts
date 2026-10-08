import { describe, expect, it } from 'vitest'
import { buildModelProfiles } from '../modelProfileService'

describe('modelProfileService', () => {
  it('does not expose internal adapters in model profile requests', () => {
    const profiles = buildModelProfiles({
      text: {
        model: 'text-model',
        baseUrl: 'https://text.example/v1',
        apiKey: 'text-key',
        format: 'openai',
        thinking: 'disabled'
      },
      image: {
        model: 'image-model',
        baseUrl: 'https://image.example/v1',
        apiKey: 'image-key'
      },
      edit: {
        model: 'edit-model',
        baseUrl: 'https://edit.example/v1',
        apiKey: 'edit-key'
      },
      vlm: {
        model: 'vlm-model',
        baseUrl: 'https://vlm.example/v1',
        apiKey: 'vlm-key'
      },
      ocr: {
        model: 'ocr-model',
        baseUrl: 'https://ocr.example/v1',
        apiKey: 'ocr-key'
      }
    })

    expect(profiles).toEqual({
      text_model: {
        model: 'text-model',
        base_url: 'https://text.example/v1',
        api_key: 'text-key',
        thinking: 'disabled'
      },
      image_model: {
        model: 'image-model',
        base_url: 'https://image.example/v1',
        api_key: 'image-key'
      },
      edit_model: {
        model: 'edit-model',
        base_url: 'https://edit.example/v1',
        api_key: 'edit-key'
      },
      VLM: {
        model: 'vlm-model',
        base_url: 'https://vlm.example/v1',
        api_key: 'vlm-key'
      },
      ocr_model: {
        model: 'ocr-model',
        base_url: 'https://ocr.example/v1',
        api_key: 'ocr-key'
      }
    })
  })
})
