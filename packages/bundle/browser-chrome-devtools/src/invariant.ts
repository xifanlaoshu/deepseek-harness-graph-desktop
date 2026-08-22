/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-browser-chrome-devtools`.
 * @module @deepseek-ai/dsh-browser-chrome-devtools/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-browser-chrome-devtools'

/** Cordis companion plugin name. */
export const name = 'browser-chrome-devtools-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// The wrapper owns no mutable relation: Cordis disposes its prompt registration
// and MCP child with the fiber, while their registries own the corresponding
// runtime invariants.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
