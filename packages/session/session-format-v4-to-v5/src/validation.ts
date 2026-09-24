/** V5 metadata, inherited events, and current-generation delivery ownership. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, assertReleasedV4Relationships, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Validate exact V5 header fields using the accepted V4 field vocabulary.
 * @param header - decoded or otherwise untrusted V5 header.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

/** Restore V5 events and validate delivery markers written by the V5 generation.
 * @param artifact - complete detached V5 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  restoreReleasedV4Artifact({ ...artifact, header: { ...artifact.header, version: 4 } }, knownEventTypes)
  assertV5DeliveryRelationships(artifact, knownEventTypes)
  return artifact
}

/** Validate relationships on a current V5 artifact already checked by its codec.
 * @param artifact - decoded V5 artifact with its inherited cut.
 * @param knownEventTypes - installed event types whose payloads the reader interprets.
 */
export function assertReleasedV5Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  assertReleasedV5Header(artifact.header)
  assertReleasedV4Relationships({ ...artifact, header: { ...artifact.header, version: 4 } }, knownEventTypes)
  assertV5DeliveryRelationships(artifact, knownEventTypes)
}

function assertV5DeliveryRelationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  for (const event of artifact.events) {
    if (event.type !== 'session-log-deepseek/delivery-accepted' || !knownEventTypes.has(event.type)) continue
    // Both callers first run V4 relationship validation, which requires object delivery data.
    const data = event.data as SessionFormatJsonObject
    if (data['sessionFormatVersion'] !== 5) continue
    const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
    if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
    const id = data['sessionId']
    if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
    if (!(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount) && id !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
  }
}
