// @vitest-environment jsdom
/**
 * Client half of the HTML preview ticket (html-ticket.ts): the preview frame
 * mounts with its sandbox already applied and picks up `src` once the ticket
 * resolves. The ticket cannot be known at first render — the client fetches
 * it over the fenced JSON route — so this asserts the sequence, not a single
 * paint. It also pins the caching: many previews must not mean many requests.
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { api, resetHtmlTicket } from '../src/client/api.ts'
import { TextEditor, HTML_IFRAME_SANDBOX } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

const roots: Root[] = []

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
  resetHtmlTicket()
})

function viewerProps(store: ReturnType<typeof createSidebarStore>): FileViewerProps {
  return {
    ctx: {} as Context,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a/index.html',
    title: 'index.html',
    viewerId: 'html',
    content: '<h1>hi</h1>',
  }
}

/** Render one HTML preview and return its iframe once effects have flushed. */
async function renderPreview(store = createSidebarStore()): Promise<HTMLIFrameElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<TextEditor {...viewerProps(store)} />)
  })
  return container.querySelector('iframe')!
}

describe('HTML preview ticket', () => {
  it('loads the preview through a ticketed URL', async () => {
    vi.spyOn(api, 'htmlTicket').mockResolvedValue({ ticket: 'tkt-abc' })
    const iframe = await renderPreview()
    expect(iframe.getAttribute('src')).toBe('/sidebar/html/tkt-abc/s/s1/p/a/index.html')
    // The sandbox contract is unchanged by the ticket.
    expect(iframe.getAttribute('sandbox')).toBe(HTML_IFRAME_SANDBOX)
  })

  it('fetches the ticket once across previews', async () => {
    const htmlTicket = vi.spyOn(api, 'htmlTicket').mockResolvedValue({ ticket: 'tkt-abc' })
    await renderPreview()
    await renderPreview()
    expect(htmlTicket).toHaveBeenCalledTimes(1)
  })

  it('leaves the frame mounted and src-less when the ticket cannot be fetched', async () => {
    // A failed fetch must not take the surface down; the frame stays put and
    // simply loads nothing, which is what the sandbox row already describes.
    vi.spyOn(api, 'htmlTicket').mockRejectedValue(new Error('offline'))
    const iframe = await renderPreview()
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute('src')).toBeNull()
  })

  it('retries after a failure instead of caching the dead promise', async () => {
    const htmlTicket = vi.spyOn(api, 'htmlTicket').mockRejectedValueOnce(new Error('offline'))
    await renderPreview()
    htmlTicket.mockResolvedValue({ ticket: 'tkt-second' })
    const iframe = await renderPreview()
    expect(iframe.getAttribute('src')).toBe('/sidebar/html/tkt-second/s/s1/p/a/index.html')
  })
})

describe('the sandbox toggle reaches the route', () => {
  it('asks for the sandboxed mode by default', async () => {
    vi.spyOn(api, 'htmlTicket').mockResolvedValue({ ticket: 'tkt-abc' })
    const iframe = await renderPreview()
    expect(iframe.getAttribute('src')).toContain('/tkt-abc/s/')
    expect(iframe.getAttribute('sandbox')).toBe(HTML_IFRAME_SANDBOX)
  })

  it('asks for the unsandboxed mode when the setting is off', async () => {
    // The URL is the only way the route learns the user's choice, and it has
    // to agree with the attribute: the response's CSP can pin the page into
    // an opaque origin whatever the attribute says.
    vi.spyOn(api, 'htmlTicket').mockResolvedValue({ ticket: 'tkt-abc' })
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), htmlViewerNoSandbox: true })
    const iframe = await renderPreview(store)
    expect(iframe.getAttribute('src')).toContain('/tkt-abc/u/')
    expect(iframe.getAttribute('sandbox')).toBeNull()
  })
})
