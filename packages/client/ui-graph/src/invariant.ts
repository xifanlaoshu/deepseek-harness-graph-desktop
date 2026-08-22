/** Package-owned invariant companion for the graph UI. @module @deepseek-ai/dsh-client-ui-graph/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-graph'
/** Cordis companion plugin name. */
export const name = 'client-ui-graph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: graph state is host-projected and slot teardown is covered by client tests. */
const install: InvariantInstaller = () => {}
/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
