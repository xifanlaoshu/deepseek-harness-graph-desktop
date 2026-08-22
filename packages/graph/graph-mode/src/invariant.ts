/** Package-owned graph-mode runtime invariants. @module @deepseek-ai/dsh-graph-mode/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-graph-mode'

/** Cordis companion plugin name. */
export const name = 'graph-mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: durable graph relationships are owned and checked by `@deepseek-ai/dsh-graph`. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}

/** Register the graph-mode invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
