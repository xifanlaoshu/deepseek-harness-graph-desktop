/** Package-owned LoopX graph-coordination invariants. @module @deepseek-ai/dsh-graph-coordination-loopx/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-coordination-loopx'
/** Cordis companion plugin name. */
export const name = 'graph-coordination-loopx-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: LoopX validates its own goal, todo, claim, and evidence state. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
