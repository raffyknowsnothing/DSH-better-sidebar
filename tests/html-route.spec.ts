/**
 * /sidebar/html route vocabulary tests: the path-encoded URL scheme must
 * round-trip absolute paths (POSIX and Windows), survive special characters,
 * and refuse malformed input — and crucially, a relative asset reference
 * resolved against an encoded document URL stays inside the same route with
 * the ticket and session scope intact (the WHY of the path-encoding design).
 * The ticket rides in the leading segment for exactly that reason: the
 * previewed page's own assets must carry it without knowing it exists.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { decodeHtmlUrl, encodeHtmlUrl } from '../src/html-route.ts'
import { isWin32 } from './platform.ts'

/** Stand-in for a minted ticket (the real one is 32 base64url characters). */
const T = 'tkt'

describe('encodeHtmlUrl', () => {
  it('encodes a POSIX absolute path into route segments', () => {
    expect(encodeHtmlUrl(T, 'sess-1', '/Users/me/proj/index.html'))
      .toBe('/sidebar/html/tkt/sess-1/Users/me/proj/index.html')
  })

  it('encodes a Windows absolute path (drive colon percent-encoded)', () => {
    expect(encodeHtmlUrl(T, 'sess-1', 'C:\\Users\\me\\a.html'))
      .toBe('/sidebar/html/tkt/sess-1/C%3A/Users/me/a.html')
  })

  it('encodes a UNC path with the // marker (backslash and forward-slash forms)', () => {
    expect(encodeHtmlUrl(T, 'sess-1', '\\\\server\\share\\proj\\a.html'))
      .toBe('/sidebar/html/tkt/sess-1//server/share/proj/a.html')
    expect(encodeHtmlUrl(T, 'sess-1', '//server/share/proj/a.html'))
      .toBe('/sidebar/html/tkt/sess-1//server/share/proj/a.html')
  })

  it('keeps a POSIX // path marker-encoded (the marker is platform-neutral)', () => {
    // The decoder rebuilds '//server/share/...', which node:path resolves to
    // '/server/share/...' on POSIX and '\\server\share\...' on win32 — so the
    // leading double slash round-trips without any platform signal.
    expect(encodeHtmlUrl(T, 's-1', '//server/share/a.html'))
      .toBe('/sidebar/html/tkt/s-1//server/share/a.html')
  })

  it('percent-encodes special characters in segments', () => {
    expect(encodeHtmlUrl(T, 's-1', '/a b/中文/100%.html'))
      .toBe('/sidebar/html/tkt/s-1/a%20b/%E4%B8%AD%E6%96%87/100%25.html')
  })

  it('percent-encodes the ticket segment (base64url is URL-safe, but the encoder must not assume it)', () => {
    expect(encodeHtmlUrl('a/b', 's', '/x.html'))
      .toBe('/sidebar/html/a%2Fb/s/x.html')
  })

  it('ignores leading/trailing slashes (files only)', () => {
    expect(encodeHtmlUrl(T, 's', '/a//b/x.html')).toBe('/sidebar/html/tkt/s/a/b/x.html')
  })
})

