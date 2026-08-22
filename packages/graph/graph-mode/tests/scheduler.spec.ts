import { describe, expect, it } from 'vitest'
import {
  GraphBranchGroupId,
  GraphId,
  GraphNodeId,
  GraphRoleId,
  GraphRunId,
  GraphRunGenerationId,
  GraphWorkId,
  defaultGraphExecutionPolicy,
  defaultGraphModeConfig,
  defaultGraphNodeExecutionBudget,
  defaultGraphOutputSchema,
} from '@deepseek-ai/dsh-graph'
import type { GraphBranchMode, GraphRevision, GraphRole, GraphRun } from '@deepseek-ai/dsh-graph'
import { GraphAdmissionController, evaluateGraphBranchGroups, evaluateGraphCondition } from '../src/index.ts'

const configuredRole = (maxParallel: number): GraphRole => ({
  id: GraphRoleId('engineer'),
  label: 'Engineer',
  description: 'Implements work.',
  controller: false,
  enabled: true,
  model: { provider: 'local', model: 'coder' },
  prompt: 'Implement the assigned node.',
  maxParallel,
})

describe('graph scheduler primitives', () => {
  it('evaluates only deterministic structured conditions', () => {
    const output = { summary: 'done', artifacts: [], data: { verdict: 'ship', nested: { ok: true } } }
    expect(evaluateGraphCondition(output, { path: ['verdict'], operator: 'equals', value: 'ship' })).toBe(true)
    expect(evaluateGraphCondition(output, { path: ['nested', 'ok'], operator: 'truthy' })).toBe(true)
    expect(evaluateGraphCondition(output, { path: ['missing'], operator: 'exists' })).toBe(false)
    expect(evaluateGraphCondition(output, { path: ['verdict'], operator: 'not-equals', value: 'hold' })).toBe(true)
    expect(evaluateGraphCondition(undefined, { path: [], operator: 'exists' })).toBe(false)
    expect(evaluateGraphCondition({ ...output, data: { nested: null } }, { path: ['nested', 'ok'], operator: 'exists' })).toBe(false)
    expect(evaluateGraphCondition({ ...output, data: [] }, { path: ['value'], operator: 'exists' })).toBe(false)
  })

  it('evaluates all, any, exactly-one, and activated branch groups', () => {
    const revision = (mode: GraphBranchMode): GraphRevision => ({
      graphId: GraphId(`branch-${mode}`),
      revision: 1,
      objective: 'Choose a branch',
      createdAt: 1,
      userInput: 'choose',
      nodes: ['a', 'b', 'c'].map(id => ({
        id: GraphNodeId(id), title: id, objective: id, kind: 'analysis' as const,
        roleId: GraphRoleId('analyst'), acceptanceCriteria: ['decided'],
        outputSchema: defaultGraphOutputSchema(`output-${id}`), maxAttempts: 1, weight: 1,
        executionBudget: defaultGraphNodeExecutionBudget(), skippable: false, effectPolicy: 'idempotent',
      })),
      edges: ['a', 'b'].map(from => ({
        from: GraphNodeId(from), to: GraphNodeId('c'), kind: 'conditional' as const,
        branchGroupId: GraphBranchGroupId('choice'), condition: { path: ['active'], operator: 'truthy' as const },
      })),
      branchGroups: [{ id: GraphBranchGroupId('choice'), to: GraphNodeId('c'), mode }],
      terminationPolicy: { ...defaultGraphExecutionPolicy(), onExhausted: 'awaiting_user' },
    })
    const run = (graph: GraphRevision, a: boolean, b: boolean, bPhase: 'succeeded' | 'skipped' = 'succeeded'): GraphRun => ({
      id: GraphRunId('run'), graphId: graph.graphId, revision: 1, generation: 1,
      generationId: GraphRunGenerationId('generation-1'), ownerEpoch: 1,
      configSnapshot: defaultGraphModeConfig(), overrides: {},
      phase: 'running', createdAt: 1, updatedAt: 2,
      nodes: {
        a: { workId: GraphWorkId('work-a'), nodeId: GraphNodeId('a'), phase: 'succeeded', attempts: [], output: { summary: 'a', data: { active: a }, artifacts: [] } },
        b: { workId: GraphWorkId('work-b'), nodeId: GraphNodeId('b'), phase: bPhase, attempts: [], ...(bPhase === 'succeeded' ? { output: { summary: 'b', data: { active: b }, artifacts: [] } } : {}) },
        c: { workId: GraphWorkId('work-c'), nodeId: GraphNodeId('c'), phase: 'pending', attempts: [] },
      },
    })
    const all = revision('all')
    expect(evaluateGraphBranchGroups(all, run(all, true, true), GraphNodeId('c'))).toBe('active')
    expect(evaluateGraphBranchGroups(all, run(all, true, false), GraphNodeId('c'))).toBe('inactive')
    const any = revision('any')
    expect(evaluateGraphBranchGroups(any, run(any, true, false), GraphNodeId('c'))).toBe('active')
    const one = revision('exactly-one')
    expect(evaluateGraphBranchGroups(one, run(one, true, false), GraphNodeId('c'))).toBe('active')
    expect(evaluateGraphBranchGroups(one, run(one, true, true), GraphNodeId('c'))).toBe('ambiguous')
    const activated = revision('activated')
    expect(evaluateGraphBranchGroups(activated, run(activated, true, false, 'skipped'), GraphNodeId('c'))).toBe('active')
  })

  it('holds later work until both role and model capacity are released', async () => {
    const admission = new GraphAdmissionController()
    const config = {
      ...defaultGraphModeConfig(),
      limits: {
        globalMaxParallel: 3,
        controllerReserve: 1,
        models: [{ provider: 'local', model: 'coder', maxParallel: 1, maxWeight: 2 }],
      },
    }
    const role = configuredRole(2)
    const signal = new AbortController().signal
    const release = await admission.acquire(role, config, 2, signal)
    let admitted = false
    const second = admission.acquire(role, config, 1, signal).then((dispose) => {
      admitted = true
      dispose()
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    release()
    release()
    await second
    expect(admitted).toBe(true)
  })

  it('enforces global and role caps in FIFO order', async () => {
    const admission = new GraphAdmissionController()
    const config = {
      ...defaultGraphModeConfig(),
      limits: { globalMaxParallel: 2, controllerReserve: 1, models: [] },
    }
    const firstRole = { ...configuredRole(1), model: {} }
    const secondRole = { ...configuredRole(1), id: GraphRoleId('verifier'), model: {} }
    const signal = new AbortController().signal
    const release = await admission.acquire(firstRole, config, 1, signal)
    const order: string[] = []
    const second = admission.acquire(secondRole, config, 1, signal).then((permit) => {
      order.push('second')
      permit()
    })
    const third = admission.acquire(firstRole, config, 1, signal).then((permit) => {
      order.push('third')
      permit()
    })
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await Promise.all([second, third])
    expect(order).toEqual(['second', 'third'])

    const roomy = { ...config, limits: { ...config.limits, globalMaxParallel: 4 } }
    const held = await admission.acquire(firstRole, roomy, 1, signal)
    let roleBlocked = true
    const sameRole = admission.acquire(firstRole, roomy, 1, signal).then((permit) => {
      roleBlocked = false
      permit()
    })
    await Promise.resolve()
    expect(roleBlocked).toBe(true)
    held()
    await sameRole
  })

  it('admits inherited and uncapped models and enforces weighted model budgets', async () => {
    const admission = new GraphAdmissionController()
    const signal = new AbortController().signal
    const inherited = { ...configuredRole(2), model: {} }
    const noModelLimit = {
      ...defaultGraphModeConfig(),
      limits: {
        globalMaxParallel: 4,
        controllerReserve: 1,
        models: [{ provider: 'other', model: 'coder', maxParallel: 1 }],
      },
    }
    const inheritedPermit = await admission.acquire(inherited, noModelLimit, 1, signal)
    inheritedPermit()
    const uncappedPermit = await admission.acquire(configuredRole(2), noModelLimit, 1, signal)
    uncappedPermit()
    const providerInherited = { ...configuredRole(2), model: { model: 'coder' } }
    const inheritedLimit = {
      ...noModelLimit,
      limits: { ...noModelLimit.limits, models: [{ model: 'coder', maxParallel: 2 }] },
    }
    const providerInheritedPermit = await admission.acquire(providerInherited, inheritedLimit, 1, signal)
    providerInheritedPermit()

    const weighted = {
      ...noModelLimit,
      limits: {
        ...noModelLimit.limits,
        models: [{ provider: 'local', model: 'coder', maxParallel: 2, maxWeight: 2 }],
      },
    }
    const first = await admission.acquire(configuredRole(2), weighted, 2, signal)
    let admitted = false
    const pending = admission.acquire(configuredRole(2), weighted, 1, signal).then((permit) => {
      admitted = true
      permit()
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    first()
    await pending
    expect(admitted).toBe(true)
  })

  it('removes canceled waiters and preserves their abort reason', async () => {
    const admission = new GraphAdmissionController()
    const config = {
      ...defaultGraphModeConfig(),
      limits: { globalMaxParallel: 2, controllerReserve: 1, models: [] },
    }
    const role = { ...configuredRole(1), model: {} }
    const held = await admission.acquire(role, config, 1, new AbortController().signal)
    const canceled = new AbortController()
    const pending = admission.acquire(role, config, 1, canceled.signal)
    canceled.abort(new Error('superseded'))
    await expect(pending).rejects.toThrow('superseded')
    const stringCanceled = new AbortController()
    const second = admission.acquire(role, config, 1, stringCanceled.signal)
    stringCanceled.abort('stop')
    await expect(second).rejects.toThrow('graph admission canceled')
    held()

    const alreadyCanceled = new AbortController()
    alreadyCanceled.abort(new Error('already canceled'))
    await expect(admission.acquire(role, config, 1, alreadyCanceled.signal)).rejects.toThrow('already canceled')
  })
})
