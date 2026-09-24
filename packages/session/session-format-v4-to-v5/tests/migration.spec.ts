import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header, assertReleasedV5Relationships, assertV5RowAdmission, releasedV5SessionFormatCodec, restoreReleasedV5Artifact, sessionFormatV4ToV5 } from '../src/index.ts'

const source: SessionFormatHeader = { version: 4, id: 'session-v5', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const event: SessionFormatEvent = { type: 'feedback/record', seq: 0, time: 2, data: { text: 'preserved' } }

describe('V4 to V5 migration', () => {
  it('changes only the header version and retains event identity', () => {
    const header = sessionFormatV4ToV5.migrateHeader(source)
    expect(header).toEqual({ ...source, version: 5 })
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader: source, targetHeader: header, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
    const collector = new SessionFormatEventCollector()
    stage.transformEvent(event, collector)
    expect(collector.values).toEqual([event])
    expect(stage.finish(collector)).toBe(0)
  })

  it('forwards a compact run without expanding its event payloads', () => {
    const header = sessionFormatV4ToV5.migrateHeader(source)
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader: source, targetHeader: header, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
    const run = { runType: 'text-chunks', firstSeq: 0, eventCount: 2, *expand(): Iterable<SessionFormatEvent> { throw new Error('run expanded') } }
    let forwarded = false
    stage.transformRun(run, { emitEvent() { throw new Error('unexpected event') }, emitRun(value) { expect(value).toBe(run); forwarded = true } })
    expect(forwarded).toBe(true)
  })

  it('retains the last inherited cut for seeded Sessions', () => {
    const seeded = { ...source, isSeeded: true }
    const header = sessionFormatV4ToV5.migrateHeader(seeded)
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader: seeded, targetHeader: header, sourceInheritedEventCount: undefined, sourceKind: 'decoded' })
    const collector = new SessionFormatEventCollector()
    stage.transformEvent(event, collector)
    stage.transformEvent({ type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }, collector)
    expect(stage.finish(collector)).toBe(1)
    expect(collector.values).toHaveLength(2)
  })

  it('rejects missing seeded cuts and inconsistent known cuts', () => {
    const seeded = { ...source, isSeeded: true }
    const header = sessionFormatV4ToV5.migrateHeader(seeded)
    const missing = sessionFormatV4ToV5.createStage({ sourceHeader: seeded, targetHeader: header, sourceInheritedEventCount: undefined, sourceKind: 'decoded' })
    const collector = new SessionFormatEventCollector()
    expect(() => missing.finish(collector)).toThrow('lacks inherited end-seed marker')
    const mismatch = sessionFormatV4ToV5.createStage({ sourceHeader: source, targetHeader: sessionFormatV4ToV5.migrateHeader(source), sourceInheritedEventCount: 1, sourceKind: 'decoded' })
    expect(() => mismatch.finish(collector)).toThrow('inherited cut disagrees')
  })
})

