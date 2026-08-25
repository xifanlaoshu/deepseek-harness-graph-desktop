// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import cytoscape from 'cytoscape'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { GraphModeConfig, GraphProjection } from '@deepseek-ai/dsh-graph/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import {
  GraphAction,
  graphCanvasEdgeGeometry,
  graphCanvasNodeTypography,
  graphNodePoints,
  type GraphActionProps,
} from '../src/client/GraphAction.tsx'
import { graphRevisionLineageItems } from '../src/client/RevisionLineage.tsx'
import { cytoscapeColor } from '../src/client/cytoscapeColor.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t: GraphActionProps['t'] = makeTranslate(zh, commonZh)

const config = {
  version: 2,
  active: true,
  roles: [
    { id: 'controller', label: 'Controller', description: 'Controls work', controller: true, enabled: true, model: { provider: 'main', model: 'planner', reasoningEffort: 'high' }, prompt: 'Control work.', maxParallel: 1 },
    { id: 'engineer', label: 'Engineer', description: 'Implements work', controller: false, enabled: true, model: { provider: 'local', model: 'coder', reasoningEffort: 'medium' }, prompt: 'Implement work.', maxParallel: 2 },
  ],
  limits: { globalMaxParallel: 4, controllerReserve: 1, models: [{ provider: 'local', model: 'coder', maxParallel: 2 }, { provider: 'remote', model: 'other', maxParallel: 1 }] },
  executionPolicy: {
    maxNodesPerRevision: 64,
    maxAttemptsPerNode: 3,
    maxGraphRevisions: 32,
    maxRepairRevisions: 8,
    maxDynamicExpansions: 16,
    maxSubgraphDepth: 4,
    maxRuntimeContinuations: 16,
    maxOutputTokens: 16_384,
    maxReasoningOnlyTokens: 4_096,
    firstDurableActionMs: 120_000,
    maxNoDurableProgressMs: 300_000,
    checkpointIntervalMs: 180_000,
    maxWallTimeMs: 3_600_000,
    maxOutputBytes: 262_144,
    noProgressLimit: 3,
  },
} as unknown as GraphProjection['config']

const models: ModelDirectoryState = {
  current: { provider: 'main', model: 'planner' },
  routable: true,
  groups: [
    {
      id: 'main',
      name: 'Main',
      models: [{
        id: 'planner',
        name: 'Planner',
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }],
    },
    {
      id: 'local',
      name: 'Local',
      models: [{
        id: 'coder',
        name: 'Coder',
        reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' },
      }],
    },
    {
      id: 'remote',
      name: 'Remote',
      models: [{
        id: 'coder-v2',
        name: 'Coder V2',
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }],
    },
  ],
  failures: [],
  status: 'ready',
  error: null,
}

const revision = {
  graphId: 'g1', revision: 1, objective: 'Ship it', createdAt: 1, userInput: 'ship',
  nodes: [
    { id: 'a', title: 'Analyze', objective: 'Analyze', kind: 'analysis', roleId: 'controller', acceptanceCriteria: ['known'], outputSchema: { id: 'graph-node-output', version: 1, maxBytes: 4096, schema: { type: 'object' } }, maxAttempts: 1, weight: 1, skippable: false, effectPolicy: 'idempotent' },
    { id: 'b', title: 'Verify', objective: 'Verify', kind: 'verification', roleId: 'controller', acceptanceCriteria: ['passes'], outputSchema: { id: 'graph-node-output', version: 1, maxBytes: 4096, schema: { type: 'object' } }, maxAttempts: 1, weight: 1, skippable: false, effectPolicy: 'idempotent' },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'control' }],
  branchGroups: [],
  terminationPolicy: { ...config.executionPolicy, onExhausted: 'failed' },
} as unknown as GraphProjection['graphs'][string][number]

type TestProjection = Pick<GraphProjection, 'config' | 'graphs' | 'runs'> & Partial<GraphProjection>

