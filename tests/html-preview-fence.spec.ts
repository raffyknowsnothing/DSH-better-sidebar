/**
 * HTML preview fence tests.
 *
 * The bug these lock down: the preview route serves its document under
 * `Content-Security-Policy: sandbox` with no `allow-same-origin`, so the page
 * runs in an OPAQUE origin. Every request that page then makes for itself —
 * its stylesheet, an image, a classic script, a module script, a fetch, its
 * own `location.reload()` — arrives as `Sec-Fetch-Site: cross-site` with no
 * `Origin` (or `Origin: null` for the CORS-mode ones). The shared marker
 * fence refused all of them, so a preview rendered once and then reloaded
 * itself into a bare `forbidden` body, with no CSS and no images.
 *
 * Header values in the requests below are copied from a real Chromium run
 * against a sandboxed iframe, not invented.
 *
 * The fix does not relax the fence, because no header separates the preview's
 * own request from a cross-site attacker's — they are byte-identical. The
 * route proves itself with an unguessable ticket in the URL path instead
 * (html-ticket.ts), which relative assets carry automatically. The Host
 * fence and the workspace real-path guard both still apply, and the last
 * tests here hold that line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, mediaTypeForPath, previewTypeForPath } from '../src/index.ts'
import { encodeHtmlUrl } from '../src/html-route.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

const SESSION = 'preview-session'
let workspace: string
let documentPath: string
let stylePath: string

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-html-fence-'))
  documentPath = join(workspace, 'index.html')
  stylePath = join(workspace, 'style.css')
  writeFileSync(documentPath, '<!doctype html><link rel="stylesheet" href="style.css"><h1>hello</h1>')
  writeFileSync(stylePath, 'h1 { color: rgb(1, 2, 3) }')
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
}

function fakeRes(reply: Reply): ServerResponse {
  return {
    writeHead(status: number, headers: Record<string, string> = {}) {
      reply.status = status
      reply.headers = headers
    },
    end(body?: string | Buffer) {
      if (body !== undefined) reply.body = body.toString()
    },
  } as unknown as ServerResponse
}

interface Mount {
  /** GET the preview route with an explicit header set. */
  get: (url: string, headers: Record<string, string>) => Promise<Reply>
  /** This mount's minted ticket, read over the fenced JSON route. */
  ticket: string
  cleanup: () => void
}

