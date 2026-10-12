/**
 * Scripted gateway for the browser end-to-end test.
 *
 * PLAN.md Phase 8 requires "one browser end-to-end test (headless) against a
 * scripted backend emitting a fixed event sequence". This is that backend: it
 * speaks the same REST + WebSocket contract as `server/` (see
 * `server/src/app.ts` and `server/src/events.ts`) but replays a deterministic
 * task instead of driving a real model, so the test never depends on an LLM.
 *
 * The sequence exercises the whole operator surface:
 *   task → plan → approval request → tool call → file change → command →
 *   validation failure → recovery → approval decided → validation pass →
 *   completion → report
 *
 * Plain JS on purpose: no transpiler is needed to run it.
 */

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const TASK_ID = 'e2e-task-0001'
const PORT = Number(process.argv[2] ?? process.env.DAEDALUS_E2E_PORT ?? 3099)

const CORS = {
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-origin': '*',
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...CORS,
  })
  res.end(data)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

const base = { task_id: TASK_ID, ts: '2026-10-04T00:00:00.000Z' }
const APPROVAL_KEY = { taskId: TASK_ID, tool: 'write_file', action: 'create', path: 'src/health.ts' }
const WRITE_CALL = { id: 'call-1', task_id: TASK_ID, tool: 'write_file', args: { path: 'src/health.ts' } }

/** The fixed event sequence the whole UI renders from. */
/**
 * server/workspace.ts#buildTree returns one node per request with its children
 * inline, not a bare entry list.
 */
const TREE = {
  '.': {
    name: 'e2e-workspace',
    path: '.',
    isDirectory: true,
    children: [
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'package.json', path: 'package.json', isDirectory: false, size: 42 },
    ],
  },
  src: {
    name: 'src',
    path: 'src',
    isDirectory: true,
    children: [{ name: 'health.ts', path: 'src/health.ts', isDirectory: false, size: 22 }],
  },
}

const FULL_SEQUENCE = [
  { ...base, seq: 1, type: 'TASK_STARTED', payload: { spec: { id: TASK_ID, goal: 'add a health endpoint', repo_path: '.' } } },
  {
    ...base,
    seq: 2,
    type: 'PLAN_CREATED',
    payload: {
      plan: {
        id: 'plan-1',
        task_id: TASK_ID,
        version: 1,
        status: 'active',
        steps: [
          { id: 's1', intent: 'inspect the repository', status: 'done', evidence: ['read package.json'] },
          { id: 's2', intent: 'write the health endpoint', status: 'active', evidence: [] },
          { id: 's3', intent: 'add a test for the endpoint', status: 'pending', evidence: [] },
        ],
      },
    },
  },
  { ...base, seq: 3, type: 'APPROVAL_REQUESTED', payload: { key: APPROVAL_KEY, policy: 'ask' } },
  { ...base, seq: 4, type: 'TOOL_CALL_STARTED', payload: { call: WRITE_CALL } },
  {
    ...base,
    seq: 5,
    type: 'TOOL_CALL_FINISHED',
    payload: {
      call: WRITE_CALL,
      result: { call_id: 'call-1', status: 'ok', output: 'wrote 1 file', truncated: false, meta: {} },
    },
  },
  {
    ...base,
    seq: 6,
    type: 'FILE_CHANGED',
    // Shape mirrors core/runtime.ts#emitFileChanged. A partial payload here
    // reaches the web as an undefined field and blanks the whole workspace, so
    // the fixture has to carry every field the panels read.
    payload: {
      call_id: 'call-1',
      path: 'src/health.ts',
      tool: 'write_file',
      operation: 'created',
      added: 1,
      removed: 0,
      lines: [{ kind: 'add', text: 'export const ok = true' }],
      patch: '--- a/src/health.ts\n+++ b/src/health.ts\n@@ -0,0 +1 @@\n+export const ok = true',
    },
  },
  { ...base, seq: 7, type: 'COMMAND_STARTED', payload: { call_id: 'cmd-1', command: 'npm test', cwd: '.' } },
  { ...base, seq: 8, type: 'COMMAND_OUTPUT', payload: { call_id: 'cmd-1', chunk: '1 failing\n' } },
  { ...base, seq: 9, type: 'COMMAND_FINISHED', payload: { call_id: 'cmd-1', exit_code: 1, status: 'error', killed: false } },
  { ...base, seq: 10, type: 'VALIDATION_STARTED', payload: {} },
  {
    ...base,
    seq: 11,
    type: 'VALIDATION_FAILED',
    payload: {
      result: {
        checks: [
          { name: 'build', cmd: 'npm run build', status: 'pass', exit_code: 0, summary: 'built', diagnostics: [] },
          {
            name: 'test',
            cmd: 'npm test',
            status: 'fail',
            exit_code: 1,
            summary: '1 failing',
            diagnostics: [{ file: 'src/health.test.ts', line: 12, message: 'expected 404 to equal 200' }],
          },
        ],
      },
    },
  },
  { ...base, seq: 12, type: 'RECOVERY_STARTED', payload: { reason: 'test failed', strategy: 'retry', attempt: 1 } },
  { ...base, seq: 13, type: 'APPROVAL_DECIDED', payload: { key: APPROVAL_KEY, decision: 'grant' } },
  { ...base, seq: 14, type: 'VALIDATION_STARTED', payload: {} },
  {
    ...base,
    seq: 15,
    type: 'VALIDATION_PASSED',
    payload: {
      result: {
        checks: [
          { name: 'build', cmd: 'npm run build', status: 'pass', exit_code: 0, summary: 'built', diagnostics: [] },
          { name: 'test', cmd: 'npm test', status: 'pass', exit_code: 0, summary: 'all passing', diagnostics: [] },
        ],
      },
    },
  },
  { ...base, seq: 16, type: 'TASK_COMPLETED', payload: { outcome: 'success', reason: 'validation passed after 1 retry' } },
]

