/**
 * Pure URL policy for the built-in browser tab: normalize user input into
 * an http(s) URL, and refuse destinations that would be dangerous to embed
 * in the sidebar iframe. Kept dependency-free so it is unit-testable.
 *
 * The iframe sandbox (opaque origin, no allow-same-origin / top-navigation)
 * is the primary security boundary; this module is the address-bar gate on
 * top of it: only http/https may be navigated, and loopback addresses need
 * explicit user trust before they may load.
 * The GUI's OWN origin is explicitly ALLOWED — the user may open the GUI
 * itself in the sidebar (debugging, mirroring); the sandbox still renders
 * it in an opaque origin with no same-origin privileges, exactly like any
 * other site.
 */

/** Why a navigation attempt was refused. */
export type BrowserBlockReason = 'scheme' | 'loopback'

/** Result of normalizing one address-bar input. */
export type BrowserNavigateResult =
  | { kind: 'ok'; url: string }
  | { kind: 'blocked'; reason: 'scheme' }
  | { kind: 'blocked'; reason: 'loopback'; url: string; authority: string }
  | { kind: 'invalid' }
  /** A local filesystem path (typed bare, or as a `file:` URL): the caller
   *  resolves this through the HTML previewer route instead (html-route.ts),
   *  the same server-side workspace fence a file-tree double-click uses. */
  | { kind: 'local-file'; path: string }

/** One browser.probe wire result (host fetch of the target's headers). */
export interface BrowserProbeResult {
  reachable: boolean
  /** The final (post-redirect) URL; present when reachable. */
  url?: string
  status?: number
  xFrameOptions?: string
  /** The CSP frame-ancestors source list; present when the directive exists. */
  frameAncestors?: string[]
}

/** Embeddability verdict of one probe. */
export type Embeddability = 'embeddable' | 'blocked' | 'unknown'

/**
 * Decide whether a site can render inside the sidebar iframe. The signals
 * are exactly the ones the BROWSER enforces when it refuses an iframe load:
 * X-Frame-Options DENY/SAMEORIGIN, or a frame-ancestors directive that does
 * not allow `*` ('self' here means the SITE's own origin — never ours, so
 * it also blocks the sidebar). A site we could not reach yields 'unknown'
 * and the plain iframe stays.
 */
export function embeddabilityOf(probe: BrowserProbeResult): Embeddability {
  if (probe.reachable !== true) return 'unknown'
  const xfo = probe.xFrameOptions?.trim().toUpperCase()
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return 'blocked'
  if (probe.frameAncestors !== undefined && !probe.frameAncestors.some(source => source === '*')) return 'blocked'
  return 'embeddable'
}

/** A loopback hostname (localhost, IPv6 ::1, 127.0.0.0/8, 0.0.0.0). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Normalize one address-bar input against the navigation policy.
 * @param input - raw user text.
 * @param selfOrigin - the GUI's own origin (window.location.origin). The GUI
 * itself may be browsed in the sidebar (the sandbox keeps it opaque), so it
 * is let through BEFORE the loopback check — its host is normally loopback.
 * @param allowedLoopback - comma-separated loopback allowlist from the side
 * card prefs (`browserAllowedLoopback`): bare hosts (`localhost`,
 * `127.0.0.1`) allow every port, `host:port` entries allow exactly that
 * authority. Entries are matched case-insensitively; portless entries match
 * the host on any port. Empty allowlist keeps the default loopback block.
 */
/** Schemes that must never reach the iframe, even without `//` (javascript:,
 *  data:, file:, ...). Host:port lookalikes (example.com:8080) are NOT here —
 *  they parse as hosts below. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript', 'data', 'file', 'about', 'vbscript', 'blob',
  'mailto', 'tel', 'ftp', 'ftps', 'ws', 'wss', 'sftp', 'ssh',
  'chrome', 'chrome-extension', 'moz-extension', 'edge', 'opera', 'resource', 'view-source',
])

/** A POSIX absolute path (single leading slash; a double slash is the UNC
 *  marker below, not a plain absolute path). */
const POSIX_ABSOLUTE_PATH = /^\/(?!\/)/
/** A Windows drive path (`C:\...` or `C:/...`). */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/
/** A UNC path (`\\server\share\...` or `//server/share/...`). */
const UNC_PATH = /^[\\/]{2}[^\\/]/

/**
 * The filesystem path an address-bar input names, in the form
 * html-route.ts's `encodeHtmlUrl` expects (leading slash for POSIX, bare
 * drive letter for Windows, `//`/`\\` prefix for UNC) — or undefined when
 * the input is not a local path at all. Recognizes both a path typed bare
 * (no scheme parses, or a Windows drive letter that LOOKS like a scheme) and
 * an explicit `file:` URL.
 */
function localFilePathOf(trimmed: string): string | undefined {
  if (POSIX_ABSOLUTE_PATH.test(trimmed) || WINDOWS_DRIVE_PATH.test(trimmed) || UNC_PATH.test(trimmed)) {
    return trimmed
  }
  if (!/^file:/i.test(trimmed)) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'file:') return undefined
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return undefined
  }
  // file:///C:/Users/... parses to pathname "/C:/Users/...": drop the
  // leading slash so the drive letter rides bare, as encodeHtmlUrl expects.
  return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/** The exact allowlist authority for a loopback URL, including default ports. */