describe('decodeHtmlUrl', () => {
  it('decodes a POSIX round-trip', () => {
    const url = encodeHtmlUrl(T, 'sess-1', '/Users/me/proj/index.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 'sess-1', path: '/Users/me/proj/index.html' },
    })
  })

  it('decodes a Windows round-trip (drive path WITHOUT a leading slash, so node resolve() keeps the drive)', () => {
    const url = encodeHtmlUrl(T, 'sess-1', 'C:\\Users\\me\\a.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 'sess-1', path: 'C:/Users/me/a.html' },
    })
  })

  it.skipIf(!isWin32)('decoded drive paths resolve back verbatim on win32', () => {
    // The host runs requireAbsolute() over the decoded path: with the old
    // '/C:/...' form node's resolve() produced 'C:\C:\Users\...' (drive
    // doubled) on Windows and the isWithin(cwd) fence rejected every drive
    // path. The slash-free form must resolve back to the original path.
    expect(resolve('C:/Users/me/a.html')).toBe('C:\\Users\\me\\a.html')
  })

  it('decodes a UNC round-trip back to the platform-neutral forward-slash form', () => {
    const url = encodeHtmlUrl(T, 'sess-1', '\\\\server\\share\\proj\\a.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 'sess-1', path: '//server/share/proj/a.html' },
    })
    // The host's requireAbsolute resolves that form per-platform:
    // '\\server\share\proj\a.html' on win32, '/server/share/proj/a.html' on POSIX.
  })

  it('round-trips a POSIX // path through the same marker', () => {
    const url = encodeHtmlUrl(T, 's-1', '//server/share/a.html')
    expect(decodeHtmlUrl(url)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 's-1', path: '//server/share/a.html' },
    })
  })

  it('returns the ticket verbatim for the host to validate', () => {
    // The decoder never judges the ticket — a wrong one decodes fine and the
    // route refuses it against this run's value (html-ticket.ts).
    const result = decodeHtmlUrl('/sidebar/html/wrong-ticket/s/a.html')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.ticket).toBe('wrong-ticket')
  })

  it('refuses a marker-only UNC URL and stray double slashes (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html/tkt/s//').ok).toBe(false)
    expect(decodeHtmlUrl('/sidebar/html/tkt/s//server//x.html').ok).toBe(false)
  })

  it('decodes a lowercase-drive Windows path without a leading slash', () => {
    expect(decodeHtmlUrl('/sidebar/html/tkt/s/d%3A/work/x.html')).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 's', path: 'd:/work/x.html' },
    })
  })

  it('decodes special characters round-trip', () => {
    const url = encodeHtmlUrl(T, 's-1', '/a b/中文/100%.html')
    const result = decodeHtmlUrl(url)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.path).toBe('/a b/中文/100%.html')
  })

  it('refuses a wrong prefix (404)', () => {
    expect(decodeHtmlUrl('/sidebar/api/fs.read')).toEqual({
      ok: false, status: 404, message: 'not an html route',
    })
  })

  it('refuses an empty or double-slash path (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html/').ok).toBe(false)
    expect(decodeHtmlUrl('/sidebar/html//tkt/s/a.html').ok).toBe(false)
  })

  it('refuses malformed percent encoding (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html/tkt/s/%E0%A4%A').ok).toBe(false)
  })

  it('refuses a missing ticket, sessionId or file path (400)', () => {
    expect(decodeHtmlUrl('/sidebar/html//s/a.html')).toEqual({
      ok: false, status: 400, message: 'ticket, sessionId and file path are required',
    })
    // A ticket and a session but no file: the old two-segment URL shape.
    expect(decodeHtmlUrl('/sidebar/html/tkt/s')).toEqual({
      ok: false, status: 400, message: 'ticket, sessionId and file path are required',
    })
    expect(decodeHtmlUrl('/sidebar/html/tkt/s/')).toEqual({
      ok: false, status: 400, message: 'ticket, sessionId and file path are required',
    })
  })

  it('keeps encoded traversal segments for the isWithin fence to bound', () => {
    // The decoder is not a security boundary by itself: an encoded `..`
    // decodes to `..` and the HOST refuses it via requireAbsolute +
    // isWithin(cwd) (the decoded path resolves outside the cwd).
    const result = decodeHtmlUrl('/sidebar/html/tkt/s/Users/me/../../etc/passwd')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ref.path).toBe('/Users/me/../../etc/passwd')
  })
})

describe('relative asset resolution stays in-route', () => {
  it('a relative reference against an encoded document URL keeps the ticket and session scope', () => {
    // WHATWG URL resolution drops the QUERY of a path-relative reference,
    // which is why the route is path-encoded: resolving ./style.css against
    // the document URL must land back on the same route with the same ticket
    // and session prefix. This is what makes the ticket work at all — the
    // previewed page never writes it, the browser carries it.
    const doc = encodeHtmlUrl(T, 'sess-1', '/Users/me/proj/index.html')
    const asset = new URL('./style.css', `http://h${doc}`).pathname
    expect(asset).toBe('/sidebar/html/tkt/sess-1/Users/me/proj/style.css')
    expect(decodeHtmlUrl(asset)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 'sess-1', path: '/Users/me/proj/style.css' },
    })
  })

  it('deeper and parent-relative references resolve inside the route', () => {
    const doc = `http://h${encodeHtmlUrl(T, 's', '/a/b/index.html')}`
    expect(new URL('img/x.png', doc).pathname).toBe('/sidebar/html/tkt/s/a/b/img/x.png')
    expect(new URL('../c.css', doc).pathname).toBe('/sidebar/html/tkt/s/a/c.css')
  })

  it('a root-relative reference escapes the route and is refused', () => {
    // '/style.css' resolves to the GUI root, not into the route. The page
    // gets a 404 from the prefix decoder rather than a file — the documented
    // limit of the previewer: relative references work, absolute ones do not.
    const doc = `http://h${encodeHtmlUrl(T, 's', '/a/b/index.html')}`
    const asset = new URL('/style.css', doc).pathname
    expect(asset).toBe('/style.css')
    expect(decodeHtmlUrl(asset).ok).toBe(false)
  })

  it('relative assets of a UNC document stay inside the same route', () => {
    // The WHATWG URL preserves the '//' marker during relative resolution,
    // so ./style.css lands back on the route with the UNC prefix intact.
    const doc = `http://h${encodeHtmlUrl(T, 's', '\\\\server\\share\\proj\\index.html')}`
    expect(new URL('./style.css', doc).pathname)
      .toBe('/sidebar/html/tkt/s//server/share/proj/style.css')
    expect(decodeHtmlUrl(new URL('./style.css', doc).pathname)).toEqual({
      ok: true,
      ref: { ticket: T, sessionId: 's', path: '//server/share/proj/style.css' },
    })
  })
})
