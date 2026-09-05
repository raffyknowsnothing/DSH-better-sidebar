/**
 * The HTML preview route's proof of origin.
 *
 * Why the route cannot use the browser-marker fence: it serves its document
 * under `Content-Security-Policy: sandbox` with no `allow-same-origin`, so
 * the previewed page lives in an OPAQUE origin. Everything that page then
 * asks for — its stylesheet, its images, a classic script, a module script,
 * a `fetch()`, its own `location.reload()` — reaches us as
 * `Sec-Fetch-Site: cross-site` with no `Origin` (or `Origin: null` for the
 * CORS-mode ones). A cross-site attacker page sends byte-identical markers.
 * No header can separate the two, so the marker fence either refuses the
 * preview's own assets (the bug: the frame reloads into a bare `forbidden`)
 * or admits every page in the user's browser.
 *
 * The ticket breaks the tie with a secret instead. One unguessable value is
 * minted per plugin run and handed to the sidebar client over the normal
 * fenced JSON route, which an attacker cannot read (it is same-origin only).
 * The client writes it into the preview URL as the FIRST path segment, so
 * the page's relative assets carry it automatically — the same reason the
 * route is path-encoded rather than query-encoded (see html-route.ts). The
 * route then keeps the Host fence (DNS-rebinding defense) and trusts the
 * ticket in place of the markers.
 *
 * The ticket authorizes reaching the route, nothing more. The session scope
 * and the workspace real-path guard still bound which file may be read.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Bytes of entropy per ticket (192 bits, base64url → 32 characters). */
const TICKET_BYTES = 24

/**
 * The ticket is per PROCESS, not per `apply()`.
 *
 * A per-apply ticket looks tidier and is wrong here. The plugin's routes are
 * registered through `ctx.effect`, and a profile with `patchReload: "live"`
 * re-applies the plugin whenever its patch changes; a host can also mount the
 * plugin more than once. Each of those rotates a per-apply ticket, while an
 * already-loaded client page holds the one it fetched at mount — so every
 * preview 403s until the user reloads the page, with no way to tell that from
 * the original bug. Worse, if two instances are live at once, the instance
 * answering `html.ticket` need not be the one serving `/sidebar/html`, and
 * nothing works at all.
 *
 * One value per process makes re-apply, double-mount and live patch reload
 * all harmless. Restarting the host still rotates it, which is the only
 * rotation that matters: a ticket never leaves the machine.
 */
let processTicket: string | undefined

/** This process's preview ticket, minted on first use. */
export function htmlTicketOfProcess(): string {
  processTicket ??= randomBytes(TICKET_BYTES).toString('base64url')
  return processTicket
}

/**
 * Constant-time ticket comparison. A plain `===` on a secret leaks its
 * matching prefix through timing; the values are short and the route is
 * local, so this is cheap insurance rather than a live concern.
 * @param candidate - the value read out of the request URL.
 * @param ticket - this run's minted ticket.
 */
export function isValidHtmlTicket(candidate: string, ticket: string): boolean {
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(ticket, 'utf8')
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
