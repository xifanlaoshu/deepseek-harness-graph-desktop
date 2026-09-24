/** Preserve V4 events while advancing the Session writer generation. */

import { defineSessionFormatMigration, isSessionFormatJsonObject, SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatMigrationStage } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

/** V4 event bodies remain unchanged; the target accepts the Graph message source. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage(input): SessionFormatMigrationStage {
    let inheritedCut = input.sourceHeader.isSeeded ? undefined : 0
    return {
      ...(input.sourceInheritedEventCount === undefined ? {} : { headerInheritedEventCount: input.sourceInheritedEventCount }),
      transformEvent(event, context) {
        if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
          inheritedCut = event.seq
        }
        context.emitEvent(event)
      },
      transformRun(run, context) { context.emitRun(run) },
      finish() {
        if (inheritedCut === undefined) throw new SessionFormatError('seeded format v4 Session lacks inherited end-seed marker')
        if (input.sourceInheritedEventCount !== undefined && input.sourceInheritedEventCount !== inheritedCut) {
          throw new SessionFormatError('format v4 inherited cut disagrees with its source marker')
        }
        return inheritedCut
      },
    }
  },
  validateTargetHeader: assertReleasedV5Header,
})
