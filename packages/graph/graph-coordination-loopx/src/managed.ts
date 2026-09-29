/** Per-project private LoopX binding persistence. @module @deepseek-ai/dsh-graph-coordination-loopx/managed */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Stable private identifier assigned to a managed LoopX project. */
export type ManagedProjectKey = string & { readonly __managedProjectKey: unique symbol }
/** Opaque LoopX goal identifier persisted for one managed project. */
export type ManagedGoalId = string & { readonly __managedGoalId: unique symbol }
/** Opaque registered LoopX peer identifier persisted for one graph role. */
export type ManagedAgentId = string & { readonly __managedAgentId: unique symbol }

/** Durable references needed to resume one project's managed LoopX goal. */
export interface ManagedLoopxBinding {
  readonly version: 1
  readonly phase: 'initializing' | 'ready'
  readonly projectKey: ManagedProjectKey
  readonly project: string
  readonly goalId: ManagedGoalId
  readonly registryPath: string
  readonly runtimeRoot: string
  readonly stateFile: string
  readonly roleAgents: Readonly<Record<string, ManagedAgentId>>
}

/** Private storage roots shared by managed projects. */
export interface ManagedLoopxBindingRoots {
  /** Private directory for durable binding JSON files. */
  readonly bindingsRoot: string
  /** Private directory for per-project LoopX registries and goal state. */
  readonly runtimeRoot: string
}

/** CLI operations that verify and incrementally prepare a binding. */
export interface ManagedLoopxBindingOperations {
  /**
   * Read the actual LoopX registry entry and reject a goal bound to another project.
   * @param binding Private project and LoopX identity to inspect.
   * @returns The registry project and registered agents, or `undefined` when absent.
   */
  inspect(binding: ManagedLoopxBinding): Promise<{ readonly project: string; readonly agents: readonly string[] } | undefined>
  /**
   * Create the previously absent goal without replacing an existing registry entry.
   * @param binding Private identity and paths for goal initialization.
   */
  bootstrap(binding: ManagedLoopxBinding): Promise<void>
  /**
   * Register one missing peer agent through LoopX's additive CLI operation.
   * @param binding Goal identity that will own the peer.
   * @param agentId Opaque peer identifier to add.
   */
  registerAgent(binding: ManagedLoopxBinding, agentId: ManagedAgentId): Promise<void>
}

function projectKey(project: string): ManagedProjectKey {
  return `project-${createHash('sha256').update(project).digest('hex')}` as ManagedProjectKey
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function bindingPath(roots: ManagedLoopxBindingRoots, key: ManagedProjectKey): string {
  return join(roots.bindingsRoot, `${key}.json`)
}

function validateBinding(value: unknown, project: string, roots: ManagedLoopxBindingRoots): ManagedLoopxBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('managed LoopX binding must be a JSON object')
  const record = value as Record<string, unknown>
  const key = projectKey(project)
  const runtimeRoot = join(roots.runtimeRoot, key)
  const registryPath = join(runtimeRoot, 'registry.global.json')
  const stateFile = join(runtimeRoot, 'ACTIVE_GOAL_STATE.md')
  if (record['version'] !== 1 || (record['phase'] !== 'initializing' && record['phase'] !== 'ready')) {
    throw new Error('managed LoopX binding has an unsupported version or phase')
  }
  if (record['projectKey'] !== key || record['project'] !== project || typeof record['goalId'] !== 'string'
    || !/^[A-Za-z0-9._-]{8,128}$/u.test(record['goalId'])) {
    throw new Error('managed LoopX binding has an invalid project or goal identity')
  }
  if (record['registryPath'] !== registryPath || record['runtimeRoot'] !== runtimeRoot || record['stateFile'] !== stateFile
    || !inside(roots.runtimeRoot, runtimeRoot) || !inside(runtimeRoot, registryPath) || !inside(runtimeRoot, stateFile)) {
    throw new Error('managed LoopX binding paths do not match the configured private roots')
  }
  const roleAgentsValue = record['roleAgents']
  if (typeof roleAgentsValue !== 'object' || roleAgentsValue === null || Array.isArray(roleAgentsValue)) {
    throw new Error('managed LoopX binding role agents must be an object')
  }
  const roleAgents = Object.create(null) as Record<string, ManagedAgentId>
  for (const [role, agentId] of Object.entries(roleAgentsValue)) {
    if (!role.trim() || typeof agentId !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/u.test(agentId)) {
      throw new Error('managed LoopX binding has an invalid role agent')
    }
    roleAgents[role] = agentId as ManagedAgentId
  }
  return {
    version: 1,
    phase: record['phase'],
    projectKey: key,
    project,
    goalId: record['goalId'] as ManagedGoalId,
    registryPath,
    runtimeRoot,
    stateFile,
    roleAgents,
  }
}

function readBinding(path: string, project: string, roots: ManagedLoopxBindingRoots): ManagedLoopxBinding | undefined {
  try {
    return validateBinding(JSON.parse(readFileSync(path, 'utf8')), project, roots)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function writeBinding(path: string, binding: ManagedLoopxBinding): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(binding, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, path)
  } catch (error) {
    try { rmSync(temporaryPath, { force: false }) } catch (cleanupError) {
      if (typeof cleanupError === 'object' && cleanupError !== null && 'code' in cleanupError && cleanupError.code === 'ENOENT') {
        throw error
      }
      throw new AggregateError([error, cleanupError], 'managed LoopX binding update and temporary cleanup failed')
    }
    throw error
  }
}

