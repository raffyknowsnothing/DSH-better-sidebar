/**
 * One guard over the host's optional session-persistence face.
 *
 * The face is structural and optional, and hosts have shipped it in more than
 * one shape. DSH Desktop mounts a `sessionPersistence` value that carries no
 * `inspect` method at all, so every call site that checked only for
 * `undefined` threw a raw `persistence.inspect is not a function` — surfaced
 * to the user as an opaque `internal` error from whichever route happened to
 * need a cold session's metadata.
 *
 * Checking the method rather than the service is the difference between a
 * feature degrading and a request failing. Callers that can live without the
 * answer fall back; callers that cannot report the service as unavailable,
 * which is the truth.
 */
import type { Context, SidebarSessionPersistenceService } from './context-types.ts'

/**
 * The persistence face, or undefined when this host cannot answer a lookup.
 * @param ctx - host plugin context.
 * @returns a face whose `inspect` is callable, never a partial one.
 */
export function usablePersistence(ctx: Context): SidebarSessionPersistenceService | undefined {
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined || typeof persistence.inspect !== 'function') return undefined
  return persistence
}
