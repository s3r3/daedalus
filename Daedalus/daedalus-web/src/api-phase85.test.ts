import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './api/client'

type FetchCall = [string, RequestInit | undefined]

let calls: FetchCall[]

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      if (url.endsWith('/providers/test-provider/test')) return jsonResponse({ ok: true, providerId: 'test-provider', models: ['m1'], message: 'Connection OK (1 models)' })
      if (url.endsWith('/models')) return jsonResponse({ models: [{ providerId: 'p1', model: 'm1', supportsVision: true }], session: {}, count: 1 })
      return jsonResponse({ ok: true, session: { mode: 'auto', autoApprove: false, workspaceRoot: '/workspace' }, providers: [], presets: [] })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Phase 8.5 API client', () => {
  test('settings, session, provider, and model methods use the gateway routes', async () => {
    await api.settings()
    await api.setMode('plan')
    await api.cycleMode()
    await api.setAutoApprove(true)
    await api.providers()
    await api.testProvider('test-provider')
    await api.models('p1')

    expect(calls.map(([url]) => url)).toEqual([
      '/settings',
      '/session/mode',
      '/session/mode',
      '/session/auto-approve',
      '/providers',
      '/providers/test-provider/test',
      '/models?provider_id=p1',
    ])
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ mode: 'plan' })
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ cycle: true })
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual({ enabled: true })
  })

  test('createTask sends Phase 8.5 session and attachment fields', async () => {
    await api.createTask({
      goal: 'build it',
      repo_path: '/workspace',
      mode: 'orchestrator',
      provider_id: 'nine-router',
      model: 'kr/auto',
      attachments: [],
    })

    const body = JSON.parse(String(calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ goal: 'build it', mode: 'orchestrator', provider_id: 'nine-router', model: 'kr/auto', attachments: [] })
  })

  test('FormData uploads let the browser set the multipart boundary', async () => {
    await api.upload(new FormData())
    const init = calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeInstanceOf(FormData)
    expect(init?.headers).not.toHaveProperty('content-type')
  })

  test('workspace mutation methods post to the confined workspace routes', async () => {
    await api.createWorkspace({ root: '/workspace', name: 'app' })
    await api.createFolder('/workspace', 'src/components')
    await api.createFile('/workspace', 'src/index.ts', 'export {}\n')
    await api.renameWorkspaceEntry('/workspace', 'src/index.ts', 'src/main.ts')
    await api.saveFile('/workspace', 'src/main.ts', 'export const x = 1\n')
    await api.taskAttachments('task-1')

    expect(calls.map(([url]) => url)).toEqual([
      '/workspace/create',
      '/workspace/folders',
      '/workspace/files',
      '/workspace/rename',
      '/workspace/file',
      '/tasks/task-1/attachments',
    ])
  })
})
