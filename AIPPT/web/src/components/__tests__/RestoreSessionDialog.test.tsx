import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RestoreSessionDialog } from '../RestoreSessionDialog'
import { UiPreferencesContext } from '../../contexts/UiPreferencesContextValue'
import { translate } from '../../i18n'
import type { RestoredProject } from '../../hooks/useStateRestore'

function buildRestoredProject(
  overrides: Partial<RestoredProject> & { missingAssetKeys?: string[] } = {}
): RestoredProject {
  const { missingAssetKeys = [], ...rest } = overrides

  return {
    projectId: 'restored-project',
    fileContent: '# Restored',
    fileName: 'restored.md',
    slides: [],
    generationConfig: {
      pageCount: 1,
      quality: '1K',
      aspectRatio: '16:9'
    },
    workflow: {
      status: 'idle',
      outline: null,
      slidePrompts: [],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    },
    status: 'draft',
    lastCompletedSlides: [],
    missingAssetKeys,
    ...rest
  }
}

describe('RestoreSessionDialog', () => {
  it('warns in Chinese when restored project images are missing', () => {
    render(
      <RestoreSessionDialog
        isOpen
        restoredProject={buildRestoredProject({ missingAssetKeys: ['image-1', 'image-2'] })}
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
      />
    )

    expect(screen.getByText('有 2 张图片未能完整恢复。文本和大纲仍可恢复，也可以稍后重新生成图片。')).toBeInTheDocument()
  })

  it('warns in English when restored project images are missing', () => {
    render(
      <UiPreferencesContext.Provider
        value={{
          language: 'en',
          theme: 'light',
          setLanguage: vi.fn(),
          setTheme: vi.fn(),
          t: (key, vars) => translate('en', key, vars)
        }}
      >
        <RestoreSessionDialog
          isOpen
          restoredProject={buildRestoredProject({ missingAssetKeys: ['image-1'] })}
          onRestore={vi.fn()}
          onDiscard={vi.fn()}
        />
      </UiPreferencesContext.Provider>
    )

    expect(screen.getByText('Some images (1) could not be fully restored. Text and outline can still be recovered, and images can be regenerated later.')).toBeInTheDocument()
  })
})
