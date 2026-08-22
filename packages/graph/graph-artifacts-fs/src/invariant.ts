/** Package-owned filesystem Graph Artifact invariants. @module @deepseek-ai/dsh-graph-artifacts-fs/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-graph-artifacts-fs'
/** Cordis companion plugin name. */
export const name = 'graph-artifacts-fs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
/** No runtime invariant: immutable blob and manifest bytes are verified at capture and materialization. */
const install: InvariantInstaller = (_ctx: Context, _fail: InvariantFailure): void => {}
/** Register the invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
