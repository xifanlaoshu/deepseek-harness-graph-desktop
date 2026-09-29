/** Resolve release identity settings embedded in the packaged application manifest. */
export function resolveDesktopIdentityEnvironment(env: NodeJS.ProcessEnv, appId?: string): {
  productName: string
  protocolScheme: string
  userDataDirectoryName?: string
}

/** Read embedded release identity fields, using upstream defaults for development manifests. */
export function resolvePackagedDesktopIdentity(metadata: unknown): {
  appId: string
  productName: string
  protocolScheme: string
  userDataDirectoryName?: string
}

/** Select an isolated DSH home for a fork only when the user has not configured one. */
export function resolveForkHarnessHome(appId: string, configuredHome: string | undefined, appDataDirectory: string): string | undefined
