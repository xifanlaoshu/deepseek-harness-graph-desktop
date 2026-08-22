/** Package-owned SQLite Graph scheduler invariants. @module @deepseek-ai/dsh-graph-scheduler-sqlite/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-scheduler-sqlite'
/** Cordis companion plugin name. */
export const name = 'graph-scheduler-sqlite-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: SQLite transactions validate every ownership transition. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