describe('native V5 admission', () => {
  const header = { ...source, version: 5 }

  it('round-trips the header and refuses a malformed header', () => {
    const encoded = releasedV5SessionFormatCodec.encodeHeader(header, 0)
    expect(releasedV5SessionFormatCodec.decodeHeader(encoded)).toEqual(header)
    expect(() => { assertReleasedV5Header({ ...header, extra: true }) }).toThrow('unexpected field')
    expect(() => { assertReleasedV5Header(null) }).toThrow('expected format v5 header')
    expect(() => releasedV5SessionFormatCodec.decodeHeader({ ...encoded, version: 4 })).toThrow('expected format v5 physical header')
  })

  it('reuses V4 event framing and row admission for a V5 decoder', () => {
    const physical = releasedV5SessionFormatCodec.encodeHeader(header, 0)
    const row = releasedV5SessionFormatCodec.encodeEvent(event)
    const output = new SessionFormatEventCollector()
    const decoder = releasedV5SessionFormatCodec.createDecoder(physical, 'strict')
    expect(decoder.header).toEqual(header)
    decoder.decodeRow(row, output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([event])
    expect(() => { assertV5RowAdmission(row) }).not.toThrow()
    expect(() => { assertV5RowAdmission({ type: 'tool/result', seq: 0, time: 1, data: { message: { role: 'user' } } }) }).toThrow('first-class message')
  })

  it('restores a Graph-owned message without changing its source attribution', () => {
    const graphMessage: SessionFormatEvent = {
      type: 'user/message', seq: 0, time: 2, surfaceOp: 'append',
      data: { id: 'graph-user', role: 'user', source: { kind: 'graph-mode' }, content: [{ type: 'text', text: 'Continue the graph.' }] },
    }
    const artifact: SessionFormatArtifact = { header, inheritedEventCount: 0, events: [graphMessage] }
    expect(restoreReleasedV5Artifact(artifact, new Set(['user/message']))).toBe(artifact)
    expect(() => { assertReleasedV5Relationships(artifact, new Set(['user/message'])) }).not.toThrow()
    expect(artifact.events[0]).toBe(graphMessage)
  })

  it('checks V5 delivery sequence and Session ownership', () => {
    const delivery = (sessionId: string, throughSeq: number): SessionFormatArtifact => ({
      header, inheritedEventCount: 0,
      events: [event, { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3, data: { sessionFormatVersion: 5, sessionId, throughSeq } }],
    })
    const known = new Set(['feedback/record', 'session-log-deepseek/delivery-accepted'])
    expect(restoreReleasedV5Artifact(delivery(header.id, 0), known).events).toHaveLength(2)
    expect(() => restoreReleasedV5Artifact(delivery('other', 0), known)).toThrow('wrong Session')
    expect(() => restoreReleasedV5Artifact(delivery(header.id, 1), known)).toThrow('must precede')
    expect(() => restoreReleasedV5Artifact(delivery('', 0), known)).toThrow('nonempty')
    expect(() => restoreReleasedV5Artifact({ ...delivery(header.id, 0), events: [event, {
      ...delivery(header.id, 0).events[1] as SessionFormatEvent, data: null,
    }] }, known)).toThrow('data must be an object')
    expect(restoreReleasedV5Artifact({ ...delivery('foreign', 0), events: [event, {
      ...delivery('foreign', 0).events[1] as SessionFormatEvent,
      ignorable: true,
    }] }, new Set(['feedback/record'])).events).toHaveLength(2)
    const previous = { ...delivery(header.id, 0).events[1] as SessionFormatEvent, data: {
      sessionFormatVersion: 3, sessionId: 'foreign', throughSeq: 99,
    } }
    expect(restoreReleasedV5Artifact({ header, inheritedEventCount: 0, events: [event, previous] }, known).events[1]).toBe(previous)
  })

  it('accepts inherited foreign delivery but rejects it after the seed cut', () => {
    const seededHeader = { ...header, isSeeded: true, parentSession: 'ancestor' }
    const inherited: SessionFormatEvent = {
      type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3,
      data: { sessionFormatVersion: 5, sessionId: 'ancestor', throughSeq: 0 },
    }
    const marker: SessionFormatEvent = { type: 'session/end-seed', seq: 2, time: 4, data: { inherited: true } }
    const known = new Set(['feedback/record', inherited.type, marker.type])
    const artifact: SessionFormatArtifact = {
      header: seededHeader, inheritedEventCount: 2, events: [event, inherited, marker],
    }
    expect(restoreReleasedV5Artifact(artifact, known)).toBe(artifact)
    const local: SessionFormatEvent = {
      ...inherited, seq: 3, time: 5,
      data: { sessionFormatVersion: 5, sessionId: 'ancestor', throughSeq: 2 },
    }
    expect(() => restoreReleasedV5Artifact({ ...artifact, events: [...artifact.events, local] }, known)).toThrow('wrong Session')
  })
})
