/** Package-owned remote Graph Worker invariants. @module @deepseek-ai/dsh-graph-worker-remote/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-worker-remote'
/** Cordis companion plugin name. */
export const name = 'graph-worker-remote-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']
/**
 * No runtime invariant: authenticated wire, journal, transfer, and Provider responses are validated at hostile or
 * durable inputs; this package owns no authoritative event relationship.
 */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
