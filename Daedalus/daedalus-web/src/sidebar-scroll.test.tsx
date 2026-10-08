import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { App } from './App'
import { useDaedalusStore } from './state/taskStore'

// Layout contract for the app shell (Farid's sidebar-clip report): in the
// wide three-column layout every sidebar region must be height-bounded and
// scroll internally. The workspace panel and the scroll stack below it are
// both flexible children of the left column — a panel left at its natural
// (content) height shrinks the stack's Radix viewport to zero and makes the
// skills list unreachable, exactly the reported bug. These assertions pin
// the class structure that prevents it; the live geometry is verified with
// Puppeteer (sidebar before/after screenshots).

vi.mock('./api/useEventStream', () => ({ useEventStream: () => undefined }))

vi.mock('./components/editor/monaco-editor', () => ({
  MonacoEditor: () => <div data-testid="monaco-stub" />,
}))

vi.mock('./api/client', () => ({
  api: {
    settings: async () => ({
      session: { mode: 'auto', autoApprove: true, thinking: true, workspaceRoot: '/workspace' },
      providers: [],
    }),
    providers: async () => ({ providers: [], presets: [] }),
    models: async () => ({ models: [] }),
    roots: async () => ({ roots: [{ path: '/workspace', name: 'workspace' }], cwd: '/workspace' }),
    tree: async () => ({ path: '.', name: '.', isDirectory: true, children: [{ path: 'README.md', name: 'README.md', isDirectory: false }] }),
    list: async () => ({ items: [] }),
    pins: async () => ({ pins: [] }),
    extensionsStatus: async () => ({
      root: '/workspace',
      mcp: [],
      skills: [{ name: 'greeter', description: 'Greets users warmly', origin: 'workspace' }],
      lsp: [],
      problems: [],
    }),
    listConversations: async () => ({ conversations: [] }),
    getConversation: async () => ({ conversation: null }),
    listTasks: async () => ({ tasks: [] }),
    task: async () => ({ events: [], report: null, running: false }),
    terminals: async () => ({ terminals: [] }),
    files: async () => ({}),
    taskEvents: async () => ({}),
    taskAttachments: async () => ({ attachments: [] }),
    updateSession: async () => ({ session: { mode: 'auto', autoApprove: true, thinking: true, workspaceRoot: '/workspace' } }),
  },
}))

function classes(el: Element | null | undefined): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

describe('app shell sidebar scrolling', () => {
  beforeEach(() => {
    useDaedalusStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
  })

  test('left column: workspace panel takes a flexible share so the stack below it keeps real height', () => {
    const { container } = render(<App />)
    const shell = container.querySelector('[data-testid="app-shell"]')
    expect(classes(shell)).toEqual(expect.arrayContaining(['flex', 'h-full', 'flex-col']))

    const main = container.querySelector('main')
    expect(classes(main)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'lg:overflow-hidden']))

    const [left] = container.querySelectorAll('main > aside')
    expect(left).toBeTruthy()
    expect(classes(left)).toEqual(expect.arrayContaining(['flex', 'min-h-0', 'flex-col', 'lg:overflow-hidden']))

    // First child: the workspace panel itself must be shrinkable and share
    // the column (regression: at natural height it pushed the scroller to 0).
    const workspacePanel = left.querySelector(':scope > [data-testid="workspace-panel"]')
    expect(workspacePanel).toBeTruthy()
    expect(classes(workspacePanel)).toEqual(expect.arrayContaining(['min-h-0', 'lg:flex-1']))
    const workspaceBody = workspacePanel?.querySelector('[data-slot="card-body"]')
    expect(classes(workspaceBody)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']))

    // Second child: the workspace resize divider; third: the Radix scroll
    // area holding extensions/plan/activity.
    const handle = left.querySelector(':scope > [data-testid="workspace-resize-handle"]')
    expect(handle).toBe(left.children[1])
    expect(handle?.getAttribute('role')).toBe('separator')
    const scroller = left.children[2]
    expect(scroller?.querySelector('[data-radix-scroll-area-viewport]')).toBeTruthy()
    expect(classes(scroller)).toEqual(expect.arrayContaining(['lg:min-h-0', 'lg:flex-1']))
  })

  test('dragging the workspace divider pins and persists the panel height', async () => {
    const { container } = render(<App />)
    const left = container.querySelector<HTMLElement>('aside')
    const handle = left?.querySelector<HTMLElement>('[data-testid="workspace-resize-handle"]')
    expect(handle).toBeTruthy()
    // jsdom measures 0 for the unset panel, so the drag seeds from the
    // 260px fallback and grows by the pointer delta. Raw MouseEvents:
    // fireEvent's pointer events drop clientY in jsdom.
    fireEvent(handle!, new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 170 }))
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(window.localStorage.getItem('daedalus.web.workspace-panel-height.v1')).toBe('330')
    await waitFor(() => {
      const panel = left?.querySelector<HTMLElement>('[data-testid="workspace-panel"]')
      expect(panel?.style.height).toBe('330px')
      expect(classes(panel)).toEqual(expect.arrayContaining(['shrink-0']))
    })
    // Double-click releases the pin back to the even split.
    fireEvent.doubleClick(handle!)
    expect(window.localStorage.getItem('daedalus.web.workspace-panel-height.v1')).toBeNull()
  })

  test('right column: chat panel stays bounded and the report rail keeps its own scroll region', () => {
    // A started task gives the chat panel a transcript row, so the bounded
    // [data-testid=chat-scroll] region (PR #17) exists to assert on.
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [
        {
          seq: 1,
          task_id: 'task-1',
          ts: new Date().toISOString(),
          type: 'TASK_STARTED',
          payload: { spec: { id: 'task-1', goal: 'add a health endpoint', repo_path: '/workspace', constraints: [], done_criteria: [] } },
        } as never,
      ],
    })
    const { container } = render(<App />)
    const [, right] = container.querySelectorAll('main > aside')
    expect(right).toBeTruthy()

    const chatPanel = right.querySelector(':scope > [data-testid="chat-panel"]')
    expect(chatPanel).toBeTruthy()
    expect(classes(chatPanel)).toContain('shrink-0')

    const scroller = right.children[1]
    expect(scroller).toBeTruthy()
    expect(classes(scroller)).toEqual(expect.arrayContaining(['lg:min-h-0', 'lg:flex-1']))

    // PR #17 regression: approval/question cards live inside this scroller.
    const chatScroll = right.querySelector('[data-testid="chat-scroll"]')
    expect(chatScroll).toBeTruthy()
    expect(classes(chatScroll)).toContain('overflow-y-auto')
  })

  test('center column can shrink beside the resizable side columns', () => {
    const { container } = render(<App />)
    const section = container.querySelector('main > section')
    expect(section).toBeTruthy()
    expect(classes(section)).toEqual(expect.arrayContaining(['min-w-0', 'flex', 'flex-col']))
  })
})
