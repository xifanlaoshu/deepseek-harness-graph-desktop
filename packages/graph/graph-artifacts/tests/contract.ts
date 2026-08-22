/** Shared behavioral conformance suite for Graph artifact Providers. @module */

import { describe, expect, it } from 'vitest'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactRuntime,
} from '../src/index.ts'

/** Fresh assembled artifact Provider used by one conformance case. */
export interface GraphArtifactContractHarness {
  readonly runtime: GraphArtifactRuntime
  readonly providerName: string
  readonly capture: GraphArtifactCaptureRequest
  readonly targetRoot: string
  readonly dispose?: () => Promise<void> | void
}

/**
 * Run the Provider-neutral immutable capture, materialization, and recovery assertions.
 * @param label Provider label shown by the test runner.
 * @param create factory returning an isolated artifact Provider.
 */
export function runGraphArtifactProviderContract(
  label: string,
  create: () => Promise<GraphArtifactContractHarness>,
): void {
  describe(`graph artifact provider contract: ${label}`, () => {
    it('captures one immutable attempt manifest idempotently and materializes it completely', async () => {
      const harness = await create()
      try {
        const descriptor = harness.runtime.list().find(item => item.name === harness.providerName)
        expect(descriptor).toBeDefined()
        const first = await harness.runtime.capture(harness.providerName, harness.capture)
        await expect(harness.runtime.capture(harness.providerName, harness.capture)).resolves.toEqual(first)
        expect(first).toMatchObject({
          provider: harness.providerName,
          algorithm: 'sha256',
          workId: harness.capture.workId,
          operationId: harness.capture.operationId,
          attemptId: harness.capture.attemptId,
          runId: harness.capture.runId,
          generationId: harness.capture.generationId,
          ownerEpoch: harness.capture.ownerEpoch,
          fencingToken: harness.capture.fencingToken,
        })
        expect(first.entries.length).toBeGreaterThan(0)
        expect(first.entries.map(entry => entry.path)).toEqual(
          [...first.entries.map(entry => entry.path)].sort((left, right) => left.localeCompare(right)),
        )
        await expect(harness.runtime.materialize(harness.providerName, {
          manifest: first,
          targetRoot: harness.targetRoot,
          overwrite: 'forbid',
          signal: new AbortController().signal,
        })).resolves.toEqual({
          paths: first.entries.map(entry => entry.path),
          totalBytes: first.totalBytes,
        })
      } finally {
        await harness.dispose?.()
      }
    })

    it('retains referenced evidence and deletes only an exact unreferenced manifest', async () => {
      const harness = await create()
      try {
        const manifest = await harness.runtime.capture(harness.providerName, harness.capture)
        const base = {
          manifestId: manifest.id,
          providerReference: manifest.providerReference,
          signal: new AbortController().signal,
        }
        await expect(harness.runtime.reconcile(harness.providerName, { ...base, safeToDelete: false }))
          .resolves.toMatchObject({ status: 'retained' })
        await expect(harness.runtime.reconcile(harness.providerName, {
          ...base,
          providerReference: `${manifest.providerReference}:different`,
          safeToDelete: true,
        })).resolves.toMatchObject({ status: 'quarantined' })
        await expect(harness.runtime.reconcile(harness.providerName, { ...base, safeToDelete: true }))
          .resolves.toMatchObject({ status: 'deleted' })
        await expect(harness.runtime.reconcile(harness.providerName, { ...base, safeToDelete: true }))
          .resolves.toMatchObject({ status: 'absent' })
      } finally {
        await harness.dispose?.()
      }
    })
  })
}
