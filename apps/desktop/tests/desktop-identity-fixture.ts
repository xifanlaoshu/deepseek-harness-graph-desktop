/** Isolated release identities for packaging tests that do not register real applications. */

/**
 * Supply explicit fork identifiers for a synthetic release environment.
 * @param appId - Reverse-DNS identifier owned by the test fixture.
 * @returns Public identity fields that remain separate from the official Desktop application.
 */
export function forkIdentityEnvironment(appId: string) {
  return {
    DSH_DESKTOP_APP_ID: appId,
    DSH_DESKTOP_PRODUCT_NAME: 'Fixture Fork',
    DSH_DESKTOP_PROTOCOL_SCHEME: 'dshfixture',
    DSH_DESKTOP_USER_DATA_DIR_NAME: 'DSH-Fixture',
  }
}
