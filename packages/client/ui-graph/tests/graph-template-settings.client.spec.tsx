// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { GraphRoleId, MAX_GRAPH_TIMER_MS } from '@deepseek-ai/dsh-graph/client'
import {
  GraphTemplateSettingsTab,
  graphTemplateIssue,
  type GraphTemplateSaveResult,
  type GraphTemplateSettings,
  type GraphTemplateSettingsTabProps,
} from '../src/client/GraphTemplateSettingsTab.tsx'
import { zh } from '../src/client/locales.ts'
import { graphGlobalStandardProps } from './slot-standard-props.client.ts'

afterEach(cleanup)

const template: GraphTemplateSettings = {
  roles: [
    {
      id: GraphRoleId('controller'),
      label: 'Controller',
      description: 'Controls work',
      controller: true,
      enabled: true,
      model: {},
      prompt: 'Control work.',
      maxParallel: 1,
    },
    {
      id: GraphRoleId('engineer'),
      label: 'Engineer',
      description: 'Implements work',
      controller: false,
      enabled: true,
      model: { provider: 'local', model: 'coder', reasoningEffort: 'medium' },
      prompt: 'Implement work.',
      maxParallel: 2,
    },
  ],
  limits: {
    globalMaxParallel: 4,
    controllerReserve: 1,
    models: [{ provider: 'local', model: 'coder', maxParallel: 2 }],
  },
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
}

const models: ModelDirectoryState = {
  current: null,
  pending: null,
  routable: null,
  groups: [{
    id: 'local',
    name: 'Local',
    models: [{
      id: 'coder',
      name: 'Coder',
      reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' },
    }],
  }],
  failures: [],
  status: 'ready',
  error: null,
}

const t: GraphTemplateSettingsTabProps['t'] = makeTranslate(zh, commonZh)

function setup(
  initial: ConfigFormSnapshot<GraphTemplateSettings>,
  saveTemplate = vi.fn<(
    template: GraphTemplateSettings,
    expectedRevision: number,
  ) => Promise<GraphTemplateSaveResult>>(() => Promise.resolve({ ok: true, revision: 2 })),
  resetTemplate = vi.fn<(expectedRevision: number) => Promise<GraphTemplateSaveResult>>(
    () => Promise.resolve({ ok: true, revision: 2 }),
  ),
  modelDirectory: ModelDirectoryState = models,
) {
  const settingsStore = createSnapshotStore(initial)
  const modelStore = createSnapshotStore(modelDirectory)
  const loadModels = vi.fn()
  const props = {
    ...graphGlobalStandardProps(),
    useSettings: bindSnapshotSelector(settingsStore),
    useModels: bindSnapshotSelector(modelStore),
    loadModels,
    saveTemplate,
    resetTemplate,
    t,
  } satisfies GraphTemplateSettingsTabProps
  render(<GraphTemplateSettingsTab {...props} />)
  return { settingsStore, loadModels, saveTemplate, resetTemplate }
}

const ready = (value: GraphTemplateSettings = template, revision = 1): ConfigFormSnapshot<GraphTemplateSettings> => ({
  status: 'ready',
  value,
  base: value,
  user: undefined,
  revision,
  writable: true,
  mode: 'host',
})