/** Mount apply() against a fake context whose session cwd is the workspace. */
async function mount(trustedHosts: readonly string[] = [], cwd = workspace): Promise<Mount> {
  const routes: SidebarWebRoute[] = []
  const effects: Array<() => void> = []
  const ctx = {
    webRuntime: { trustedHosts: [...trustedHosts] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
    },
    sessions: { get: () => ({ header: { cwd } }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    inject: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  const html = routes.find(route => route.path === '/sidebar/html')!
  const api = routes.find(route => route.path === '/sidebar/api')!

  const ticketReply: Reply = { status: 0, headers: {}, body: '' }
  await api.handler({
    method: 'POST',
    url: '/sidebar/api/html.ticket',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}') },
  } as unknown as IncomingMessage, fakeRes(ticketReply))
  const ticket = (JSON.parse(ticketReply.body) as { value: { ticket: string } }).value.ticket

  return {
    ticket,
    get: async (url, headers) => {
      const reply: Reply = { status: 0, headers: {}, body: '' }
      await html.handler({ method: 'GET', url, headers } as unknown as IncomingMessage, fakeRes(reply))
      return reply
    },
    cleanup: () => { for (const cleanup of effects) cleanup() },
  }
}

/** Headers of a no-cors subresource from the sandboxed preview (link, img, classic script). */
const SUBRESOURCE = { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }
/** Headers of a CORS-mode request from the same page (module script, fetch). */
const CORS_MODE = { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site', origin: 'null' }
/** Headers of the first load, which the GUI itself initiates. */
const SAME_ORIGIN = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' }

describe('a sandboxed preview can load its own assets', () => {
  it('serves a relative stylesheet requested with cross-site markers', async () => {
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, stylePath), SUBRESOURCE)
      expect(reply.status).toBe(200)
      expect(reply.body).toContain('rgb(1, 2, 3)')
    } finally {
      cleanup()
    }
  })

  it('types a stylesheet as text/css, which nosniff makes mandatory', async () => {
    // The route sends X-Content-Type-Options: nosniff. A stylesheet served as
    // application/octet-stream is REFUSED by Chromium, so the page renders
    // unstyled — which looked exactly like the fence still blocking it.
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, stylePath), SUBRESOURCE)
      expect(reply.headers['content-type']).toBe('text/css')
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      cleanup()
    }
  })

  it('types a script as text/javascript', async () => {
    const scriptPath = join(workspace, 'app.js')
    writeFileSync(scriptPath, 'globalThis.loaded = true')
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, scriptPath), SUBRESOURCE)
      expect(reply.status).toBe(200)
      expect(reply.headers['content-type']).toBe('text/javascript')
    } finally {
      cleanup()
    }
  })

  it('serves a CORS-mode request carrying the opaque Origin: null', async () => {
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, stylePath), CORS_MODE)
      expect(reply.status).toBe(200)
    } finally {
      cleanup()
    }
  })

  it('serves the document again when the page reloads itself', async () => {
    // The first load is same-origin (the GUI sets the iframe src); the
    // reload is the page's own navigation and reads as cross-site. Both
    // must return the document, otherwise the frame shows 'forbidden'.
    const { get, ticket, cleanup } = await mount()
    try {
      const url = encodeHtmlUrl(ticket, SESSION, documentPath)
      expect((await get(url, SAME_ORIGIN)).status).toBe(200)
      const reload = await get(url, SUBRESOURCE)
      expect(reload.status).toBe(200)
      expect(reload.body).toContain('hello')
      expect(reload.body).not.toContain('forbidden')
    } finally {
      cleanup()
    }
  })

  it('drops the sandbox header when the previewer asks for the unsandboxed mode', async () => {
    // The regression this locks down: the header used to go out on every
    // preview, so turning the sandbox off removed the iframe attribute and
    // the header put the opaque origin straight back. The page still had no
    // origin, so it still had no storage and could not call its own server —
    // and the setting's warning about "full session access" was simply false.
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, documentPath, false), SAME_ORIGIN)
      expect(reply.status).toBe(200)
      expect(reply.headers['content-security-policy']).not.toContain('sandbox')
      // Plugin embeds stay blocked either way.
      expect(reply.headers['content-security-policy']).toContain("object-src 'none'")
    } finally {
      cleanup()
    }
  })

  it('keeps the opaque-origin sandbox header on the served document', async () => {
    // The ticket replaces the marker fence, not the sandbox. The preview
    // must still run without same-origin access to the GUI.
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, documentPath), SAME_ORIGIN)
      expect(reply.headers['content-security-policy']).toContain('sandbox')
      expect(reply.headers['content-security-policy']).not.toContain('allow-same-origin')
    } finally {
      cleanup()
    }
  })
})