export function loopbackAuthorityOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!isLoopbackHostname(parsed.hostname)) return undefined
  const host = normalizedHostname(parsed.hostname)
  const printableHost = host.includes(':') ? `[${host}]` : host
  return `${printableHost}:${effectivePort(parsed)}`
}

/** Whether a parsed or raw URL points at this machine's loopback interface. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Parse the loopback allowlist into a matcher predicate over host and port. */
export function parseLoopbackAllowlist(allowlist: string): (host: string, port: string) => boolean {
  const entries = allowlist.split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '')
  const exact = new Set<string>()
  const hosts = new Set<string>()
  for (const entry of entries) {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    const hostAndPort = /^([^:]+):(\d+)$/.exec(entry)
    const host = normalizedHostname(bracketed?.[1] ?? hostAndPort?.[1] ?? entry)
    const port = bracketed?.[2] ?? hostAndPort?.[2]
    if (!isLoopbackHostname(host)) continue
    if (port === undefined) hosts.add(host)
    else if (Number(port) >= 1 && Number(port) <= 65_535) exact.add(`${host}:${Number(port)}`)
  }
  return (host, port) => {
    const normalizedHost = normalizedHostname(host)
    return exact.has(`${normalizedHost}:${port}`) || hosts.has(normalizedHost)
  }
}

/**
 * Whether a loopback URL is explicitly allowlisted by the side card prefs
 * (`browserAllowedLoopback`). Only allowlisted local addresses may run with
 * `allow-same-origin` in the sidebar iframe — needed for local dev servers
 * (Vite etc.) whose module/HMR/fetch pipeline requires a real origin, while
 * the page stays cross-origin to the GUI and to every other site.
 */
export function isAllowedLoopbackUrl(url: string, allowlist: string): boolean {
  if (allowlist.trim() === '') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!isLoopbackHostname(parsed.hostname)) return false
  return parseLoopbackAllowlist(allowlist)(parsed.hostname, effectivePort(parsed))
}

/** Add one loopback URL's exact authority to the persisted allowlist. */
export function addAllowedLoopbackUrl(allowlist: string, url: string): string {
  const authority = loopbackAuthorityOf(url)
  if (authority === undefined || isAllowedLoopbackUrl(url, allowlist)) return allowlist.trim()
  const entries = allowlist.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  return [...entries, authority].join(', ')
}

export function normalizeBrowserUrl(input: string, selfOrigin: string, allowedLoopback = ''): BrowserNavigateResult {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'invalid' }
  // A local path, bare or as a file: URL, is caught before scheme handling:
  // a Windows drive letter ("C:\...") parses as an unknown scheme below, and
  // file: is a FORBIDDEN_SCHEMES entry that would otherwise be blocked.
  const localPath = localFilePathOf(trimmed)
  if (localPath !== undefined) return { kind: 'local-file', path: localPath }
  // Distinguish an explicit scheme from a bare host:port. "example.com:8080"
  // would match a naive scheme regex (dots are legal in schemes), so a
  // scheme prefix is only honored when it is http(s) or a known-forbidden
  // scheme; anything else is treated as a host and gets https://.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  let withScheme: string
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme === 'http' || scheme === 'https') withScheme = trimmed
    else if (FORBIDDEN_SCHEMES.has(scheme)) return { kind: 'blocked', reason: 'scheme' }
    else {
      // A bare host with a port looks like an unknown scheme. Local dev
      // servers normally speak plain HTTP, so loopback shorthand gets HTTP.
      const localCandidate = `http://${trimmed}`
      withScheme = isLoopbackUrl(localCandidate) ? localCandidate : `https://${trimmed}`
    }
  } else {
    const localCandidate = `http://${trimmed}`
    withScheme = isLoopbackUrl(localCandidate) ? localCandidate : `https://${trimmed}`
  }
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { kind: 'invalid' }
  }
  // The protocol backstop: any URL that still parses to a non-http(s)
  // scheme (e.g. ftp://, ws:// — which carry `//` and skip the list) is
  // refused here.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'scheme' }
  // The GUI's own origin is ALLOWED (the user may browse the GUI itself in
  // the sidebar; the sandbox renders it in an opaque origin like any other
  // site). It must be checked before the loopback gate because its host is
  // normally loopback.
  try {
    if (url.origin === new URL(selfOrigin).origin) return { kind: 'ok', url: url.href }
  } catch {
    // Unparsable selfOrigin (never in practice): fall through to the loopback gate.
  }
  if (isLoopbackHostname(url.hostname)) {
    // An explicit user allowlist (browserAllowedLoopback) can lift the
    // loopback block for trusted local dev servers. They receive their own
    // origin but remain cross-origin to the GUI.
    if (isAllowedLoopbackUrl(url.href, allowedLoopback)) {
      return { kind: 'ok', url: url.href }
    }
    return {
      kind: 'blocked',
      reason: 'loopback',
      url: url.href,
      authority: loopbackAuthorityOf(url.href)!,
    }
  }
  return { kind: 'ok', url: url.href }
}