function setup(
  projection: TestProjection | undefined,
  save: (config: GraphModeConfig) => Promise<string | null> = () => Promise.resolve(null),
  modelDirectory: ModelDirectoryState = models,
) {
  const complete = projection === undefined ? undefined : {
    operations: {}, settlements: {}, checkpoints: {}, controls: {}, ...projection,
  }
  const store = createSnapshotStore<{ value: TestProjection | undefined }>({ value: complete })
  const useProjection = (_key: string, selector?: (value: unknown) => unknown) => (
    bindSnapshotSelector(store)(state => (selector ?? (value => value))(state.value))
  )
  const saveConfig = vi.fn(save)
  const control = vi.fn((_request: Parameters<NonNullable<GraphActionProps['control']>>[0]) => Promise.resolve(null))
  const openSession = vi.fn()
  const modelStore = createSnapshotStore(modelDirectory)
  const useModels = bindSnapshotSelector(modelStore)
  const loadModels = vi.fn()
  const props = { useProjection, useModels, loadModels, saveConfig, control, openSession, t } as unknown as GraphActionProps
  const view = render(<GraphAction {...props} />)
  return { view, store, loadModels, saveConfig, control, openSession }
}

describe('GraphAction', () => {
  it('uses restrained node typography and smooth dependency curves', () => {
    expect(cytoscapeColor('#fff3')).toBe('rgba(255, 255, 255, 0.2)')
    expect(cytoscapeColor('#abc')).toBe('rgb(170, 187, 204)')
    expect(graphCanvasNodeTypography).toMatchObject({ 'font-size': 12, 'font-weight': 500 })
    expect(graphCanvasNodeTypography['font-family']).toContain('Microsoft YaHei UI')
    expect(graphCanvasEdgeGeometry).toEqual({
      width: 1.5,
      'curve-style': 'unbundled-bezier',
      'control-point-distance': 42,
      'control-point-weight': 0.5,
      'line-cap': 'round',
    })
  })

  it('stays absent until Graph Mode is active', () => {
    expect(setup(undefined).view.container.innerHTML).toBe('')
    cleanup()
    expect(setup({ config: { ...config, active: false }, graphs: {}, runs: {} }).view.container.innerHTML).toBe('')
  })

  it('offers executor reconciliation for every recoverable run phase', () => {
    const { control } = setup({
      config,
      graphs: { g1: [revision] },
      currentGraphId: 'g1',
      runs: {
        r1: {
          id: 'r1', graphId: 'g1', revision: 1, generation: 4, generationId: 'generation-4', ownerEpoch: 4,
          configSnapshot: config, overrides: {}, phase: 'running', createdAt: 1, updatedAt: 2,
          nodes: {
            a: { workId: 'work-a', nodeId: 'a', phase: 'running', attempts: [] },
            b: { workId: 'work-b', nodeId: 'b', phase: 'pending', attempts: [] },
          },
        },
      },
    } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    fireEvent.click(screen.getByRole('button', { name: zh['control.reconcile'] }))

    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      action: 'reconcile-run',
      graphId: 'g1',
      runId: 'r1',
      expectedRevision: 1,
      expectedGeneration: 4,
    }))
  })

  it('shows and closes the empty active panel before a graph exists', () => {
    setup({ config, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect(screen.getByText(zh.empty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()

    cleanup()
    setup({ config, graphs: {}, currentGraphId: 'missing', runs: {} } as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('switches between independent batch graphs from the campaign track', () => {
    const secondRevision = { ...revision, graphId: 'g2', revision: 2, objective: 'Verify release' }
    setup({
      config,
      graphs: { g1: [revision], g2: [secondRevision] },
      currentGraphId: 'g2',
      currentCampaignId: 'campaign-1',
      campaigns: {
        'campaign-1': {
          version: 1,
          id: 'campaign-1',
          objective: 'Accept the complete hospital workflow',
          createdAt: 1,
          updatedAt: 4,
          phase: 'running',
          activeBatchId: 'batch-2',
          planRevision: 2,
          planExtensions: [{
            revision: 2,
            createdAt: 3,
            reason: 'Inventory discovered diagnosis workflows.',
            addedBatchIds: ['batch-2'],
            sourceBatchId: 'batch-1',
            sourceRunId: 'r1',
            settlementIds: ['s1'],
          }],
          batches: [
            {
              id: 'batch-1', ordinal: 1, title: 'Customer workflows', objective: 'Accept customers',
              dependsOn: [], status: 'approved', graphId: 'g1',
              executions: [{ graphId: 'g1', revision: 1, runId: 'r1', status: 'succeeded', startedAt: 1, completedAt: 2, settlementIds: ['s1'], summary: 'Customer workflows passed.' }],
            },
            {
              id: 'batch-2', ordinal: 2, title: 'Diagnosis workflows', objective: 'Accept diagnoses',
              dependsOn: ['batch-1'], status: 'running', graphId: 'g2',
              executions: [{ graphId: 'g2', revision: 2, runId: 'r2', status: 'running', startedAt: 3, settlementIds: [] }],
            },
          ],
        },
      },
      runs: {},
    } as unknown as GraphProjection)

    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    expect(screen.getByText('任务 Campaign · 计划 p2')).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(zh.revisions).value).toBe('2')
    const appendedBatch = screen.getByRole('button', { name: /批次 2：Diagnosis workflows/ })
    expect(appendedBatch.getAttribute('aria-pressed')).toBe('true')
    expect(appendedBatch.textContent).toContain('p2')
    expect(appendedBatch.getAttribute('title')).toContain('Inventory discovered diagnosis workflows.')

    fireEvent.click(screen.getByRole('button', { name: /批次 1：Customer workflows/ }))
    expect(screen.getByLabelText<HTMLSelectElement>(zh.revisions).value).toBe('1')
    expect(screen.getByRole('button', { name: /批次 1：Customer workflows/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('renders typed revision lineage and derives runtime evidence without inventing unavailable metrics', () => {
    const latest = { ...revision, revision: 2, parentRevision: 1, objective: 'Repair checkout' } as unknown as typeof revision
    const run = {
      id: 'run-2', graphId: 'g1', revision: 2, generation: 1, generationId: 'generation-1', ownerEpoch: 1,
      configSnapshot: config, overrides: {}, phase: 'succeeded', createdAt: 2, updatedAt: 6,
      terminal: { outcome: 'succeeded', rule: 'complete', acceptedAt: 6 },
      nodes: {
        a: { workId: 'work-a', nodeId: 'a', phase: 'succeeded', attempts: [{
          id: 'attempt-a-1', number: 1, startedAt: 2, finishedAt: 3, childSessionId: 'child-a',
        }, {
          id: 'attempt-a', number: 2, startedAt: 2, finishedAt: 5, childSessionId: 'child-a',
          continuationSessionIds: ['child-a-2'],
          health: { status: 'active', startedAt: 2, estimatedReasoningTokens: 5, reasoningCharacters: 20, inputTokens: 100, outputTokens: 40, providerReasoningTokens: 12, toolCalls: 3, durableActions: 2, changedFileCount: 1, checkpointCount: 1 },
        }] },
        b: { workId: 'work-b', nodeId: 'b', phase: 'succeeded', attempts: [] },
      },
    } as unknown as GraphProjection['runs'][string]
    const projection = {
      config,
      graphs: { g1: [revision, latest] },
      currentGraphId: 'g1',
      runs: { 'run-2': run },
      operations: {}, settlements: {}, checkpoints: {}, campaigns: {},
      controls: { human: { graphId: 'g1', expectedRevision: 2, action: 'modify-task' } },
      submissions: {
        second: {
          graph: latest,
          requestedAt: 2,
          lineage: {
            version: 1, taskId: 'g1', kind: 'execution_correction', title: 'Repair checkout', objective: 'Repair checkout',
            reason: 'Review rejected checkout.', creator: 'controller', createdAt: 2,
            trigger: { source: 'review_rejection', summary: 'Checkout validation failed.', evidence: ['HTTP 500'] },
            relationships: [{ kind: 'corrects', graphId: 'g1', revision: 1, reason: 'Corrects failed checkout.' }],
            successCriteria: ['Checkout succeeds'],
            changes: { addedNodeIds: [], changedNodeIds: ['a'], removedNodeIds: [], preservedNodeIds: ['b'], invalidatedNodeIds: ['a', 'b'] },
          },
        },
      },
    } as unknown as GraphProjection
    const items = graphRevisionLineageItems(projection)
    expect(items[1]?.metrics).toMatchObject({
      subagentCount: 2,
      taskInteractions: 2,
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 12,
      toolCalls: 3,
      retries: 1,
      humanInteractions: 1,
    })
    expect(items[1]?.metrics.agentTurns).toBeUndefined()

    setup(projection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.revisions'] }))
    expect(screen.getAllByText('Repair checkout')).toHaveLength(2)
    expect(screen.getAllByText(zh['revision.kind.execution_correction'])).toHaveLength(2)
    expect(screen.getByText('Checkout validation failed.')).toBeTruthy()
    expect(screen.getByText('HTTP 500')).toBeTruthy()
    expect(screen.getByText(zh['revision.unavailable'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['revision.openDesign'] }))
    expect(screen.getByRole('tab', { name: zh['tab.design'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps one hundred revisions navigable through bounded expansion', () => {
    const revisions = Array.from({ length: 101 }, (_, index) => ({
      ...revision,
      revision: index + 1,
      createdAt: index + 1,
      ...index === 0 ? {} : { parentRevision: index },
    })) as unknown as GraphProjection['graphs'][string]
    setup({ config, graphs: { g1: revisions }, currentGraphId: 'g1', runs: {}, submissions: {} } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.revisions'] }))
    const list = screen.getByLabelText(zh['revision.listAria'])
    expect(list.querySelectorAll('button')).toHaveLength(21)
    fireEvent.click(screen.getByRole('button', { name: zh['revision.showAll'].replace('{count}', '101') }))
    expect(list.querySelectorAll('button')).toHaveLength(101)
  })

  it('lays out dependencies left-to-right and exposes node evidence', () => {
    const points = graphNodePoints(revision)
    const left = points.find(point => point.id === 'a')
    const right = points.find(point => point.id === 'b')
    expect(left?.x).toBeLessThan(right?.x ?? 0)
    graphNodePoints({
      ...revision,
      nodes: [...revision.nodes, { ...revision.nodes[1]!, id: 'c', title: 'Review' }],
      edges: [{ from: 'a', to: 'b', kind: 'control' }, { from: 'a', to: 'c', kind: 'control' }, { from: 'b', to: 'c', kind: 'control' }],
    } as unknown as typeof revision)
    const { openSession } = setup({
      config, graphs: { g1: [revision] }, currentGraphId: 'g1',
      runs: {
        old: { id: 'old', graphId: 'g1', revision: 1, phase: 'running', createdAt: 1, updatedAt: 1, nodes: { a: { nodeId: 'a', phase: 'pending', attempts: [] }, b: { nodeId: 'b', phase: 'pending', attempts: [] } } },
        r1: {
          id: 'r1', graphId: 'g1', revision: 1, generation: 1, generationId: 'generation-1', ownerEpoch: 4,
          configSnapshot: config, overrides: {}, phase: 'succeeded', createdAt: 2, updatedAt: 3,
          terminal: { outcome: 'succeeded', rule: 'all-required-nodes-settled', acceptedAt: 3 },
          nodes: {
            a: {
              workId: 'work-a', nodeId: 'a', phase: 'succeeded',
              output: { summary: 'done', coordinationSummary: 'safe progress', data: { verdict: 'ship' }, artifacts: ['report.md'] },
              attempts: [{
                id: 'try', number: 1, startedAt: 2, finishedAt: 3, childSessionId: 'child-1', loopxClaimId: 'todo-1',
                health: {
                  status: 'checkpointed', startedAt: 2, estimatedReasoningTokens: 120, reasoningCharacters: 480,
                  inputTokens: 1_000, outputTokens: 120, providerReasoningTokens: 100,
                  toolCalls: 2, durableActions: 1, changedFileCount: 1, checkpointCount: 1,
                },
                checkpoints: [{
                  workId: 'work-a', attemptId: 'try', activation: 0, sequence: 1, createdAt: 2,
                  completedCriteria: [], changedFiles: [{ path: 'src/a.ts', contentHash: 'sha256:abc' }],
                  verification: [], remainingWork: ['known'], nextAction: 'Verify the change.',
                }],
              }, {
                id: 'try-2', number: 2, startedAt: 4, finishedAt: 5, childSessionId: 'child-2',
              }],
            },
            b: { workId: 'work-b', nodeId: 'b', phase: 'succeeded', output: { summary: 'verified', artifacts: [] }, attempts: [] },
          },
        },
      },
      operations: {
        'work-a': [{
          version: 1, eventId: 'event-a', operationId: 'operation-a', workId: 'work-a', runId: 'r1',
          generationId: 'generation-1', graphId: 'g1', revision: 1, nodeId: 'a', ownerEpoch: 4,
          stage: 'terminal', at: 3, externalReferences: [{ kind: 'artifact', provider: 'fs', id: 'manifest-a' }],
          terminalOutcome: 'succeeded', detail: 'validated result accepted',
        }],
      },
      settlements: {
        'settlement-a': [{
          version: 2, id: 'settlement-a', attempt: 1, operationId: 'operation-a', workId: 'work-a', runId: 'r1',
          generationId: 'generation-1', ownerEpoch: 4, kind: 'coordination', outcome: 'confirmed', requestedAt: 2,
          completedAt: 3, evidence: 'LoopX accepted result',
        }],
      },
      checkpoints: {
        'checkpoint-a': {
          id: 'checkpoint-a', graphId: 'g1', revision: 1, runId: 'r1', nodeId: 'a', kind: 'planning',
          status: 'resolved', createdAt: 2, resolvedAt: 3, iteration: 1, reason: 'architecture reviewed',
        },
      },
    } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    expect(screen.getAllByRole('button', { name: zh['canvas.fit'] })).toHaveLength(1)
    expect(screen.getAllByRole('application', { name: 'Directed acyclic task graph' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.execution'] }))
    expect(screen.getByText(zh['node.list'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(screen.getAllByText('done')).toHaveLength(2)
    expect(screen.getByText('safe progress')).toBeTruthy()
    expect(screen.getByText(/"verdict": "ship"/)).toBeTruthy()
    expect(screen.getByText('todo-1')).toBeTruthy()
    expect(screen.getByText(/120.*1.*1/)).toBeTruthy()
    expect(screen.getByText(zh['attempt.checkpoint'].replace('{activation}', '0').replace('{sequence}', '1'))).toBeTruthy()
    expect(screen.getByText(zh['node.schema'])).toBeTruthy()
    expect(screen.getByText(/planning · iteration 1 · resolved/)).toBeTruthy()
    expect(screen.getByText(/terminal · epoch 4/)).toBeTruthy()
    expect(screen.getByText('validated result accepted')).toBeTruthy()
    expect(screen.getByText(/coordination · attempt 1 · confirmed/)).toBeTruthy()
    expect(screen.getByText('LoopX accepted result')).toBeTruthy()
    expect(screen.getByText(zh['run.terminal'].replace('{rule}', 'all-required-nodes-settled'))).toBeTruthy()
    const openChildSession = screen.getByRole('button', { name: zh['attempt.open'] })
    expect(openChildSession.closest('header')?.querySelector('h2')?.textContent).toBe('Analyze')
    expect(openChildSession.closest('[data-attempt]')).toBeNull()
    fireEvent.click(openChildSession)
    expect(openSession).toHaveBeenCalledWith('child-2')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(screen.getAllByText('verified')).toHaveLength(2)
  })

  it('preserves the active canvas across run and selection updates', async () => {
    const probe = cytoscape({ headless: true })
    const prototype = Object.getPrototypeOf(probe) as { destroy: () => void }
    probe.destroy()
    const destroy = vi.spyOn(prototype, 'destroy')
    try {
      const run = {
        id: 'r1', graphId: 'g1', revision: 1, generation: 1, generationId: 'generation-1', ownerEpoch: 1,
        configSnapshot: config, overrides: {}, phase: 'running', createdAt: 1, updatedAt: 2,
        nodes: {
          a: { workId: 'work-a', nodeId: 'a', phase: 'pending', attempts: [] },
          b: { workId: 'work-b', nodeId: 'b', phase: 'pending', attempts: [] },
        },
      }
      const projection = {
        config,
        graphs: { g1: [revision] },
        currentGraphId: 'g1',
        runs: { r1: run },
        operations: {}, settlements: {}, checkpoints: {}, controls: {},
      } as unknown as GraphProjection
      const { store } = setup(projection)
      fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
      fireEvent.click(screen.getByRole('tab', { name: zh['tab.execution'] }))
      destroy.mockClear()

      store.set({
        value: {
          ...projection,
          runs: {
            r1: {
              ...run,
              updatedAt: 3,
              nodes: { ...run.nodes, a: { ...run.nodes.a, phase: 'running' } },
            } as unknown as GraphProjection['runs'][string],
          },
        },
      })
      await waitFor(() => { expect(screen.getAllByText(/running/).length).toBeGreaterThan(0) })
      expect(destroy).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))
      expect(destroy).not.toHaveBeenCalled()

      const nextRevision = { ...revision, revision: 2, parentRevision: 1 }
      store.set({ value: { ...projection, graphs: { g1: [revision, nextRevision] } } })
      await waitFor(() => { expect(destroy).toHaveBeenCalledTimes(1) })
    } finally {
      destroy.mockRestore()
    }
  })

  it('switches revisions and renders conditional, pending, running, and failed evidence', () => {
    const earlier = { ...revision, revision: 1, edges: [{ from: 'a', to: 'b', kind: 'conditional', condition: { path: ['ok'], operator: 'truthy' } }] } as unknown as typeof revision
    const latest = { ...revision, revision: 2, parentRevision: 1 } as unknown as typeof revision
    setup({
      config,
      graphs: { g1: [earlier, latest] },
      currentGraphId: 'g1',
      runs: {
        r2: {
          id: 'r2', graphId: 'g1', revision: 2, phase: 'running', createdAt: 4, updatedAt: 5,
          nodes: {
            a: { nodeId: 'a', phase: 'running', attempts: [{ id: 'running', number: 1, startedAt: 4 }] },
            b: { nodeId: 'b', phase: 'failed', attempts: [{ id: 'failed', number: 1, startedAt: 4, finishedAt: 5, error: { code: 'FAILED', message: 'boom' } }] },
          },
        },
      },
    } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.execution'] }))
    expect(screen.getByText(zh['node.noSelection'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(screen.getByText(/#1 · running/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(screen.getByText(/#1 · boom/)).toBeTruthy()
    expect(screen.getByText('FAILED')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.change(screen.getByLabelText(zh.revisions), { target: { value: '1' } })
    expect(screen.getByText(zh['run.none'])).toBeTruthy()
    expect(screen.getByText(zh['node.noSelection'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))
    expect(screen.getByRole('dialog', { name: 'Analyze' })).toBeTruthy()
    expect(screen.getAllByText(/pending/).length).toBeGreaterThan(0)
  })

  it('offers precise resume, execution override, and rollback controls', () => {
    const latest = { ...revision, revision: 2, parentRevision: 1 } as unknown as typeof revision
    const runBase = {
      generation: 1,
      generationId: 'generation-1',
      ownerEpoch: 1,
      configSnapshot: config,
      overrides: {},
      createdAt: 1,
      updatedAt: 2,
      phase: 'succeeded',
      nodes: {
        a: { workId: 'work-a', nodeId: 'a', phase: 'succeeded', attempts: [], output: { summary: 'done', artifacts: [] } },
        b: { workId: 'work-b', nodeId: 'b', phase: 'succeeded', attempts: [], output: { summary: 'done', artifacts: [] } },
      },
    }
    const { control } = setup({
      config,
      graphs: { g1: [revision, latest] },
      currentGraphId: 'g1',
      runs: {
        r1: { ...runBase, id: 'r1', graphId: 'g1', revision: 1 },
        r2: { ...runBase, id: 'r2', graphId: 'g1', revision: 2, createdAt: 3, updatedAt: 4 },
      },
    } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.execution'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))
    fireEvent.change(screen.getByLabelText(zh['control.modifyLabel']), { target: { value: 'Use the corrected acceptance criteria.' } })
    fireEvent.click(screen.getByRole('button', { name: zh['control.modify'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['control.resume'] }))
    const model = screen.getByLabelText<HTMLSelectElement>(zh['control.overrideModel'])
    const remote = Array.from(model.options).find(option => option.textContent === 'Remote / Coder V2')
    fireEvent.change(model, { target: { value: remote?.value } })
    fireEvent.change(screen.getByLabelText(zh['control.overrideReasoning']), { target: { value: 'ultra' } })
    fireEvent.change(screen.getByLabelText(zh['control.overrideWorker']), { target: { value: 'remote-worker' } })
    fireEvent.change(screen.getByLabelText(zh['control.overrideMaxOutput']), { target: { value: '8192' } })
    fireEvent.change(screen.getByLabelText(zh['control.overrideReasoningBudget']), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: zh['control.override'] }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.change(screen.getByLabelText(zh.revisions), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: zh['control.rollback'] }))
    const requests = control.mock.calls.map(call => call[0])
    expect(requests[0]).toMatchObject({ action: 'modify-task', graphId: 'g1', runId: 'r2', expectedRevision: 2, expectedGeneration: 1, nodeId: 'a', reason: 'Use the corrected acceptance criteria.' })
    expect(requests[1]).toMatchObject({ action: 'resume-from-node', graphId: 'g1', runId: 'r2', expectedRevision: 2, expectedGeneration: 1, nodeId: 'a' })
    expect(requests[2]).toMatchObject({
      action: 'override-node',
      graphId: 'g1',
      runId: 'r2',
      expectedRevision: 2,
      expectedGeneration: 1,
      nodeId: 'a',
      override: {
        roleId: 'engineer',
        workerProvider: 'remote-worker',
        model: { provider: 'remote', model: 'coder-v2', reasoningEffort: 'ultra' },
        executionBudget: {
          maxOutputTokens: 8192,
          maxReasoningOnlyTokens: 1024,
          firstDurableActionMs: 120_000,
          maxNoDurableProgressMs: 300_000,
          checkpointIntervalMs: 180_000,
          maxWallTimeMs: 3_600_000,
          maxContinuations: 16,
        },
      },
    })
    expect(requests[3]).toMatchObject({ action: 'rollback', graphId: 'g1', runId: 'r2', expectedRevision: 2, expectedGeneration: 1, targetRevision: 1 })
  })

  it('shows durable run failures that occur before a child attempt starts', () => {
    setup({
      config,
      graphs: { g1: [revision] },
      currentGraphId: 'g1',
      runs: {
        failed: {
          id: 'failed', graphId: 'g1', revision: 1, phase: 'failed', createdAt: 1, updatedAt: 2,
          error: { code: 'GRAPH_COORDINATION_CLAIM_FAILED', message: 'todo was not found', nodeId: 'a' },
          nodes: {
            a: { nodeId: 'a', phase: 'canceled', attempts: [] },
            b: { nodeId: 'b', phase: 'canceled', attempts: [] },
          },
        },
      },
    } as unknown as GraphProjection)
    fireEvent.click(screen.getByRole('button', { name: /Graph/ }))
    expect(screen.getByRole('status').textContent).toContain('GRAPH_COORDINATION_CLAIM_FAILED')
    expect(screen.getByRole('status').textContent).toContain('todo was not found')
  })

  it('saves edited role and scheduler settings through the injected command', async () => {
    const { loadModels, saveConfig } = setup({ config, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.change(screen.getByLabelText(zh.globalLimit), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(zh.controllerReserve), { target: { value: '2' } })
    const modelSelects = screen.getAllByLabelText<HTMLSelectElement>(zh.model)
    const efforts = screen.getAllByLabelText(zh.reasoning)
    const prompts = screen.getAllByLabelText(zh.prompt)
    expect(loadModels).toHaveBeenCalledOnce()
    expect(Array.from(modelSelects[0]!.options).map(option => option.textContent)).toEqual([
      zh['model.inherit'], 'Main / Planner', 'Local / Coder', 'Remote / Coder V2',
    ])
    fireEvent.change(modelSelects[0]!, { target: { value: '' } })
    fireEvent.change(efforts[0]!, { target: { value: '' } })
    const remote = Array.from(modelSelects[1]!.options).find(option => option.textContent === 'Remote / Coder V2')
    fireEvent.change(modelSelects[1]!, { target: { value: remote?.value } })
    fireEvent.change(efforts[1]!, { target: { value: 'high' } })
    fireEvent.change(prompts[1]!, { target: { value: 'Implement carefully.' } })
    fireEvent.change(screen.getByLabelText(zh.roleParallel), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(zh.modelParallel), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(zh.workerProvider), { target: { value: 'remote-worker' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByText(zh.empty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      const saved = saveConfig.mock.calls[0]?.[0]
      expect(saved?.limits.globalMaxParallel).toBe(2)
      expect(saved?.limits.controllerReserve).toBe(2)
      expect(saved?.roles[0]?.model).toEqual({})
      expect(saved?.roles[1]).toMatchObject({ prompt: 'Implement carefully.', workerProvider: 'remote-worker', maxParallel: 3, model: { provider: 'remote', model: 'coder-v2', reasoningEffort: 'high' } })
    })
    expect(screen.getByText(zh.saved)).toBeTruthy()
  })

  it('blocks an unadvertised reasoning effort and lets the user clear a stale value', async () => {
    const withoutLocalReasoning: ModelDirectoryState = {
      ...models,
      groups: models.groups.map(group => group.id === 'local'
        ? { ...group, models: [{ id: 'coder', name: 'Coder' }] }
        : group),
    }
    const { saveConfig } = setup({ config, graphs: {}, runs: {} }, undefined, withoutLocalReasoning)
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))

    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.save })
    const efforts = screen.getAllByLabelText<HTMLInputElement>(zh.reasoning)
    expect(save.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('local/coder')
    expect(efforts[1]?.disabled).toBe(false)

    fireEvent.change(efforts[1] as HTMLInputElement, { target: { value: '' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => {
      expect(saveConfig.mock.calls[0]?.[0].roles[1]?.model).toEqual({ provider: 'local', model: 'coder' })
    })
  })

  it('preserves the settings draft across unrelated graph projection updates', async () => {
    const { store } = setup({ config, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    const selects = screen.getAllByLabelText<HTMLSelectElement>(zh.model)
    const remote = Array.from(selects[1]!.options).find(option => option.textContent === 'Remote / Coder V2')
    fireEvent.change(selects[1]!, { target: { value: remote?.value } })

    store.set({ value: { config: { ...config }, graphs: {}, runs: {} } })

    await waitFor(() => {
      expect(screen.getAllByLabelText<HTMLSelectElement>(zh.model)[1]?.selectedOptions[0]?.textContent).toBe('Remote / Coder V2')
    })
  })

  it('preserves an unavailable saved model and surfaces model-directory failures', () => {
    setup(
      { config, graphs: {}, runs: {} },
      undefined,
      { ...models, status: 'error', error: 'catalog offline', groups: [] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    const selects = screen.getAllByLabelText<HTMLSelectElement>(zh.model)
    expect(selects[0]?.value).toBe('unavailable')
    expect(selects[0]?.selectedOptions[0]?.textContent).toBe(zh['model.unavailable'].replace('{model}', 'planner'))
    fireEvent.change(selects[0]!, { target: { value: 'unavailable' } })
    expect(screen.getByRole('status').textContent).toContain('catalog offline')
  })

  it('shows model-directory loading state', () => {
    setup(
      { config, graphs: {}, runs: {} },
      undefined,
      { ...models, status: 'loading' },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    expect(screen.getByRole('status').textContent).toBe(zh['model.loading'])
  })

  it('keeps an inherited-model cap unchanged and reports save failures', async () => {
    const inherited = {
      ...config,
      roles: config.roles.map(role => role.controller ? role : { ...role, model: {} }),
      limits: { ...config.limits, models: [] },
    }
    const { saveConfig } = setup({ config: inherited, graphs: {}, runs: {} }, () => Promise.resolve('save rejected'))
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.change(screen.getByLabelText(zh.modelParallel), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toBe('save rejected')
    expect(saveConfig.mock.calls[0]?.[0].limits.models).toEqual([])
  })

  it('falls back to the role cap when a selected model has no explicit cap', () => {
    const uncapped = { ...config, limits: { ...config.limits, models: [{ provider: 'other', model: 'coder', maxParallel: 5 }] } }
    setup({ config: uncapped, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    expect(screen.getByLabelText<HTMLInputElement>(zh.modelParallel).value).toBe('2')
  })

  it('adds, edits, disables, and removes session-owned worker roles', () => {
    setup({ config, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.roleAdd }))
    const roleIds = screen.getAllByLabelText<HTMLInputElement>(zh.roleId)
    const roleLabels = screen.getAllByLabelText<HTMLInputElement>(zh.roleLabel)
    const enabled = screen.getAllByLabelText<HTMLInputElement>(zh.roleEnabled)

    expect(roleIds.at(-1)?.value).toBe('specialist-3')
    fireEvent.change(roleIds.at(-1) as HTMLInputElement, { target: { value: 'security-reviewer' } })
    fireEvent.change(roleLabels.at(-1) as HTMLInputElement, { target: { value: 'Security Reviewer' } })
    fireEvent.click(enabled.at(-1) as HTMLInputElement)
    expect(screen.getByDisplayValue('security-reviewer')).toBeTruthy()
    expect(screen.getByDisplayValue('Security Reviewer')).toBeTruthy()
    expect((enabled.at(-1) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: zh.roleDelete }).at(-1) as HTMLButtonElement)
    expect(screen.queryByDisplayValue('security-reviewer')).toBeNull()
  })

  it('stores a model cap without a provider when the role inherits its provider', () => {
    const inheritedProvider = {
      ...config,
      roles: config.roles.map(role => role.controller ? role : { ...role, model: { model: 'coder' } }),
      limits: { ...config.limits, models: [] },
    }
    const { saveConfig } = setup({ config: inheritedProvider, graphs: {}, runs: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.change(screen.getByLabelText(zh.modelParallel), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect(saveConfig.mock.calls[0]?.[0].limits.models).toEqual([{ model: 'coder', maxParallel: 3 }])
  })

  it('reports rejected saves with Error and non-Error reasons', async () => {
    const first = setup({ config, graphs: {}, runs: {} }, () => Promise.reject(new Error('network down')))
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect((await screen.findByRole('status')).textContent).toBe('network down')
    first.view.unmount()

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- verifies defensive rendering of connector violations.
    setup({ config, graphs: {}, runs: {} }, () => Promise.reject('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: zh['settings.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    expect((await screen.findByRole('status')).textContent).toBe('offline')
  })
})