/**
 * Resolve and validate roots before the managed provider publishes its service.
 * @param roots Configured private binding and runtime roots.
 * @returns Normalized absolute roots that cannot contain one another.
 */
export function validateManagedLoopxRoots(roots: ManagedLoopxBindingRoots): ManagedLoopxBindingRoots {
  for (const [name, value] of [['bindingsRoot', roots.bindingsRoot], ['runtimeRoot', roots.runtimeRoot]] as const) {
    if (!isAbsolute(value)) throw new Error(`managed LoopX ${name} must be absolute`)
  }
  const bindingsRoot = resolve(roots.bindingsRoot)
  const runtimeRoot = resolve(roots.runtimeRoot)
  if (bindingsRoot === runtimeRoot || inside(bindingsRoot, runtimeRoot) || inside(runtimeRoot, bindingsRoot)) {
    throw new Error('managed LoopX binding and runtime roots must be separate directories')
  }
  return { bindingsRoot, runtimeRoot }
}

/** Store managed goal references by the real canonical project directory. */
export class ManagedLoopxBindingStore {
  private readonly roots: ManagedLoopxBindingRoots
  private readonly active = new Map<string, Promise<ManagedLoopxBinding>>()

  /**
   * Construct a binding store rooted outside project directories.
   * @param roots Private roots for binding records and LoopX runtime data.
   */
  constructor(roots: ManagedLoopxBindingRoots) {
    this.roots = validateManagedLoopxRoots(roots)
  }

  /**
   * Resolve an existing project binding without creating LoopX data.
   * @param projectPath Project directory used by the graph request.
   * @returns The validated binding or `undefined` when the project is not prepared.
   */
  async find(projectPath: string): Promise<ManagedLoopxBinding | undefined> {
    const project = await realpath(projectPath)
    const preparing = this.active.get(project)
    if (preparing !== undefined) await preparing
    return readBinding(bindingPath(this.roots, projectKey(project)), project, this.roots)
  }

  /**
   * Prepare or resume one project's private LoopX goal and enabled peer roles.
   * @param projectPath Existing project directory.
   * @param roles Enabled graph role identifiers.
   * @param operations Actual LoopX registry and CLI operations.
   * @returns A ready binding after its registry and role entries are verified.
   */
  async prepare(
    projectPath: string,
    roles: readonly string[],
    operations: ManagedLoopxBindingOperations,
  ): Promise<ManagedLoopxBinding> {
    const project = await realpath(projectPath)
    const key = projectKey(project)
    const previous = this.active.get(project)
    const current = (previous?.catch(() => undefined) ?? Promise.resolve(undefined)).then(async () => {
      const path = bindingPath(this.roots, key)
      const existing = readBinding(path, project, this.roots)
      const wasReady = existing?.phase === 'ready'
      let binding = existing ?? this.createBinding(project, key)
      let actual = await operations.inspect(binding)
      if (wasReady && actual === undefined) {
        throw new Error('managed LoopX registry is missing a previously ready project goal')
      }
      if (actual !== undefined && resolve(actual.project) !== project) {
        throw new Error('managed LoopX registry does not contain the expected project goal')
      }
      if (binding.phase !== 'initializing') binding = { ...binding, phase: 'initializing' }
      writeBinding(path, binding)
      if (actual === undefined) {
        await operations.bootstrap(binding)
        actual = await operations.inspect(binding)
      }
      if (actual === undefined || resolve(actual.project) !== project) {
        throw new Error('managed LoopX registry does not contain the expected project goal')
      }
      const roleAgents = Object.assign(Object.create(null) as Record<string, ManagedAgentId>, binding.roleAgents)
      let registered = new Set(actual.agents)
      for (const role of new Set(roles)) {
        if (!role.trim()) throw new Error('managed LoopX role identifiers must be non-empty')
        const agentId = roleAgents[role] ?? this.agentId(key, role)
        roleAgents[role] = agentId
        binding = { ...binding, roleAgents }
        writeBinding(path, binding)
        if (!registered.has(agentId)) {
          await operations.registerAgent(binding, agentId)
          actual = await operations.inspect(binding)
          if (actual === undefined || resolve(actual.project) !== project) {
            throw new Error('managed LoopX goal changed while registering a graph role')
          }
          registered = new Set(actual.agents)
          if (!registered.has(agentId)) throw new Error(`managed LoopX did not register peer ${agentId}`)
        }
      }
      const ready = { ...binding, phase: 'ready' as const }
      writeBinding(path, ready)
      return ready
    })
    this.active.set(project, current)
    try {
      return await current
    } finally {
      if (this.active.get(project) === current) this.active.delete(project)
    }
  }

  private createBinding(project: string, key: ManagedProjectKey): ManagedLoopxBinding {
    const runtimeRoot = join(this.roots.runtimeRoot, key)
    return {
      version: 1,
      phase: 'initializing',
      projectKey: key,
      project,
      goalId: `dsh-${randomUUID()}` as ManagedGoalId,
      registryPath: join(runtimeRoot, 'registry.global.json'),
      runtimeRoot,
      stateFile: join(runtimeRoot, 'ACTIVE_GOAL_STATE.md'),
      roleAgents: {},
    }
  }

  private agentId(key: ManagedProjectKey, role: string): ManagedAgentId {
    const digest = createHash('sha256').update(`${key}\0${role}`).digest('hex').slice(0, 32)
    return `dsh-${digest}` as ManagedAgentId
  }
}
