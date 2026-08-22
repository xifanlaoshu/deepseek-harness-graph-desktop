// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { GraphProjection } from '@deepseek-ai/dsh-graph/client'
import {
  GraphChildAction,
  graphAttemptLocation,
  type GraphChildActionProps,
} from '../src/client/GraphChildAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const projection = {
  config: { active: true },
  graphs: {
    g1: [{
      graphId: 'g1',
      revision: 2,
      nodes: [{ id: 'build', title: 'Build feature', roleId: 'engineer' }],
    }],
  },
  runs: {
    run1: {
      id: 'run1',
      graphId: 'g1',
      revision: 2,
      generation: 3,
      configSnapshot: {
        roles: [{ id: 'engineer', label: 'Engineer', model: { model: 'coder', reasoningEffort: 'medium' } }],
      },
      overrides: {},
      nodes: {
        build: {
          nodeId: 'build',
          phase: 'running',
          attempts: [{
            id: 'attempt-2',
            number: 2,
            startedAt: 20,
            childSessionId: 'child-primary',
            continuationSessionIds: ['child-continuation'],
          }],
        },
      },
    },
  },
} as unknown as GraphProjection

const t: GraphChildActionProps['t'] = makeTranslate(zh, commonZh)

describe('GraphChildAction', () => {
  it('finds primary and continuation sessions and rejects unrelated children', () => {
    expect(graphAttemptLocation(projection, 'child-primary')?.node.id).toBe('build')
    expect(graphAttemptLocation(projection, 'child-continuation')?.attempt.id).toBe('attempt-2')
    expect(graphAttemptLocation(projection, 'other')).toBeUndefined()
  })

  it('shows effective routing, opens the parent, and cancels through the exact attempt address', async () => {
    const parentGraph = createSnapshotStore<GraphProjection | undefined>(projection)
    const controlParent = vi.fn<(
      request: Readonly<Record<string, unknown>>,
    ) => Promise<string | null>>(() => Promise.resolve(null))
    const openParent = vi.fn()
    render(<GraphChildAction {...{
      childSessionId: 'child-primary',
      useParentGraph: bindSnapshotSelector(parentGraph),
      controlParent,
      openParent,
      t,
    } as unknown as GraphChildActionProps} />)

    fireEvent.click(screen.getByRole('button', { name: zh['child.trigger'] }))
    expect(screen.getByText('Engineer · coder · 推理强度 medium')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['child.openParent'] }))
    expect(openParent).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh['control.cancelNode'] }))
    await waitFor(() => { expect(controlParent).toHaveBeenCalledTimes(1) })
    expect(controlParent.mock.calls[0]?.[0]).toMatchObject({
      action: 'cancel-node',
      graphId: 'g1',
      runId: 'run1',
      nodeId: 'build',
      expectedRevision: 2,
      expectedGeneration: 3,
      expectedAttemptId: 'attempt-2',
    })
  })

  it('stays absent for a non-Graph child session', () => {
    const parentGraph = createSnapshotStore<GraphProjection | undefined>(projection)
    const { container } = render(<GraphChildAction {...{
      childSessionId: 'other',
      useParentGraph: bindSnapshotSelector(parentGraph),
      controlParent: () => Promise.resolve(null),
      openParent: () => {},
      t,
    } as unknown as GraphChildActionProps} />)
    expect(container.innerHTML).toBe('')
  })
})
