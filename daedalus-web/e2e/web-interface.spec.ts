import { expect, test, type Page } from '@playwright/test'
import { palette, paletteLight } from '@daedalus/core/palette'

/** The scripted gateway, for the test-only control endpoints. */
const GATEWAY_URL = process.env.DAEDALUS_E2E_GATEWAY_URL ?? 'http://127.0.0.1:3099'

/** The form the browser reports a computed color in. */
function toRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

/**
 * Browser end-to-end proof for the Daedalus web interface (PLAN.md Phase 8).
 *
 * Drives a real Chrome against the real UI, with the scripted gateway supplying
 * a fixed event sequence — no LLM, no network, fully deterministic.
 *
 * The journey asserted here is the acceptance-criteria list for Phase 8:
 * submit → plan appears before actions → approval blocks until decided →
 * tool call + file change → terminal streams output and exit status →
 * validation shows real checks → retry → files changed → report with metrics.
 */

async function waitForStream(page: Page): Promise<void> {
  // Every panel renders from the event log, so nothing else is meaningful until
  // the WebSocket handshake has completed.
  await expect(page.getByTestId('connection-badge')).toContainText(/open|connected/i, { timeout: 20_000 })
}

/**
 * Submits a task, then releases the scripted run past the approval gate.
 *
 * The gateway holds the sequence at APPROVAL_REQUESTED so the approval card is
 * observable. Tests that are not about approval call `release()`; the approval
 * test leaves the run blocked and decides through the UI.
 */
async function submitTask(page: Page, options: { release?: boolean; goal?: string } = {}): Promise<void> {
  const { release = true, goal = 'add a health endpoint' } = options
  await waitForStream(page)
  await page.getByTestId('composer-input').fill(goal)
  await page.getByTestId('composer-submit').click()
  await expect(page.getByTestId('approval-card')).toBeVisible()
  if (release) await releaseRun(page)
}

async function releaseRun(page: Page): Promise<void> {
  const response = await page.request.post(`${GATEWAY_URL}/__e2e/grant`)
  expect(response.status()).toBe(200)
}

