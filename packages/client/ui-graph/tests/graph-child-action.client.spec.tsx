// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  GraphAttemptId,
  GraphId,
  GraphNodeId,
  GraphRoleId,
  GraphRunGenerationId,
  GraphRunId,
  GraphWorkId,
  type GraphProjection,
} from '@deepseek-ai/dsh-graph/client'
import { defaultGraphModeConfig, defaultGraphNodeExecutionBudget } from '@deepseek-ai/dsh-graph'
import {
  GraphChildAction,
  graphAttemptLocation,
  type GraphChildActionProps,
} from '../src/client/GraphChildAction.tsx'
import { zh } from '../src/client/locales.ts'
import { graphGlobalStandardProps, graphSessionStandardProps } from './slot-standard-props.client.ts'

afterEach(cleanup)

const defaultConfig = defaultGraphModeConfig()
const config = {
  ...defaultConfig,
  active: true,
  roles: defaultConfig.roles.map(role => role.id === GraphRoleId('engineer')
    ? { ...role, model: { provider: 'local', model: 'coder', reasoningEffort: 'medium' } }
    : role),
}
const graphId = GraphId('g1')
const buildId = GraphNodeId('build')
const projection = {
  config,
  graphs: {
    g1: [{
      graphId,
      revision: 2,
      objective: 'Build feature',
      createdAt: 1,
      userInput: 'Build feature',
      nodes: [{
        id: buildId,
        title: 'Build feature',
        objective: 'Build feature',
        kind: 'implementation',
        roleId: GraphRoleId('engineer'),
        acceptanceCriteria: ['Feature works'],
        outputSchema: { id: 'graph-node-output', version: 1, maxBytes: 4096, schema: { type: 'object' } },
        maxAttempts: 2,
        weight: 1,
        executionBudget: defaultGraphNodeExecutionBudget(config.executionPolicy),
        skippable: false,
        effectPolicy: 'idempotent',
      }],
      edges: [],
      branchGroups: [],
      terminationPolicy: { ...config.executionPolicy, onExhausted: 'failed' },
    }],
  },
  runs: {
    run1: {
      id: GraphRunId('run1'),
      graphId,
      revision: 2,
      generation: 3,
      generationId: GraphRunGenerationId('run1-generation-3'),
      ownerEpoch: 1,
      configSnapshot: config,
      overrides: {},
      phase: 'running',
      createdAt: 1,
      updatedAt: 2,
      nodes: {
        build: {
          workId: GraphWorkId('run1-build'),
          nodeId: buildId,
          phase: 'running',
          attempts: [{
            id: GraphAttemptId('attempt-2'),
            number: 2,
            startedAt: 20,
            childSessionId: 'child-primary',
            continuationSessionIds: ['child-continuation'],
          }],
        },
      },
    },
  },
  operations: {},
  settlements: {},
  submissions: {},
  checkpoints: {},
  controls: {},
  campaigns: {},
} satisfies GraphProjection

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
      ...graphGlobalStandardProps(),
      ...graphSessionStandardProps(),
      childSessionId: 'child-primary',
      useParentGraph: bindSnapshotSelector(parentGraph),
      controlParent,
      openParent,
      t,
    } satisfies GraphChildActionProps} />)

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
      ...graphGlobalStandardProps(),
      ...graphSessionStandardProps(),
      childSessionId: 'other',
      useParentGraph: bindSnapshotSelector(parentGraph),
      controlParent: () => Promise.resolve(null),
      openParent: () => {},
      t,
    } satisfies GraphChildActionProps} />)
    expect(container.innerHTML).toBe('')
  })
})
