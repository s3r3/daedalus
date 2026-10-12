import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { chatTranscript } from './state/selectors'
import { ToolResultImage } from './components/agent/tool-result-image'
import { useDaedalusStore } from './state/taskStore'
import { api } from './api/client'

/**
 * Inline tool-result images (gap: the screenshot/view_image picture the
 * model looked at must be visible in the Web too, not just a text line).
 * The selector half proves the entry carries the image path from the
 * recorded result meta; the component half proves the picture is
 * fetched and rendered.
 */

vi.mock('./api/client', () => ({
  api: {
    file: vi.fn(async () => ({ path: 'x', size: 3, kind: 'image', mediaType: 'image/png', src: 'data:image/png;base64,AAA' })),
  },
}))

afterEach(() => cleanup())

const ev = (seq: number, type: string, payload: unknown): Event =>
  ({ seq, task_id: 'task-1', ts: new Date().toISOString(), type, payload }) as Event

describe('chatTranscript image entries', () => {
  test('a screenshot result with image meta becomes a renderable image entry', () => {
    const events = [
      ev(1, 'TOOL_CALL_STARTED', { call: { id: 'c1', task_id: 'task-1', tool: 'screenshot', args: { url: 'http://localhost:5173/' } } }),
      ev(2, 'TOOL_CALL_FINISHED', {
        call: { id: 'c1', task_id: 'task-1', tool: 'screenshot', args: { url: 'http://localhost:5173/' } },
        result: {
          call_id: 'c1',
          status: 'ok',
          output: 'screenshot of http://localhost:5173/ saved',
          truncated: false,
          meta: { image_attached: true, image_path: '.daedalus/screenshots/localhost-1.png', image_mime: 'image/png' },
        },
      }),
    ] as Event[]
    const entries = chatTranscript(events)
    const tool = entries.find((entry) => entry.role === 'tool')
    expect(tool?.image).toEqual({ path: '.daedalus/screenshots/localhost-1.png', mime: 'image/png' })
  })

  test('a plain tool result carries no image', () => {
    const events = [
      ev(1, 'TOOL_CALL_STARTED', { call: { id: 'c1', task_id: 'task-1', tool: 'read_file', args: { path: 'a.ts' } } }),
      ev(2, 'TOOL_CALL_FINISHED', {
        call: { id: 'c1', task_id: 'task-1', tool: 'read_file', args: { path: 'a.ts' } },
        result: { call_id: 'c1', status: 'ok', output: '1: hello', truncated: false, meta: {} },
      }),
    ] as Event[]
    const tool = chatTranscript(events).find((entry) => entry.role === 'tool')
    expect(tool?.image).toBeUndefined()
  })
})

describe('ToolResultImage', () => {
  test('fetches the workspace image and renders it', async () => {
    useDaedalusStore.setState({ workspace: { ...useDaedalusStore.getState().workspace, root: '/ws' } })
    render(<ToolResultImage path=".daedalus/screenshots/localhost-1.png" />)
    const img = await screen.findByTestId('tool-result-image')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA')
    expect(vi.mocked(api.file)).toHaveBeenCalledWith('/ws', '.daedalus/screenshots/localhost-1.png')
    await waitFor(() => expect(screen.getByText(/click to expand/)).toBeTruthy())
  })

  test('reports an unloadable image instead of breaking the row', async () => {
    vi.mocked(api.file).mockRejectedValueOnce(new Error('gone'))
    useDaedalusStore.setState({ workspace: { ...useDaedalusStore.getState().workspace, root: '/ws' } })
    render(<ToolResultImage path="missing.png" />)
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy()
  })
})
