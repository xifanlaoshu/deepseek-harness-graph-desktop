/** Package-owned Graph scheduler invariants. @module @deepseek-ai/dsh-graph-scheduler/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-scheduler'
/** Cordis companion plugin name. */
export const name = 'graph-scheduler-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: every mutation validates the current lease identity and fencing token. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
