/**
 * End-to-end proof for the HTML preview fence (html-ticket.ts), against a
 * real packed plugin mounted in a real `dsh web`.
 *
 * The regression: the preview iframe is sandboxed into an opaque origin, so
 * everything the previewed page asks for on its own behalf reaches the route
 * as `Sec-Fetch-Site: cross-site`. The shared marker fence refused all of it,
 * so the page rendered once, lost its stylesheet, and then reloaded itself
 * into the route's bare `forbidden` body. Only a real browser produces those
 * markers, which is why this lives here and not in the unit specs.
 *
 * The page below exercises both halves: a relative stylesheet, and a
 * document-initiated `location.reload()`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc } from './host'

const HTML_FILE = 'preview-fence.html'
/** The lane's own workspace: the sidebar renders against THIS path, so a file
 *  seeded anywhere else never appears in the tree. */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')
let api: APIRequestContext

test.beforeAll(async () => {
  api = await createHostApi()
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, HTML_FILE), [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="preview-fence.css">',
    '</head><body>',
    '<h1 id="mark">hello html preview</h1>',
    // The document navigates itself, which is the exact request the fence
    // used to refuse.
    '<script>setTimeout(() => location.reload(), 400)</script>',
    '</body></html>',
  ].join('\n'))
  writeFileSync(join(WORKSPACE_PATH, 'preview-fence.css'), '#mark { color: rgb(1, 2, 3) }')
  // Seeded the way the mount lane seeds: the sidebar needs a session scope,
  // and the session's cwd is what bounds the preview route's workspace guard.
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})

test('an html preview keeps its relative assets and survives its own reload', async ({ page }) => {
  await gotoPage(page)
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  // A keyless boot masks the whole shell with its onboarding takeovers; every
  // click below is intercepted until they are gone.
  await dismissOnboarding(page)
  await sidebar.getByRole('button', { name: 'Expand sidebar' }).click()
  await sidebar.locator('[title="Files"][draggable="true"]').first().click()
  const row = sidebar.locator(`[role="button"][title$="${HTML_FILE}"]:visible`)
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  await row.click({ position: { x: 8, y: 8 } })
  const frame = sidebar.locator('iframe[src*="/sidebar/html/"]')
  await expect(frame).toHaveCount(1, { timeout: 30_000 })
  // Let the document's own reload (400ms) fire and settle before reading.
  await page.waitForTimeout(2000)
  const frameBody = frame.contentFrame()
  expect(frameBody).not.toBeNull()
  const text = await frameBody!.locator('body').innerText()
  expect(text).toContain('hello html preview')
  expect(text).not.toContain('forbidden')
  // The stylesheet is a separate cross-site request; if the fence refused it
  // the heading keeps the default colour.
  const color = await frameBody!.locator('#mark').evaluate(el => getComputedStyle(el).color)
  expect(color).toBe('rgb(1, 2, 3)')
})
