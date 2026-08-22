/** Package-owned Graph Artifact invariants. @module @deepseek-ai/dsh-graph-artifacts/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-artifacts'
/** Cordis companion plugin name. */
export const name = 'graph-artifacts-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: manifests are validated synchronously at every artifact service operation. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
