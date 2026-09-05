/**
 * Pure URL vocabulary of the /sidebar/html route (HTML previewer).
 *
 * Why path-encoded parameters instead of a query string: the previewed
 * page resolves its relative assets (./style.css, img/x.png) against the
 * document URL, and the WHATWG URL algorithm DROPS the query of a
 * path-relative reference — `/sidebar/html?a=1&path=/a/b/` + `./style.css`
 * would lose the session scope and the route would reject the asset.
 * Encoding everything into the URL path keeps relative resolution inside
 * the same route with every request self-contained:
 *
 *   /sidebar/html/<ticket>/<sessionId>/<absolute-path segments, encodeURIComponent'd>
 *   /sidebar/html/T/S/Users/me/proj/index.html
 *     + ./style.css → /sidebar/html/T/S/Users/me/proj/style.css
 *   Windows: C:\Users\me\a.html → /sidebar/html/T/S/C%3A/Users/me/a.html
 *   UNC (\\server\share\... or //server/share/...):
 *     → /sidebar/html/T/S//server/share/proj/a.html  ('//' right after the
 *       sessionId marks the UNC prefix; the WHATWG URL keeps '//' intact so
 *       relative assets still resolve inside the same route)
 *
 * The leading ticket segment is the route's proof of origin (html-ticket.ts).
 * It rides in the path for the same reason the rest does: a relative asset
 * must carry it without the page knowing it exists.
 *
 * The decoder rebuilds the marker as a forward-slash `//server/share/...`
 * path. That form is intentionally platform-neutral: `node:path` resolves it
 * to `\\server\share\...` on win32 and `/server/share/...` on POSIX, so the
 * host's existing requireAbsolute + isWithin fence needs no platform signal
 * (a leading `//` is a legal POSIX absolute path, so no data is lost on
 * either platform).
 *
 * This module is intentionally dependency-free (no node imports, no wire
 * helpers) so the client bundle can import `encodeHtmlUrl` without tripping
 * the build-time purity gate; the host converts decode failures into
 * SidebarError responses at the route boundary.
 */

/** One decoded route reference. */
export interface HtmlRouteRef {
  /** The preview ticket the URL carried; the host validates it (html-ticket.ts). */
  ticket: string
  /**
   * Whether the response must carry the CSP `sandbox` directive. The client
   * asks for this per preview, because the user can turn the sandbox off
   * (side card `htmlViewerNoSandbox`, or the status row's temporary unlock)
   * and only the client knows the current state of either. The iframe's own
   * `sandbox` attribute cannot express it alone: the header re-imposes an
   * opaque origin no matter what the attribute says, which is why turning the
   * sandbox off used to change nothing at all.
   */
  sandboxed: boolean
  sessionId: string
  /** Absolute file path (leading slash; Windows drives keep their colon). */
  path: string
}

/** Decode outcome: the reference, or a client-error description. */
export type HtmlDecodeResult =
  | { ok: true; ref: HtmlRouteRef }
  | { ok: false; status: 400 | 404; message: string }

/** The route prefix both encoders/decoders agree on. */
export const HTML_ROUTE_PREFIX = '/sidebar/html/'

/**
 * The sandbox-mode segment. It rides the path for the same reason everything
 * else does: a relative asset must resolve back onto a URL that still asks
 * for the same mode, or the page's own stylesheet would come back under a
 * different origin policy than the document.
 */
const SANDBOXED_SEGMENT = 's'
const UNSANDBOXED_SEGMENT = 'u'

/**
 * Build the route URL for one absolute file path (client + tests).
 * @param sandboxed - false only when the user has turned the previewer's
 * sandbox off; the response then omits the CSP sandbox directive and the page
 * runs on the GUI's own origin, which is what that setting warns about.
 */
export function encodeHtmlUrl(ticket: string, sessionId: string, path: string, sandboxed = true): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  const segments = path.split(/[\\/]+/).filter(segment => segment !== '')
  const mode = sandboxed ? SANDBOXED_SEGMENT : UNSANDBOXED_SEGMENT
  return `${HTML_ROUTE_PREFIX}${encodeURIComponent(ticket)}/${mode}/${encodeURIComponent(sessionId)}/${unc ? '/' : ''}${segments.map(encodeURIComponent).join('/')}`
}

/**
 * Decode a route pathname into the ticket, sandbox mode, session and absolute
 * file path. Rejects a wrong prefix (404), an empty path, malformed percent
 * encoding, an unknown sandbox mode, and a missing ticket, sessionId or file
 * path (400). Decoding proves nothing on its own: the caller must still
 * validate the ticket against this run's value and bound the decoded path
 * with the workspace real-path guard — a decoded `..` segment resolves
 * outside the cwd and is refused there.
 *
 * The mode segment is rejected rather than defaulted. A URL that fails to
 * name a mode is a bug in the caller, and guessing would hand the previewed
 * page the wrong origin policy in whichever direction the default leans.
 */
export function decodeHtmlUrl(pathname: string): HtmlDecodeResult {
  if (!pathname.startsWith(HTML_ROUTE_PREFIX)) {
    return { ok: false, status: 404, message: 'not an html route' }
  }
  const rest = pathname.slice(HTML_ROUTE_PREFIX.length)
  if (rest === '') {
    return { ok: false, status: 400, message: 'invalid html route path' }
  }
  let segments: string[]
  try {
    segments = rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return { ok: false, status: 400, message: 'malformed URL encoding' }
  }
  const [ticket, mode, sessionId, ...pathSegments] = segments
  if (ticket === undefined || ticket === '') {
    return { ok: false, status: 400, message: 'ticket, sessionId and file path are required' }
  }
  if (mode !== SANDBOXED_SEGMENT && mode !== UNSANDBOXED_SEGMENT) {
    return { ok: false, status: 400, message: 'unknown sandbox mode' }
  }
  if (sessionId === undefined || sessionId === '') {
    return { ok: false, status: 400, message: 'ticket, sessionId and file path are required' }
  }
  // An empty FIRST path segment is the UNC marker (encodeHtmlUrl emits
  // '<sid>//server/share/...' for UNC paths); the encoder filters empty
  // segments everywhere else, so an empty segment can only be the marker or
  // a malformed URL — both handled here.
  const unc = pathSegments[0] === ''
  const tail = unc ? pathSegments.slice(1) : pathSegments
  if (tail.length === 0 || tail.some(segment => segment === '')) {
    return { ok: false, status: 400, message: 'ticket, sessionId and file path are required' }
  }
  let path: string
  if (unc) {
    // Rebuild the platform-neutral forward-slash form `//server/share/...`;
    // requireAbsolute() resolves it to the platform's own UNC/POSIX spelling.
    path = `//${tail.join('/')}`
  } else if (/^[A-Za-z]:$/.test(tail[0] ?? '')) {
    // A Windows drive segment ('D:') is the FIRST path segment of an encoded
    // drive path. Rejoining it with a leading slash would yield '/D:/work/...'
    // which node's path.resolve() mangles into 'D:\D:\work\...' on Windows —
    // the html route's workspace fence would then reject every drive path.
    // Keep the drive form slash-free so requireAbsolute() resolves it verbatim.
    path = tail.join('/')
  } else {
    path = `/${tail.join('/')}`
  }
  return { ok: true, ref: { ticket, sandboxed: mode === SANDBOXED_SEGMENT, sessionId, path } }
}
