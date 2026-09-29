import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ManagedAgentId, ManagedLoopxBinding } from '../src/managed.ts'
import { ManagedLoopxBindingStore } from '../src/managed.ts'

describe('managed LoopX binding storage', () => {
  it('serializes concurrent project preparation and keeps real projects separate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loopx-managed-'))
    const projectOne = join(root, 'project-one')
    const projectTwo = join(root, 'project-two')
    mkdirSync(projectOne)
    mkdirSync(projectTwo)
    const store = new ManagedLoopxBindingStore({
      bindingsRoot: join(root, 'bindings'),
      runtimeRoot: join(root, 'loopx-runtime'),
    })
    const goals = new Map<string, { project: string; agents: Set<string> }>()
    let bootstraps = 0
    const operations = {
      inspect: async (binding: ManagedLoopxBinding) => {
        const goal = goals.get(binding.goalId)
        return goal === undefined ? undefined : { project: goal.project, agents: [...goal.agents] }
      },
      bootstrap: async (binding: ManagedLoopxBinding) => {
        bootstraps += 1
        goals.set(binding.goalId, { project: binding.project, agents: new Set() })
      },
      registerAgent: async (binding: ManagedLoopxBinding, agentId: ManagedAgentId) => {
        const goal = goals.get(binding.goalId)
        if (goal === undefined) throw new Error('test goal is absent')
        goal.agents.add(agentId)
      },
    }
    try {
      const [first, second] = await Promise.all([
        store.prepare(projectOne, ['engineer'], operations),
        store.prepare(join(projectOne, '.'), ['reviewer'], operations),
      ])
      expect(first.goalId).toBe(second.goalId)
      const ready = await store.find(join(projectOne, '.'))
      expect(ready?.phase).toBe('ready')
      expect(Object.keys(ready?.roleAgents ?? {}).sort()).toEqual(['engineer', 'reviewer'])
      expect(bootstraps).toBe(1)
      expect(await store.find(join(projectOne, '.'))).toMatchObject({ goalId: first.goalId, phase: 'ready' })
      expect(await store.find(projectTwo)).toBeUndefined()

      const other = await store.prepare(projectTwo, ['engineer'], operations)
      expect(other.goalId).not.toBe(first.goalId)
      expect(other.runtimeRoot).not.toBe(first.runtimeRoot)
      expect(bootstraps).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a registry that resolves the managed goal to another project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loopx-managed-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const store = new ManagedLoopxBindingStore({
      bindingsRoot: join(root, 'bindings'),
      runtimeRoot: join(root, 'loopx-runtime'),
    })
    const operations = {
      inspect: async () => ({ project: join(root, 'other-project'), agents: [] }),
      bootstrap: async () => {},
      registerAgent: async () => {},
    }
    try {
      await expect(store.prepare(project, [], operations)).rejects.toThrow(/expected project goal/)
      expect(await store.find(project)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('waits for an in-flight prepare before reading its binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-loopx-managed-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const store = new ManagedLoopxBindingStore({
      bindingsRoot: join(root, 'bindings'),
      runtimeRoot: join(root, 'loopx-runtime'),
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const goals = new Map<string, { project: string; agents: Set<string> }>()
    const preparing = store.prepare(project, ['engineer'], {
      inspect: async (binding) => {
        const goal = goals.get(binding.goalId)
        return goal === undefined ? undefined : { project: goal.project, agents: [...goal.agents] }
      },
      bootstrap: async (binding) => {
        entered.resolve(undefined)
        await release.promise
        goals.set(binding.goalId, { project: binding.project, agents: new Set() })
      },
      registerAgent: async (binding, agentId) => {
        goals.get(binding.goalId)?.agents.add(agentId)
      },
    })
    try {
      await entered.promise
      let findCompleted = false
      const finding = store.find(project).then((binding) => {
        findCompleted = true
        return binding
      })
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
      expect(findCompleted).toBe(false)
      release.resolve(undefined)
      await preparing
      expect(await finding).toMatchObject({ phase: 'ready' })
    } finally {
      release.resolve(undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