/**
 * An approval blocks the agent, so the replay honours that instead of handing
 * the browser a finished task: the sequence stops at APPROVAL_REQUESTED and only
 * resumes once a decision arrives. Tests that never decide (they assert the
 * outcome panels) are released by the auto-grant timer.
 */
const APPROVAL_SEQ = FULL_SEQUENCE.find((event) => event.type === 'APPROVAL_REQUESTED').seq
const POST_APPROVAL = FULL_SEQUENCE.filter((event) => event.seq > APPROVAL_SEQ)
const LAST_SEQ = FULL_SEQUENCE.at(-1).seq
/** Safety net so a test that never releases cannot hang until the suite timeout. */
const AUTO_GRANT_MS = 10_000

/** Highest seq released so far, so a late subscriber resumes instead of replaying. */
let releasedSeq = APPROVAL_SEQ
let autoGrant

function releaseAfterApproval() {
  clearTimeout(autoGrant)
  autoGrant = undefined
  for (const socket of sockets) {
    for (const event of POST_APPROVAL) {
      if (event.seq <= releasedSeq) continue
      socket.send(JSON.stringify({ kind: 'event', event }))
    }
  }
  releasedSeq = LAST_SEQ
}

/** Events a subscriber should receive right now. */
function replayable(sinceSeq) {
  return FULL_SEQUENCE.filter((event) => event.seq > sinceSeq && event.seq <= releasedSeq)
}

/**
 * Armed only once the browser has submitted: the initial wildcard subscribe
 * happens on page load, and a timer started there would have already released
 * the run before the test ever sees the approval card.
 */
function armAutoGrant() {
  if (!submitted || autoGrant || releasedSeq >= LAST_SEQ) return
  autoGrant = setTimeout(releaseAfterApproval, AUTO_GRANT_MS)
}