test.describe('Daedalus web interface', () => {
  // One gateway process serves the whole run; without this each test would
  // inherit the previous test's released event sequence.
  test.beforeEach(async ({ request }) => {
    const response = await request.post(`${GATEWAY_URL}/__e2e/reset`)
    expect(response.status()).toBe(200)
  })

  test('renders the shell and reports a live connection', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('top-bar')).toBeVisible()
    await waitForStream(page)
  })

  test('a submitted task shows its plan before the agent acts', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    const plan = page.getByTestId('plan-panel')
    await expect(plan).toBeVisible()
    await expect(plan).toContainText('inspect the repository')
    await expect(plan).toContainText('write the health endpoint')
    await expect(plan).toContainText('add a test for the endpoint')
    await expect(page.getByTestId('plan-step')).toHaveCount(3)
    // The active step is surfaced separately from the checklist.
    await expect(page.getByTestId('current-step')).toContainText('write the health endpoint')
  })

  test('an approval request appears inline and blocks until decided', async ({ page }) => {
    await page.goto('/')
    // The run stays blocked at the gate so the card is still there to decide on.
    await submitTask(page, { release: false })

    const card = page.getByTestId('approval-card')
    await expect(card).toContainText('write_file')
    await expect(card).toContainText('src/health.ts')

    // The decision must reach the gateway, not just flip a local flag.
    const posted = page.waitForResponse(
      (response) => response.url().includes('/approve') && response.request().method() === 'POST',
    )
    await page.getByTestId('approval-allow').click()
    expect((await posted).status()).toBe(200)

    // The card disappears once the timeline records APPROVAL_DECIDED.
    await expect(card).toBeHidden()
  })

  test('the terminal streams command output and the exit status', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    await expect(page.getByTestId('terminal-panel')).toBeVisible()
    // The accessible log is the reliable target; xterm paints to a canvas.
    const log = page.getByTestId('terminal-log')
    await expect(log).toContainText('npm test')
    await expect(log).toContainText('1 failing')
    await expect(log).toContainText('exit 1')
    await expect(page.getByTestId('process-status')).toBeVisible()
  })

  test('validation reports the final verdict after a retry', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    const panel = page.getByTestId('validation-panel')
    await expect(panel).toBeVisible()
    // The scripted run fails once, then passes — the last verdict wins.
    await expect(page.getByTestId('validation-verdict')).toContainText('passed')
    await expect(page.getByTestId('validation-check')).toHaveCount(2)
    await expect(panel).toContainText('build')
    await expect(panel).toContainText('test')
    // The mid-run failure is still on the record in the timeline.
    await expect(page.getByTestId('activity-panel')).toContainText('validation failed')
  })

  test('recovery records the retry', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    const recovery = page.getByTestId('recovery-panel')
    await expect(recovery).toBeVisible()
    await expect(page.getByTestId('recovery-count')).toContainText('1 retries')
    await expect(page.getByTestId('recovery-attempt')).toContainText('test failed')
  })

  test('errors from a failed check are classified and expandable', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    const errors = page.getByTestId('error-panel')
    await expect(errors).toBeVisible()
    await expect(page.getByTestId('error-entry').first()).toBeVisible()
  })

  test('a completed task shows files changed and a final report with metrics', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    await expect(page.getByTestId('diff-panel')).toContainText('src/health.ts')
    await expect(page.getByTestId('validation-panel')).toContainText('build')

    const report = page.getByTestId('final-report-panel')
    await expect(report).toBeVisible()
    await expect(report).toContainText('success')
    await expect(report).toContainText('validation passed after 1 retry')
    await expect(page.getByTestId('report-metrics')).toBeVisible()
    await expect(page.getByTestId('report-evidence')).toContainText('build: pass')
  })

  test('the activity timeline records the whole task', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    const timeline = page.getByTestId('activity-panel')
    await expect(timeline).toBeVisible()
    await expect(timeline).toContainText('Task accepted')
    await expect(timeline).toContainText('Plan created')
    await expect(timeline).toContainText('write_file')
    await expect(timeline).toContainText('task success')
    await expect(page.getByTestId('tool-call').first()).toBeVisible()
  })

  test('the theme toggle swaps the document theme', async ({ page }) => {
    await page.goto('/')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-theme', 'daedalus-dark')

    await page.getByRole('button', { name: /switch to light theme/i }).click()
    await expect(html).toHaveAttribute('data-theme', 'daedalus-light')
    await expect(page.getByRole('button', { name: /switch to dark theme/i })).toBeVisible()
  })

  /**
   * The editor and the terminal are the two surfaces most likely to drift back
   * to a foreign palette, because both ship their own theming. Asserted against
   * the resolved `--daedalus-*` variables so the check follows the palette
   * rather than a hardcoded hex.
   */
  test('the editor and terminal surfaces paint on palette colors', async ({ page }) => {
    await page.goto('/')
    await submitTask(page)

    // The editor opens from the workspace tree; the diff panel only selects which
    // file the diff shows.
    await page.locator('[data-testid="file-tree-dir"][data-path="src"]').click()
    await page.locator('[data-testid="file-tree-item"][data-path="src/health.ts"]').click()
    await expect(page.getByTestId('monaco-host')).toBeVisible()
    await expect(page.locator('.xterm-scrollable-element')).toBeVisible()

    /** The palette background currently resolved by the document. */
    const paletteBackground = async (): Promise<string> =>
      toRgb(await page.locator('html').evaluate((node) => getComputedStyle(node).getPropertyValue('--daedalus-bgBase').trim()))

    const dark = await paletteBackground()
    // xterm applies its theme background to the scrollable element; the viewport
    // and screen above it stay transparent, so this is the painted surface.
    expect(await page.locator('.xterm-scrollable-element').evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(dark)
    // Monaco paints its own theme on the editor root; the layers above it are
    // transparent, so this is the surface a reader actually sees.
    expect(await page.locator('.monaco-editor').first().evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(dark)
    // A bundled vs-dark theme would ship its own token colors, so every color
    // Monaco paints has to come from the palette: a syntax role, or the plain
    // text color for tokens the theme deliberately leaves unemphasized.
    const paletteColors = new Set(
      [palette, paletteLight].flatMap((theme) =>
        Object.entries(theme)
          .filter(([key]) => key.startsWith('syntax') || key === 'fgBase')
          .map(([, hex]) => toRgb(hex)),
      ),
    )
    const tokenColors = await page.locator('.monaco-editor .view-line span span').evaluateAll((nodes) =>
      nodes.map((n) => getComputedStyle(n).color),
    )
    expect(tokenColors.length).toBeGreaterThan(0)
    for (const color of tokenColors) expect([...paletteColors]).toContain(color)

    // A theme switch must repaint both surfaces, not just the surrounding chrome.
    await page.getByRole('button', { name: /switch to light theme/i }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'daedalus-light')

    const light = await paletteBackground()
    expect(light).not.toBe(dark)
    await expect
      .poll(() => page.locator('.xterm-scrollable-element').evaluate((n) => getComputedStyle(n).backgroundColor))
      .toBe(light)
    await expect
      .poll(() => page.locator('.monaco-editor').first().evaluate((n) => getComputedStyle(n).backgroundColor))
      .toBe(light)
  })

  test('every animation is disabled under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await submitTask(page)

    await expect(page.getByTestId('plan-step').first()).toBeVisible()
    // motion.css forces animation/transition/background-image to none.
    const computed = await page.getByTestId('plan-step').first().evaluate((node) => {
      const style = getComputedStyle(node)
      return { animationName: style.animationName, transitionDuration: style.transitionDuration }
    })
    expect(computed.animationName).toBe('none')
    expect(['0s', '0ms']).toContain(computed.transitionDuration)
  })
})