describe('the ticket is what a cross-site page cannot forge', () => {
  it('refuses a wrong ticket even with same-origin markers', async () => {
    const { get, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl('not-the-ticket', SESSION, documentPath), SAME_ORIGIN)
      expect(reply.status).toBe(403)
      expect(reply.body).toBe('forbidden')
    } finally {
      cleanup()
    }
  })

  it('refuses a URL in the old ticket-less shape', async () => {
    const { get, cleanup } = await mount()
    try {
      // '/sidebar/html/<session>/<path>' reads the session as the ticket and
      // the first path segment as the sandbox mode, so it fails before it
      // ever reaches a file.
      const reply = await get(`/sidebar/html/${SESSION}${documentPath}`, SAME_ORIGIN)
      expect(reply.status).toBe(400)
      expect(JSON.parse(reply.body)).toMatchObject({
        ok: false,
        error: { message: 'unknown sandbox mode' },
      })
    } finally {
      cleanup()
    }
  })

  it('answers a wrong ticket identically whether the file exists or not', async () => {
    // A probing page must not learn that a path is real from the response.
    const { get, cleanup } = await mount()
    try {
      const real = await get(encodeHtmlUrl('wrong', SESSION, documentPath), SUBRESOURCE)
      const absent = await get(encodeHtmlUrl('wrong', SESSION, join(workspace, 'nope.html')), SUBRESOURCE)
      expect(real).toEqual(absent)
    } finally {
      cleanup()
    }
  })

  it('keeps one ticket per process, so a re-apply cannot strand a loaded page', async () => {
    // Deliberately NOT per apply(): a profile with patchReload "live"
    // re-applies the plugin, and a second mount is legal. A rotating ticket
    // would 403 every preview on an already-loaded page, indistinguishably
    // from the original bug. See html-ticket.ts.
    const first = await mount()
    const second = await mount()
    try {
      expect(first.ticket).toBe(second.ticket)
      expect(first.ticket.length).toBeGreaterThanOrEqual(32)
      // Either instance serves a URL built from either instance's ticket.
      const reply = await second.get(encodeHtmlUrl(first.ticket, SESSION, documentPath), SAME_ORIGIN)
      expect(reply.status).toBe(200)
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  it('is long enough to be unguessable', async () => {
    const { ticket, cleanup } = await mount()
    try {
      // 24 random bytes, base64url. Length is the cheap proxy; the entropy
      // is what stops a cross-site page from finding it by trying.
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{32}$/)
    } finally {
      cleanup()
    }
  })
})

describe('the ticket authorizes the route, not the file', () => {
  it('still refuses a path outside the session workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-html-fence-outside-'))
    mkdirSync(join(outside, 'nested'), { recursive: true })
    const secret = join(outside, 'nested', 'secret.html')
    writeFileSync(secret, '<p>secret</p>')
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, secret), SAME_ORIGIN)
      expect(reply.status).toBe(403)
      expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    } finally {
      cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still refuses an untrusted Host (the DNS-rebinding fence is unchanged)', async () => {
    const { get, ticket, cleanup } = await mount()
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, documentPath), {
        host: 'evil.example.com',
        'sec-fetch-site': 'same-origin',
      })
      expect(reply.status).toBe(403)
      expect(reply.body).toBe('forbidden')
    } finally {
      cleanup()
    }
  })

  it('accepts a configured trusted host, as the shared fence does', async () => {
    const { get, ticket, cleanup } = await mount(['proxy.example.com'])
    try {
      const reply = await get(encodeHtmlUrl(ticket, SESSION, documentPath), {
        host: 'proxy.example.com',
        'sec-fetch-site': 'cross-site',
      })
      expect(reply.status).toBe(200)
    } finally {
      cleanup()
    }
  })
})

describe('preview content types stay out of the shared media map', () => {
  it('leaves /sidebar/file typing unchanged', async () => {
    // The media route is reached from the GUI's own origin. Typing a
    // workspace file as text/javascript THERE would let it be loaded as a
    // same-origin script, so the preview types live in their own map.
    expect(mediaTypeForPath('/a/style.css')).toBe('application/octet-stream')
    expect(mediaTypeForPath('/a/app.js')).toBe('application/octet-stream')
    expect(previewTypeForPath('/a/style.css')).toBe('text/css')
    expect(previewTypeForPath('/a/app.js')).toBe('text/javascript')
  })

  it('keeps the shared image and document types', () => {
    expect(previewTypeForPath('/a/pic.png')).toBe('image/png')
    expect(previewTypeForPath('/a/doc.pdf')).toBe('application/pdf')
    expect(previewTypeForPath('/a/page.html')).toBe('text/html')
  })

  it('falls back to a binary-safe type for anything unknown', () => {
    expect(previewTypeForPath('/a/thing.xyz')).toBe('application/octet-stream')
  })
})
