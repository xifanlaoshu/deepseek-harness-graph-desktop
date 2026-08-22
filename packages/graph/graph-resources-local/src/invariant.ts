/** Package-owned local Graph resource invariants. @module @deepseek-ai/dsh-graph-resources-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-resources-local'
/** Cordis companion plugin name. */
export const name = 'graph-resources-local-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: the Provider validates every route and fenced reservation transition synchronously. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
