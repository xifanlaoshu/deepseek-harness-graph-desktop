/** Read the release identity embedded by electron-builder. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePackagedDesktopIdentity } from '../scripts/desktop-identity-environment.mjs'

/**
 * Read the Desktop identity packaged in the application manifest.
 * @param appPath - Electron application directory.
 * @returns Validated product, protocol, and optional user-data directory settings.
 */
export function readDesktopIdentity(appPath: string): ReturnType<typeof resolvePackagedDesktopIdentity> {
  const metadata: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
  return resolvePackagedDesktopIdentity(metadata)
}
