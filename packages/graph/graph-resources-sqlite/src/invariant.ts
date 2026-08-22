/** Package-owned SQLite Graph resource invariants. @module @deepseek-ai/dsh-graph-resources-sqlite/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-resources-sqlite'
/** Cordis companion plugin name. */
export const name = 'graph-resources-sqlite-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: SQLite transactions validate every reservation and fenced terminal transition. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