/** Decisions the browser posted, exposed on /__e2e/decisions for assertions. */
const decisions = []
const sockets = new Set()
/** Set once the browser has submitted, so GET /tasks reflects the scripted task. */
let submitted = false

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'daedalus-e2e-scripted', active_tasks: 1 })
    return
  }

  if (method === 'GET' && url.pathname === '/workspace/roots') {
    sendJson(res, 200, { roots: ['/tmp/e2e-workspace'], cwd: '/tmp/e2e-workspace' })
    return
  }

  if (method === 'GET' && url.pathname === '/workspace/tree') {
    // The client re-requests a path when the user expands a directory.
    const path = url.searchParams.get('path') ?? '.'
    sendJson(res, 200, TREE[path] ?? { name: path, path, isDirectory: true, children: [] })
    return
  }

  if (method === 'GET' && url.pathname === '/workspace/list') {
    // The tree expands through this route, which returns a bare entry list.
    const path = url.searchParams.get('path') ?? '.'
    sendJson(res, 200, { path, items: TREE[path]?.children ?? [] })
    return
  }

  if (method === 'GET' && url.pathname === '/workspace/file') {
    sendJson(res, 200, {
      path: url.searchParams.get('path') ?? 'src/health.ts',
      content: 'export const ok = true\n',
      size: 22,
    })
    return
  }

  if (method === 'GET' && url.pathname === '/tasks') {
    // The header polls this on load and after every submission. Leaving it
    // unimplemented put the browser into a bare error state instead.
    sendJson(res, 200, {
      tasks: submitted
        ? [
            {
              id: TASK_ID,
              goal: 'add a health endpoint',
              status: 'running',
              repo_path: '/tmp/e2e-workspace',
              created_at: '2026-10-04T00:00:00.000Z',
              updated_at: '2026-10-04T00:00:05.000Z',
              turns: 3,
              tool_calls: 1,
            },
          ]
        : [],
      count: submitted ? 1 : 0,
    })
    return
  }

  if (method === 'POST' && url.pathname === '/tasks') {
    void readJson(req).then(() => {
      submitted = true
      armAutoGrant()
      sendJson(res, 201, {
        id: TASK_ID,
        goal: 'add a health endpoint',
        repo_path: '/tmp/e2e-workspace',
        created_at: '2026-10-04T00:00:00.000Z',
      })
      // The client subscribes only after it has the task id, so the whole
      // sequence — TASK_STARTED included — is delivered on subscribe. This
      // setTimeout only nudges a client that had already subscribed.
      setTimeout(() => {
        for (const socket of sockets) {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ kind: 'event', event: FULL_SEQUENCE[0] }))
          }
        }
      }, 100)
    })
    return
  }

  if (method === 'POST' && /^\/tasks\/[^/]+\/approve$/.test(url.pathname)) {
    void readJson(req).then((body) => {
      decisions.push(body)
      sendJson(res, 200, { success: true, decision: body.decision, remember: body.remember === true })
      releaseAfterApproval()
    })
    return
  }

  if (method === 'POST' && /^\/tasks\/[^/]+\/cancel$/.test(url.pathname)) {
    sendJson(res, 200, { cancelled: true })
    return
  }

  if (method === 'GET' && /^\/tasks\/[^/]+\/report$/.test(url.pathname)) {
    sendJson(res, 200, {
      report: {
        task_id: TASK_ID,
        outcome: 'success',
        diff: '+export const ok = true',
        evidence: ['build: pass (npm run build)', 'create src/health.ts (+1/-0)'],
        metrics: {
          turns: 3,
          tool_calls: 1,
          events: FULL_SEQUENCE.length,
          commands: 1,
          files_changed: 1,
          recoveries: 1,
          replans: 0,
          approvals: 1,
          checks_passed: 2,
          checks_failed: 0,
        },
      },
    })
    return
  }

  if (method === 'GET' && /^\/tasks\/[^/]+$/.test(url.pathname)) {
    sendJson(res, 200, { state: { id: TASK_ID, status: 'running' }, events: FULL_SEQUENCE, report: null, running: true })
    return
  }

  if (method === 'GET' && url.pathname === '/__e2e/decisions') {
    sendJson(res, 200, { decisions })
    return
  }

  // Tests that assert later panels release the run explicitly; only the approval
  // test leaves it blocked so it can click the card.
  if (method === 'POST' && url.pathname === '/__e2e/grant') {
    releaseAfterApproval()
    sendJson(res, 200, { released_seq: releasedSeq })
    return
  }

  // One gateway process serves the whole run, so each test starts from the same
  // state instead of inheriting the previous test's released sequence.
  if (method === 'POST' && url.pathname === '/__e2e/reset') {
    clearTimeout(autoGrant)
    autoGrant = undefined
    releasedSeq = APPROVAL_SEQ
    submitted = false
    decisions.length = 0
    sendJson(res, 200, { released_seq: releasedSeq })
    return
  }

  sendJson(res, 404, { error: 'not_found' })
})

const wss = new WebSocketServer({ server, path: '/tasks/events' })

wss.on('connection', (socket) => {
  sockets.add(socket)
  socket.send(
    JSON.stringify({ kind: 'hello', protocol: 'daedalus-events', version: 1, server_ts: '2026-10-04T00:00:00.000Z' }),
  )

  socket.on('message', (raw) => {
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    if (parsed.kind !== 'subscribe') return
    const sinceSeq = typeof parsed.since_seq === 'number' ? parsed.since_seq : 0
    const replay = replayable(sinceSeq)
    for (const event of replay) socket.send(JSON.stringify({ kind: 'event', event }))
    socket.send(
      JSON.stringify({
        kind: 'subscribed',
        task_id: parsed.task_id ?? '*',
        since_seq: sinceSeq,
        replayed: replay.length,
        last_seq: releasedSeq,
      }),
    )
    armAutoGrant()
  })

  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`scripted gateway listening on http://127.0.0.1:${PORT}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const socket of sockets) socket.close()
    wss.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  })
}