describe('GraphTemplateSettingsTab', () => {
  it('edits and revision-fences defaults independently from session snapshots', async () => {
    const { loadModels, saveTemplate } = setup(ready())
    expect(loadModels).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: zh['global.title'] })).toBeTruthy()
    expect(screen.getAllByRole('option', { name: 'Local / Coder' })).toHaveLength(2)

    fireEvent.change(screen.getAllByLabelText(zh.roleLabel)[1]!, { target: { value: 'Builder' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(saveTemplate).toHaveBeenCalledTimes(1) })
    const [savedTemplate, savedRevision] = saveTemplate.mock.calls[0]!
    expect(savedRevision).toBe(1)
    expect(savedTemplate.roles.find(role => role.id === 'engineer')?.label).toBe('Builder')
    expect(await screen.findByText(zh.saved)).toBeTruthy()
  })

  it('refuses stale edits and reloads the newer Host revision', async () => {
    const { settingsStore, saveTemplate } = setup(ready())
    fireEvent.change(screen.getAllByLabelText(zh.roleLabel)[1]!, { target: { value: 'Local draft' } })
    settingsStore.set({
      ...ready({
        ...template,
        roles: template.roles.map(role => role.id === 'engineer' ? { ...role, label: 'Remote edit' } : role),
      }, 2),
    })
    expect(await screen.findByText(zh['global.conflict'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh['global.reload'] }))
    expect(screen.getByDisplayValue('Remote edit')).toBeTruthy()
    expect(saveTemplate).not.toHaveBeenCalled()
  })

  it('blocks invalid controller reservation before the Host write', () => {
    const { saveTemplate } = setup(ready())
    fireEvent.change(screen.getByLabelText(zh.globalLimit), { target: { value: '1' } })
    expect(screen.getByText(zh['global.invalidReserve'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    expect(saveTemplate).not.toHaveBeenCalled()
  })

  it('edits node execution budgets in the persisted Graph template', async () => {
    const { saveTemplate } = setup(ready())
    fireEvent.change(screen.getByLabelText(zh['policy.maxReasoningOnlyTokens']), { target: { value: '2048' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(saveTemplate.mock.calls[0]?.[0].executionPolicy.maxReasoningOnlyTokens).toBe(2048)
    })
  })

  it('persists the run-wide active-subagent ceiling for new sessions', async () => {
    const { saveTemplate } = setup(ready())
    fireEvent.change(screen.getByLabelText(zh.activeSubagentLimit), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(saveTemplate.mock.calls[0]?.[0].limits.maxActiveSubagents).toBe(1)
    })
  })

  it('persists controller fallback and Graph compaction defaults', async () => {
    const { saveTemplate } = setup(ready())
    fireEvent.click(screen.getByRole('button', { name: zh['resilience.addFallback'] }))
    fireEvent.change(screen.getByLabelText(zh['resilience.maxAttempts']), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(zh['resilience.thresholdRatio']), { target: { value: '0.55' } })
    fireEvent.change(screen.getByLabelText(zh['resilience.retainRatio']), { target: { value: '0.08' } })
    fireEvent.change(screen.getByLabelText(zh['resilience.maxTokens']), { target: { value: '12000' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => { expect(saveTemplate).toHaveBeenCalledTimes(1) })
    expect(saveTemplate.mock.calls[0]?.[0].controllerResilience).toMatchObject({
      enabled: true,
      maxFallbackAttemptsPerTurn: 1,
      fallbackModels: [{ provider: 'local', model: 'coder', controller: true, compaction: true }],
      compaction: { enabled: true, thresholdRatio: 0.55, retainRatio: 0.08, maxTokens: 12_000 },
    })
  })

  it('does not persist a role effort omitted by the selected model', async () => {
    const withoutReasoning: ModelDirectoryState = {
      ...models,
      groups: [{ id: 'local', name: 'Local', models: [{ id: 'coder', name: 'Coder' }] }],
    }
    const { saveTemplate } = setup(ready(), undefined, undefined, withoutReasoning)

    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.save })
    const effort = screen.getAllByLabelText<HTMLInputElement>(zh.reasoning)[1] as HTMLInputElement
    expect(screen.getByRole('status').textContent).toContain('local/coder')
    expect(effort.disabled).toBe(false)
    fireEvent.change(effort, { target: { value: '' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => {
      expect(saveTemplate.mock.calls[0]?.[0].roles[1]?.model).toEqual({ provider: 'local', model: 'coder' })
    })
  })

  it('duplicates and reorders worker roles and confirms restoring the built-in template', () => {
    const custom = {
      ...template,
      roles: template.roles.map(role => role.id === 'engineer' ? { ...role, label: 'Custom engineer' } : role),
    }
    const { resetTemplate } = setup({ ...ready(custom), base: template })

    fireEvent.click(screen.getByRole('button', { name: zh.roleDuplicate }))
    expect(screen.getAllByLabelText(zh.roleId).map(input => (input as HTMLInputElement).value))
      .toEqual(['controller', 'engineer', 'engineer-copy'])
    fireEvent.click(screen.getAllByRole('button', { name: zh.roleMoveDown })[0]!)
    expect(screen.getAllByLabelText(zh.roleId).map(input => (input as HTMLInputElement).value))
      .toEqual(['controller', 'engineer-copy', 'engineer'])

    fireEvent.click(screen.getByRole('button', { name: zh['global.reset'] }))
    expect(screen.getAllByDisplayValue('Custom engineer')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: zh['global.confirmReset'] }))
    expect(resetTemplate).toHaveBeenCalledWith(1)
  })

  it('validates controller, worker, and execution-policy invariants', () => {
    expect(graphTemplateIssue(template)).toBeUndefined()
    expect(graphTemplateIssue({
      ...template,
      roles: template.roles.map(role => ({ ...role, enabled: false })),
    })).toBe('global.invalidController')
    expect(graphTemplateIssue({
      ...template,
      roles: template.roles.map(role => role.controller ? role : { ...role, enabled: false }),
    })).toBe('global.invalidWorker')
    expect(graphTemplateIssue({
      ...template,
      executionPolicy: { ...template.executionPolicy, maxRepairRevisions: 33 },
    })).toBe('global.invalidPolicy')
    expect(graphTemplateIssue({
      ...template,
      executionPolicy: { ...template.executionPolicy, checkpointIntervalMs: MAX_GRAPH_TIMER_MS + 1 },
    })).toBe('global.invalidPolicy')
  })

  it('surfaces read-only and unavailable settings states', () => {
    const readonly = ready()
    cleanup()
    setup({ ...readonly, writable: false })
    expect(screen.getByText(zh['global.readOnly'])).toBeTruthy()
    cleanup()
    setup({ ...readonly, status: 'unavailable', value: undefined })
    expect(screen.getByText(zh['global.unavailable'])).toBeTruthy()
  })
})
