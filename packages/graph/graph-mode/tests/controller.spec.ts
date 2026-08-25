import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  GraphId,
  GraphAttemptId,
  GraphBranchGroupId,
  GraphControlOperationId,
  GraphNodeId,
  GraphOperationEventId,
  GraphRunGenerationId,
  GraphRunId,
  GraphRoleId,
  GraphWorkId,
  defaultGraphModeConfig,
  defaultGraphNodeExecutionBudget,
  defaultGraphExecutionPolicy,
  defaultGraphOutputSchema,
  foldGraph,
  apply as applyGraphProjection,
} from '@deepseek-ai/dsh-graph'
import type { GraphNode, GraphOperationTransition, GraphRevision, GraphRun } from '@deepseek-ai/dsh-graph'
import GraphCoordination, { MemoryGraphCoordination } from '@deepseek-ai/dsh-graph-coordination'
import GraphArtifactRuntime from '@deepseek-ai/dsh-graph-artifacts'
import type {
  GraphArtifactCaptureRequest,
  GraphArtifactMaterializeRequest,
  GraphArtifactProvider,
  GraphArtifactReconcileRequest,
} from '@deepseek-ai/dsh-graph-artifacts'
import type {
  GraphCoordinationClaim,
  GraphCoordinationRequest,
  GraphCoordinationSettlement,
} from '@deepseek-ai/dsh-graph-coordination'
import GraphWorkerRuntime, {
  GraphWorkerId,
  GraphArtifactManifestId,
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphWorkerOutcome,
  type GraphWorkerProvider as RegisteredGraphWorkerProvider,
} from '@deepseek-ai/dsh-graph-worker'
import GraphResourceRuntime, {
  GraphResourceReservationId,
  type GraphResourceDecision,
  type GraphResourceOutcome,
  type GraphResourceProvider,
  type GraphResourceReconcileRequest,
  type GraphResourceReservationRequest,
  type GraphResourceSnapshot,
} from '@deepseek-ai/dsh-graph-resources'
import GraphSchedulerRuntime, {
  GraphSchedulerLeaseId,
  type GraphSchedulerAcquireRequest,
  type GraphSchedulerDecision,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
  type GraphSchedulerProvider,
} from '@deepseek-ai/dsh-graph-scheduler'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  createToolResultMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import GraphModeController, {
  GRAPH_TEMPLATE_SETTINGS_NAMESPACE,
  resolveGraphControllerPlanDraft,
  resolveGraphRevisionDraft,
  type GraphRevisionDraft,
} from '../src/index.ts'

const CAPABILITIES: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
  sandboxMode: true,
}

const successfulShellResult = (): ShellRunResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 60_000,
  stdout: { text: 'ok', truncated: false },
  stderr: { text: '', truncated: false },
})

class TestShell extends ShellExecutor {
  readonly requests: ShellExecRequest[] = []

  constructor(ctx: Context, private readonly outcomes: ShellRunResult[] = []) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal === undefined ? {} : { signal: request.signal },
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const result = this.outcomes.shift() ?? successfulShellResult()
    return Promise.resolve({ ...result, timeoutMs: spec.timeoutMs })
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('TestShell does not support background processes')
  }
}

class TestLlmAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 262_144 },
      defaultMaxTokens: 32_000,
      reasoning: {
        efforts: ['off', 'low', 'medium', 'high', 'ultra', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })),
      },
    })
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class GraphWorkerProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly inheritsParentContext = false
  readonly capabilities = CAPABILITIES
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly disposed: string[] = []
  private ctx: Context | undefined

  constructor(private readonly outcomes: Array<Error | ((request: ResolvedSubagentStartRequest, session: Session) => Promise<Awaited<SubagentRun['result']>>)> = []) {}

  bind(ctx: Context): void { this.ctx = ctx }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    const sequence = this.requests.length
    const childId = SessionId(`child-${String(sequence)}`)
    if (this.ctx === undefined) throw new Error('test Graph Worker Provider is not bound')
    const session = this.ctx.sessions.create(childId, {
      meta: {
        parentSession: request.parent.id,
        ...request.workspaceCwd === undefined ? {} : { cwd: request.workspaceCwd },
      },
    })
    const outcome = this.outcomes.shift()
    if (outcome instanceof Error) throw outcome
    return {
      id: childId,
      localAgent: undefined,
      result: outcome?.(request, session) ?? Promise.resolve({
        output: [{ type: 'text', text: `worker ${String(sequence)} complete` }],
        structured: {
          summary: `result ${String(sequence)}`,
          coordinationSummary: `public result ${String(sequence)}`,
          data: { sequence },
          artifacts: [`artifact-${String(sequence)}.txt`],
        },
        stopReason: 'completed',
      }),
      dispose: async () => { this.disposed.push(`child-${String(sequence)}`) },
    }
  }
}

class TestGraphWorkerAdapter implements RegisteredGraphWorkerProvider {
  readonly capabilities = {
    protocolVersion: 1 as const,
    remote: false,
    workspaceModes: ['shared'] as const,
    structuredOutput: true,
    toolFilter: true,
    artifactManifest: true,
    progress: false,
    cancellation: true,
  }

  constructor(private readonly ctx: Context, readonly name = 'local') {}

  reconcile(): Promise<{ readonly status: 'retained'; readonly evidence: string }> {
    return Promise.resolve({ status: 'retained', evidence: 'test shared workspace retained' })
  }

  async start(assignment: GraphWorkerAssignment) {
    const child = await this.ctx.subagents.start('spawn', {
      label: `${assignment.role.label}: ${assignment.node.title}`,
      prompt: [...assignment.prompt],
      parent: assignment.parent,
      signal: assignment.signal,
      workspaceCwd: assignment.workspace.sourceRoot,
      agentOptions: {
        ...assignment.role.model.provider === undefined ? {} : { provider: assignment.role.model.provider },
        ...assignment.role.model.model === undefined ? {} : { model: assignment.role.model.model },
        ...assignment.role.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(assignment.role.model.reasoningEffort) },
      },
      outputSchema: assignment.outputSchema,
      ...assignment.toolFilter === undefined ? {} : { toolFilter: assignment.toolFilter },
      persona: assignment.role.prompt,
    })
    const outcome = (stopReason: Awaited<SubagentRun['result']>['stopReason']): GraphWorkerOutcome => {
      switch (stopReason) {
        case 'completed':
        case 'aborted':
        case 'error':
        case 'max-tokens': return stopReason
        default: return 'error'
      }
    }
    return {
      id: GraphWorkerId(`worker:${child.id}`),
      provider: this.name,
      workspace: {
        id: GraphWorkspaceAllocationId(`workspace:${assignment.attemptId}:${String(assignment.activation)}`),
        mode: 'shared' as const,
        root: assignment.workspace.sourceRoot,
        providerReference: `workspace:${assignment.attemptId}:${String(assignment.activation)}`,
        createdAt: Date.now(),
      },
      childSessionId: String(child.id),
      result: child.result.then((result) => {
        const structured = result.structured as {
          data?: { testArtifact?: { path: string; content: string; baseSha256: string | null } }
        } | undefined
        const artifact = structured?.data?.testArtifact
        const bytes = artifact === undefined ? undefined : Buffer.from(artifact.content)
        return {
          outcome: outcome(result.stopReason),
          output: result.output,
          ...result.structured === undefined ? {} : { structured: result.structured },
          childSessionId: String(child.id),
          ...artifact === undefined || bytes === undefined ? {} : {
            artifactManifest: {
              id: GraphArtifactManifestId(`artifact:${assignment.attemptId}:${String(assignment.activation)}`),
              algorithm: 'sha256' as const,
              provider: 'test-artifacts',
              workId: assignment.workId,
              operationId: assignment.operationId,
              attemptId: assignment.attemptId,
              runId: assignment.runId,
              generationId: assignment.generationId,
              ownerEpoch: assignment.ownerEpoch,
              fencingToken: assignment.fencingToken,
              createdAt: Date.now(),
              totalBytes: bytes.byteLength,
              entries: [{
                path: artifact.path,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                baseSha256: artifact.baseSha256,
                size: bytes.byteLength,
                mode: 0o100644,
                kind: 'file' as const,
              }],
              providerReference: `test:${assignment.attemptId}:${String(assignment.activation)}`,
            },
          },
          ...result.stopReason === 'completed' ? {} : { error: { code: 'TEST_GRAPH_WORKER_STOPPED', message: `subagent stopped with ${result.stopReason}` } },
        }
      }).finally(() => { void child.dispose() }),
      cancel: async (reason: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        if (!reason.trim()) throw new Error('cancellation reason must be non-empty')
        await child.dispose()
      },
    }
  }
}

class RevisionRequiredGraphWorkerAdapter implements RegisteredGraphWorkerProvider {
  readonly name = 'local'
  readonly assignments: GraphWorkerAssignment[] = []
  readonly capabilities = {
    protocolVersion: 1 as const,
    remote: false,
    workspaceModes: ['shared', 'isolated-copy', 'read-only-snapshot'] as const,
    structuredOutput: true,
    toolFilter: true,
    artifactManifest: true,
    progress: false,
    cancellation: true,
  }

  reconcile(): Promise<{ readonly status: 'retained'; readonly evidence: string }> {
    return Promise.resolve({ status: 'retained', evidence: 'test workspace retained for revision' })
  }

  start(assignment: GraphWorkerAssignment) {
    this.assignments.push(assignment)
    return Promise.resolve({
      id: GraphWorkerId(`worker:revision-required:${String(this.assignments.length)}`),
      provider: this.name,
      workspace: {
        id: GraphWorkspaceAllocationId(`workspace:revision-required:${String(this.assignments.length)}`),
        mode: assignment.workspace.mode,
        root: assignment.workspace.sourceRoot,
        providerReference: `workspace:revision-required:${String(this.assignments.length)}`,
        createdAt: Date.now(),
      },
      result: Promise.resolve({
        outcome: 'error' as const,
        output: [],
        error: {
          code: 'GRAPH_WORKER_UNDECLARED_WRITE',
          message: 'worker changed undeclared path architecture/ARCHITECTURE.md',
          retryable: false,
        },
      }),
      cancel: (): Promise<void> => Promise.resolve(),
    })
  }
}

class TestGraphArtifactProvider implements GraphArtifactProvider {
  readonly name = 'test-artifacts'
  readonly persistent = true
  readonly remote = false
  readonly materializations: string[][] = []

  capture(_request: GraphArtifactCaptureRequest): Promise<never> {
    return Promise.reject(new Error('test Graph Mode never captures through the integration provider'))
  }

  async materialize(request: GraphArtifactMaterializeRequest) {
    const paths: string[] = []
    for (const entry of request.manifest.entries) {
      const artifact = Buffer.from(entry.sha256 === createHash('sha256').update('engineered').digest('hex') ? 'engineered' : 'integrated')
      const target = join(request.targetRoot, ...entry.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, artifact)
      paths.push(entry.path)
    }
    this.materializations.push(paths)
    return { paths, totalBytes: request.manifest.totalBytes }
  }

  reconcile(_request: GraphArtifactReconcileRequest): Promise<{ status: 'retained'; evidence: string }> {
    return Promise.resolve({ status: 'retained', evidence: 'test manifest remains referenced' })
  }
}

class TestGraphResourceProvider implements GraphResourceProvider {
  readonly name = 'resources'
  readonly protocolVersion = 1 as const
  readonly requests: GraphResourceReservationRequest[] = []
  readonly outcomes: GraphResourceOutcome[] = []
  readonly reconciliations: GraphResourceReconcileRequest[] = []
  reportError?: Error
  onGrant?: (request: GraphResourceReservationRequest) => void

  constructor(private readonly decisions: Array<'wait' | 'grant' | 'reject'> = ['grant']) {}

  async observe(route: { readonly provider?: string; readonly model: string }): Promise<GraphResourceSnapshot> {
    const observedAt = Date.now()
    return { ...route, providerId: this.name, observedAt, expiresAt: observedAt + 60_000, status: 'available', activeRequests: 0, concurrencyLimit: 1 }
  }

  async reserve(request: GraphResourceReservationRequest): Promise<GraphResourceDecision> {
    this.requests.push(request)
    const snapshot = await this.observe(request)
    const decision = this.decisions.shift() ?? 'grant'
    if (decision === 'wait') return { status: 'wait', reason: 'memory', retryAt: request.requestedAt + 1, snapshot }
    if (decision === 'reject') return { status: 'rejected', reason: 'route-unavailable', snapshot }
    this.onGrant?.(request)
    return {
      status: 'granted',
      reservation: {
        ...request.provider === undefined ? {} : { provider: request.provider },
        model: request.model,
        id: GraphResourceReservationId(`reservation:${request.workId}`),
        providerId: this.name,
        workId: request.workId,
        operationId: request.operationId,
        ownerEpoch: request.ownerEpoch,
        weight: request.weight,
        fencingToken: 1,
        acquiredAt: request.requestedAt,
        expiresAt: request.deadline,
        snapshot,
      },
    }
  }

  async report(outcome: GraphResourceOutcome): Promise<void> {
    if (this.reportError !== undefined) throw this.reportError
    this.outcomes.push(outcome)
  }

  async reconcile(request: GraphResourceReconcileRequest): Promise<{ readonly status: 'released'; readonly evidence: string }> {
    this.reconciliations.push(request)
    return { status: 'released', evidence: `released ${request.reservationId}` }
  }
}

class TestGraphSchedulerProvider implements GraphSchedulerProvider {
  readonly name = 'scheduler'
  readonly protocolVersion = 1 as const
  readonly acquisitions: GraphSchedulerAcquireRequest[] = []
  readonly heartbeats: GraphSchedulerLeaseRequest[] = []
  readonly releases: GraphSchedulerLeaseRequest[] = []
  busy = false
  heartbeatError?: Error
  private lastEpoch = 6

  acquire(request: GraphSchedulerAcquireRequest): Promise<GraphSchedulerDecision> {
    this.acquisitions.push(request)
    if (this.busy) return Promise.resolve({ status: 'busy', retryAt: request.requestedAt + 1_000, evidence: 'held by test peer' })
    return Promise.resolve({ status: 'granted', lease: this.lease(request) })
  }

  heartbeat(request: GraphSchedulerLeaseRequest): Promise<GraphSchedulerLease> {
    this.heartbeats.push(request)
    if (this.heartbeatError !== undefined) return Promise.reject(this.heartbeatError)
    return Promise.resolve({
      id: request.leaseId, providerId: this.name, sessionId: 'graph-parent', runId: request.runId,
      generationId: request.generationId, ownerId: request.ownerId, ownerEpoch: request.ownerEpoch,
      fencingToken: request.fencingToken, acquiredAt: 1, expiresAt: Date.now() + 60_000,
    })
  }

  release(request: GraphSchedulerLeaseRequest): Promise<void> { this.releases.push(request); return Promise.resolve() }

  private lease(request: GraphSchedulerAcquireRequest): GraphSchedulerLease {
    const ownerEpoch = Math.max(this.lastEpoch + 1, request.minimumOwnerEpoch)
    this.lastEpoch = ownerEpoch
    return {
      id: GraphSchedulerLeaseId(`lease:${request.runId}:${request.generationId}`), providerId: this.name,
      sessionId: request.sessionId, runId: request.runId, generationId: request.generationId,
      ownerId: request.ownerId, ownerEpoch, fencingToken: ownerEpoch, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
    }
  }
}

interface CoordinationBehavior {
  readonly prepareError?: Error
  readonly prepareWait?: Promise<void>
  readonly claimError?: Error
  readonly claimErrorFor?: (request: GraphCoordinationRequest) => Error | undefined
  readonly claimWaitFor?: (request: GraphCoordinationRequest, signal: AbortSignal) => Promise<void> | undefined
  readonly terminalClaim?: GraphCoordinationClaim['terminal']
  readonly settleError?: Error | string
  readonly settleWait?: Promise<void>
  readonly progressWait?: Promise<void>
  readonly heartbeatWait?: Promise<void>
  readonly onHeartbeat?: () => void
  readonly heartbeatFencingDelta?: number
  readonly watchObservation?: Awaited<ReturnType<GraphCoordination['watch']>>
  readonly cancelError?: Error
  readonly reconcileResult?: Awaited<ReturnType<GraphCoordination['reconcile']>>
}

class TestCoordination extends GraphCoordination {
  readonly prepares: GraphRevision[] = []
  readonly claims: GraphCoordinationRequest[] = []
  readonly heartbeats: Parameters<GraphCoordination['heartbeat']>[0][] = []
  readonly heartbeatSignals: AbortSignal[] = []
  readonly watches: Parameters<GraphCoordination['watch']>[0][] = []
  readonly progresses: Parameters<GraphCoordination['publishProgress']>[0][] = []
  readonly cancellations: Parameters<GraphCoordination['cancel']>[0][] = []
  readonly settlements: GraphCoordinationSettlement[] = []
  readonly settlementSignals: boolean[] = []
  settleError: Error | string | undefined
  private readonly liveClaims = new Map<string, GraphCoordinationClaim>()

  constructor(ctx: Context, private readonly behavior: CoordinationBehavior = {}) {
    super(ctx)
    this.settleError = behavior.settleError
  }

  async prepare(graph: GraphRevision): Promise<void> {
    this.prepares.push(graph)
    await this.behavior.prepareWait
    if (this.behavior.prepareError !== undefined) throw this.behavior.prepareError
  }

  async claim(request: GraphCoordinationRequest, signal: AbortSignal): Promise<GraphCoordinationClaim> {
    this.claims.push(request)
    await this.behavior.claimWaitFor?.(request, signal)
    const claimError = this.behavior.claimErrorFor?.(request) ?? this.behavior.claimError
    if (claimError !== undefined) throw claimError
    const claim = {
      claimId: `claim-${request.node.id}`,
      todoId: `todo-${request.node.id}`,
      leaseId: `lease-${request.node.id}`,
      expiresAt: Date.now() + 60_000,
      fencingToken: 1,
      observation: 'shared progress',
      ...this.behavior.terminalClaim === undefined ? {} : { terminal: this.behavior.terminalClaim },
    }
    this.liveClaims.set(request.activationId, claim)
    return claim
  }

  async heartbeat(request: Parameters<GraphCoordination['heartbeat']>[0], signal: AbortSignal) {
    this.heartbeats.push(request)
    this.heartbeatSignals.push(signal)
    const fencingToken = request.fencingToken + (this.behavior.heartbeatFencingDelta ?? 0)
    const prior = this.liveClaims.get(request.activationId)
    const heartbeat = {
      leaseId: this.behavior.heartbeatFencingDelta === undefined ? request.leaseId : `lease-${request.node.id}-${String(fencingToken)}`,
      expiresAt: Date.now() + 60_000,
      fencingToken,
      progressCursor: String(this.heartbeats.length),
      cancelRequested: false,
    }
    if (prior !== undefined) this.liveClaims.set(request.activationId, { ...prior, ...heartbeat })
    this.behavior.onHeartbeat?.()
    await this.behavior.heartbeatWait
    return heartbeat
  }
  async observe(request: Parameters<GraphCoordination['observe']>[0]): Promise<Awaited<ReturnType<GraphCoordination['observe']>>> {
    const claim = this.liveClaims.get(request.activationId)
    return claim === undefined
      ? { status: 'absent', cursor: '0', events: [], compacted: false }
      : { status: 'claimed', cursor: '0', events: [], compacted: false, claim }
  }
  async watch(request: Parameters<GraphCoordination['watch']>[0]): Promise<Awaited<ReturnType<GraphCoordination['watch']>>> {
    this.watches.push(request)
    return this.behavior.watchObservation ?? { status: 'claimed', cursor: request.afterCursor ?? '0', events: [], compacted: false }
  }
  async publishProgress(request: Parameters<GraphCoordination['publishProgress']>[0]): Promise<{ cursor: string }> {
    this.progresses.push(request)
    await this.behavior.progressWait
    return { cursor: `progress-${String(request.progressSequence)}` }
  }
  async cancel(request: Parameters<GraphCoordination['cancel']>[0]): Promise<void> {
    this.cancellations.push(request)
    if (this.behavior.cancelError !== undefined) throw this.behavior.cancelError
  }
  async reconcile(): Promise<Awaited<ReturnType<GraphCoordination['reconcile']>>> {
    return this.behavior.reconcileResult ?? { status: 'absent', observation: { status: 'absent', cursor: '0', events: [], compacted: false }, evidence: 'absent' }
  }

  async settle(request: GraphCoordinationSettlement, signal: AbortSignal): Promise<void> {
    this.settlements.push(request)
    this.settlementSignals.push(signal.aborted)
    await this.behavior.settleWait
    const current = this.liveClaims.get(request.activationId)
    if (current !== undefined && (current.leaseId !== request.leaseId || current.fencingToken !== request.fencingToken)) {
      throw new Error(`lease version mismatch: expected ${String(request.fencingToken)}, got ${String(current.fencingToken)}`)
    }
    if (this.settleError !== undefined) throw this.settleError
  }
}

class MemorySettings extends SettingsProvider {
  constructor(ctx: Context, private doc: Record<string, unknown> = {}) { super(ctx) }
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const task = (id: string, objective: string): GraphNode => ({
  id: GraphNodeId(id),
  title: id.toUpperCase(),
  objective,
  kind: 'implementation' as const,
  roleId: GraphRoleId('engineer'),
  acceptanceCriteria: [`${id} accepted`],
  outputSchema: defaultGraphOutputSchema(`output-${id}`),
  maxAttempts: 1,
  weight: 1,
  executionBudget: defaultGraphNodeExecutionBudget(),
  skippable: false,
  effectPolicy: 'idempotent',
})

const TERMINATION_POLICY = { ...defaultGraphExecutionPolicy(), onExhausted: 'awaiting_user' as const }

const revision = (number: number, aObjective: string, bObjective: string): GraphRevision => ({
  graphId: GraphId('graph-integration'),
  revision: number,
  ...(number === 1 ? {} : { parentRevision: number - 1 }),
  objective: 'Ship the requested change',
  createdAt: number,
  userInput: `revision ${String(number)}`,
  nodes: [task('a', aObjective), task('b', bObjective)],
  edges: [{ from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'data' }],
  branchGroups: [],
  terminationPolicy: TERMINATION_POLICY,
})

const singleRevision = (id: string, maxAttempts = 1): GraphRevision => ({
  graphId: GraphId(id),
  revision: 1,
  objective: 'Complete one node',
  createdAt: 1,
  userInput: 'complete it',
  nodes: [{ ...task('a', 'complete A'), maxAttempts }],
  edges: [],
  branchGroups: [],
  terminationPolicy: TERMINATION_POLICY,
})

const environmentRevision = (id: string): GraphRevision => ({
  ...singleRevision(id),
  nodes: [{
    ...task('environment-setup', 'Install the required project toolchain'),
    kind: 'environment',
    roleId: GraphRoleId('environment'),
    environment: {
      requiredCapabilities: ['network', 'host-package-install'],
      sandboxMode: 'danger-full-access',
      operations: [{
        id: 'install-maven',
        description: 'Install Maven through the configured host package manager.',
        command: 'winget install --id Apache.Maven --exact',
        rollbackCommand: 'winget uninstall --id Apache.Maven --exact',
      }],
    },
    workspace: { mode: 'shared', readRoots: ['.'], writeRoots: ['.'], cleanup: 'retain' },
    maxAttempts: 1,
    effectPolicy: 'manual',
  }],
})

const dependentRevision = (id: string, conditional: boolean): GraphRevision => ({
  ...singleRevision(id),
  objective: 'Complete dependent work',
  nodes: [task('a', 'complete A'), task('b', 'complete B')],
  edges: [conditional
    ? { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'conditional', branchGroupId: GraphBranchGroupId('to-b'), condition: { path: ['ok'], operator: 'truthy' } }
    : { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' }],
  branchGroups: conditional ? [{ id: GraphBranchGroupId('to-b'), to: GraphNodeId('b'), mode: 'all' }] : [],
})

const workerResult = (
  structured: unknown,
  stopReason: Awaited<SubagentRun['result']>['stopReason'] = 'completed',
): (request: ResolvedSubagentStartRequest) => Promise<Awaited<SubagentRun['result']>> => async _request => ({
  output: [{ type: 'text', text: 'worker complete' }],
  structured,
  stopReason,
})

const durableWorkerResult = (
  structured: unknown,
  stopReason: Awaited<SubagentRun['result']>['stopReason'] = 'completed',
): (request: ResolvedSubagentStartRequest, session: Session) => Promise<Awaited<SubagentRun['result']>> => async (_request, session) => {
  const callId = CallId(`durable-${String(session.seq)}`)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{"file_path":"src/progress.ts"}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'written' }], isError: false }),
  }, { surfaceOp: 'append' })
  return { output: [{ type: 'text', text: 'worker complete' }], structured, stopReason }
}

const commandWorkerResult = (
  command: string,
  result: string,
  structured: unknown,
  stopReason: Awaited<SubagentRun['result']>['stopReason'] = 'completed',
): (request: ResolvedSubagentStartRequest, session: Session) => Promise<Awaited<SubagentRun['result']>> => async (_request, session) => {
  const callId = CallId(`command-${String(session.seq)}`)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command }) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: result }], isError: false }),
  }, { surfaceOp: 'append' })
  return { output: [{ type: 'text', text: 'worker complete' }], structured, stopReason }
}

const reasoningOnlyWorkerResult = async (
  _request: ResolvedSubagentStartRequest,
  session: Session,
): Promise<Awaited<SubagentRun['result']>> => {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: 'unrecoverable hidden reasoning' },
  })
  return { output: [], stopReason: 'max-tokens' }
}

const abortResult = async (request: ResolvedSubagentStartRequest): Promise<Awaited<SubagentRun['result']>> => {
  if (request.signal.aborted) return { output: [], stopReason: 'aborted' }
  return await new Promise((resolve) => {
    request.signal.addEventListener('abort', () => {
      resolve({ output: [], stopReason: 'aborted' })
    }, { once: true })
  })
}

async function settled(ctx: Context, agent: Agent, expectedRevision: number): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    const run = Object.values(ctx.graphMode.state(agent).runs)
      .find(candidate => candidate.revision === expectedRevision && candidate.phase === 'succeeded')
    if (run !== undefined) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`graph revision ${String(expectedRevision)} did not settle`)
}

async function terminal(ctx: Context, agent: Agent, expectedRevision: number) {
  for (let turn = 0; turn < 50; turn++) {
    const run = Object.values(ctx.graphMode.state(agent).runs)
      .find(candidate => candidate.revision === expectedRevision
        && ['succeeded', 'failed', 'canceled'].includes(candidate.phase))
    if (run !== undefined) return run
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`graph revision ${String(expectedRevision)} did not terminate`)
}

async function runInPhase(ctx: Context, agent: Agent, expectedRevision: number, expectedPhase: GraphRun['phase']): Promise<GraphRun> {
  for (let turn = 0; turn < 100; turn++) {
    const run = Object.values(ctx.graphMode.state(agent).runs)
      .find(candidate => candidate.revision === expectedRevision && candidate.phase === expectedPhase)
    if (run !== undefined) return run
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`graph revision ${String(expectedRevision)} did not reach phase ${expectedPhase}`)
}

async function runWithPhase(ctx: Context, agent: Agent, expectedRevision: number, phase: string) {
  for (let turn = 0; turn < 50; turn++) {
    const run = Object.values(ctx.graphMode.state(agent).runs)
      .find(candidate => candidate.revision === expectedRevision && candidate.phase === phase)
    if (run !== undefined) return run
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`graph revision ${String(expectedRevision)} did not reach ${phase}`)
}

async function terminalRunId(ctx: Context, agent: Agent, runId: string) {
  for (let turn = 0; turn < 80; turn++) {
    const run = ctx.graphMode.state(agent).runs[runId]
    if (run !== undefined && ['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)) return run
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`graph run ${runId} did not terminate`)
}

const controlAddress = (ctx: Context, agent: Agent, runId: GraphRunId) => {
  const run = ctx.graphMode.state(agent).runs[runId]
  if (run === undefined) throw new Error(`missing graph run ${runId}`)
  return {
    graphId: run.graphId,
    runId,
    expectedRevision: run.revision,
    expectedGeneration: run.generation,
  }
}

async function waitForRequests(provider: GraphWorkerProvider, count: number): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    if (provider.requests.length >= count) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`provider did not receive ${String(count)} requests`)
}

async function harness(options: {
  readonly provider?: GraphWorkerProvider
  readonly coordination?: CoordinationBehavior
  readonly memoryCoordination?: boolean
  readonly cwd?: string
  readonly agentOptions?: Agent['options']
  readonly agentId?: SessionId
  readonly sessionId?: SessionId
  readonly settings?: Record<string, unknown>
  readonly resources?: TestGraphResourceProvider
  readonly coordinationHeartbeatMs?: number
  readonly schedulerHeartbeatMs?: number
  readonly externalOperationTimeoutMs?: number
  readonly recoveryScanIntervalMs?: number
  readonly projections?: boolean
  readonly scheduler?: TestGraphSchedulerProvider
  readonly artifacts?: TestGraphArtifactProvider
  readonly graphWorker?: RegisteredGraphWorkerProvider
  readonly shellResults?: ShellRunResult[]
} = {}): Promise<{
  ctx: Context
  provider: GraphWorkerProvider
  agent: Agent
  steer: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  coordination: TestCoordination | undefined
  shell: TestShell
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['base', 'controller-provider', 'forced', 'local', 'remote', 'test'], new TestLlmAdapter())
  await ctx.plugin(SessionStore)
  if (options.projections === true) {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(applyGraphProjection)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestShell, options.shellResults ?? [])
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(GraphWorkerRuntime)
  if (options.artifacts !== undefined) {
    await ctx.plugin(GraphArtifactRuntime)
    ctx.graphArtifacts.register(options.artifacts)
  }
  if (options.resources !== undefined) {
    await ctx.plugin(GraphResourceRuntime)
    ctx.graphResources.register(options.resources)
  }
  if (options.scheduler !== undefined) {
    await ctx.plugin(GraphSchedulerRuntime)
    ctx.graphScheduler.register(options.scheduler)
  }
  if (options.settings !== undefined) await ctx.plugin(MemorySettings, options.settings).await()
  const provider = options.provider ?? new GraphWorkerProvider()
  provider.bind(ctx)
  ctx.subagents.registerProvider(provider)
  ctx.graphWorkers.register(options.graphWorker ?? new TestGraphWorkerAdapter(ctx))
  let coordination: TestCoordination | undefined
  if (options.coordination !== undefined) {
    await ctx.plugin(TestCoordination, options.coordination)
    coordination = ctx.graphCoordination as TestCoordination
  } else if (options.memoryCoordination === true) {
    await ctx.plugin(MemoryGraphCoordination)
  }
  await ctx.plugin(GraphModeController, {
    ...options.resources === undefined ? {} : { resourceProvider: options.resources.name },
    ...options.coordinationHeartbeatMs === undefined ? {} : { coordinationHeartbeatMs: options.coordinationHeartbeatMs },
    ...options.scheduler === undefined ? {} : { schedulerProvider: options.scheduler.name },
    ...options.schedulerHeartbeatMs === undefined ? {} : { schedulerHeartbeatMs: options.schedulerHeartbeatMs },
    ...options.externalOperationTimeoutMs === undefined ? {} : { externalOperationTimeoutMs: options.externalOperationTimeoutMs },
    ...options.recoveryScanIntervalMs === undefined ? {} : { recoveryScanIntervalMs: options.recoveryScanIntervalMs },
  })
  await ctx.plugin(CommandRuntime)
  await new Promise(resolve => setImmediate(resolve))
  const id = options.sessionId ?? SessionId('graph-parent')
  const cwd = options.cwd ?? (options.coordination === undefined ? process.cwd() : undefined)
  const session = ctx.sessions.create(id, {
    meta: { createdAt: 1, ...cwd === undefined ? {} : { cwd } },
  })
  const steer = vi.fn()
  const followup = vi.fn()
  const agent = {
    id: options.agentId ?? session.id,
    options: options.agentOptions ?? { provider: 'test', model: 'coder' },
    session,
    ctx,
    steer,
    followup,
  } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.assign(agent, { ctx: scope.ctx })
  return { ctx, provider, agent, steer, followup, coordination, shell: ctx.shell as TestShell }
}

describe('GraphModeController', () => {
  it('reads the eagerly maintained graph projection when the registry is composed', async () => {
    const { ctx, agent } = await harness({ projections: true })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })

    const projected = ctx.sessionProjections.stateOf(agent.session, 'graph')
    expect(projected).toBeDefined()
    expect(ctx.graphMode.state(agent)).toBe(projected)
  })

  it('holds a fenced whole-run scheduler lease from admission through terminal release', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const { ctx, agent } = await harness({ scheduler })
    await ctx.commands.execute(agent, '/graph', [], new AbortController().signal)
    const accepted = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'owned run', graph: singleRevision('owned-run') })
    const run = await terminalRunId(ctx, agent, accepted.runId as string)
    expect(run.ownerEpoch).toBe(7)
    expect(scheduler.acquisitions).toHaveLength(1)
    expect(scheduler.releases).toHaveLength(1)
    expect(scheduler.releases[0]).toMatchObject({ runId: run.id, ownerEpoch: 7, fencingToken: 7 })

    scheduler.busy = true
    await expect(ctx.graphMode.submit(agent, { intent: 'new', reason: 'busy run', graph: singleRevision('busy-run') }))
      .rejects.toThrow(/owned by another scheduler/)
  })

  it('stops all durable writes when the whole-run scheduler authority is lost', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    scheduler.heartbeatError = new Error('lease fenced by peer')
    const provider = new GraphWorkerProvider([async request => await new Promise((resolve) => {
      const finish = () => { resolve({ output: [{ type: 'text', text: 'aborted after lease loss' }], stopReason: 'aborted' }) }
      if (request.signal.aborted) finish()
      else request.signal.addEventListener('abort', finish, { once: true })
    })])
    const { ctx, agent, followup } = await harness({ scheduler, schedulerHeartbeatMs: 100, provider })
    await ctx.commands.execute(agent, '/graph', [], new AbortController().signal)
    const accepted = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'fenced run', graph: singleRevision('fenced-run') })
    await waitForRequests(provider, 1)
    for (let turn = 0; turn < 80 && scheduler.releases.length === 0; turn++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(scheduler.heartbeats).toHaveLength(1)
    expect(scheduler.releases).toHaveLength(1)
    const run = ctx.graphMode.state(agent).runs[accepted.runId as string] as GraphRun
    expect(run.phase).toBe('running')
    expect(run.terminal).toBeUndefined()
    expect(ctx.graphMode.state(agent).operations[run.nodes['a']!.workId]?.at(-1)?.stage).toBe('started')
    expect(agent.session.events.some(event => event.type === 'graph/run'
      && event.data.id === run.id && event.data.terminal !== undefined)).toBe(false)
    expect(followup).not.toHaveBeenCalled()
  })

  it('automatically recovers a durable nonterminal run without a local executor', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'orphan recovered', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ scheduler, provider, recoveryScanIntervalMs: 100 })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph = {
      ...singleRevision('automatic-orphan-recovery'),
      nodes: [{ ...task('a', 'complete A'), effectPolicy: 'reconcile' as const }],
    }
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
    agent.session.append('graph/run', {
      id: GraphRunId('automatic-orphan-run'), graphId: graph.graphId, revision: 1, generation: 1,
      generationId: GraphRunGenerationId('automatic-orphan-generation-1'), ownerEpoch: 6,
      configSnapshot: { ...defaultGraphModeConfig(), active: true }, overrides: {},
      phase: 'running', createdAt: 1, updatedAt: 2,
      nodes: {
        a: { workId: GraphWorkId('automatic-orphan-work'), nodeId: GraphNodeId('a'), phase: 'running', attempts: [] },
      },
    })
    agent.session.append('graph/operation', {
      version: 1,
      eventId: GraphOperationEventId('automatic-orphan-event-1'),
      operationId: GraphControlOperationId('automatic-orphan-operation-1'),
      workId: GraphWorkId('automatic-orphan-work'),
      runId: GraphRunId('automatic-orphan-run'),
      generationId: GraphRunGenerationId('automatic-orphan-generation-1'),
      graphId: graph.graphId,
      revision: 1,
      nodeId: GraphNodeId('a'),
      ownerEpoch: 6,
      stage: 'planned',
      at: 1,
      externalReferences: [],
    })
    agent.session.append('graph/operation', {
      version: 1,
      eventId: GraphOperationEventId('automatic-orphan-event-2'),
      operationId: GraphControlOperationId('automatic-orphan-operation-1'),
      workId: GraphWorkId('automatic-orphan-work'),
      runId: GraphRunId('automatic-orphan-run'),
      generationId: GraphRunGenerationId('automatic-orphan-generation-1'),
      graphId: graph.graphId,
      revision: 1,
      nodeId: GraphNodeId('a'),
      ownerEpoch: 6,
      stage: 'admitted',
      expectedPrevious: 'planned',
      at: 2,
      externalReferences: [],
      detail: 'model reservation requested before executor loss',
    })

    await vi.waitFor(() => {
      expect(ctx.graphMode.state(agent).runs['automatic-orphan-run']).toMatchObject({
        generation: 2,
        phase: 'succeeded',
        nodes: { a: { phase: 'succeeded' } },
      })
    }, { timeout: 2_000, interval: 20 })
    expect(provider.requests).toHaveLength(1)
    expect(scheduler.acquisitions).toHaveLength(1)
  })

  it('treats manual reconciliation as a no-op while a local executor is live', async () => {
    const provider = new GraphWorkerProvider([abortResult])
    const active = await harness({ provider, recoveryScanIntervalMs: 300_000 })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'keep executor live', graph: singleRevision('live-executor-reconcile'),
    })
    const runId = GraphRunId(accepted.runId as string)
    await waitForRequests(provider, 1)

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('live-executor-reconcile-control'),
      action: 'reconcile-run',
      ...controlAddress(active.ctx, active.agent, runId),
      reason: 'operator checks executor liveness',
    })
    expect(record.result).toEqual({ outcome: 'no-op', detail: `run ${runId} already has a live local executor` })
    expect(active.ctx.graphMode.state(active.agent).runs[runId]?.generation).toBe(1)

    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('live-executor-cancel-control'),
      action: 'cancel-run',
      ...controlAddress(active.ctx, active.agent, runId),
      reason: 'finish the liveness test',
    })
    expect((await terminalRunId(active.ctx, active.agent, runId)).phase).toBe('canceled')
  })

  it('does not accept a graph revision when scheduler ownership is unavailable', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    scheduler.busy = true
    const active = await harness({ scheduler })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    let flushedPending = false
    active.ctx.on('session/flush', (session) => {
      if (session === active.agent.session && session.events.some(event => (
        event.type === 'graph/submission' && event.data.outcome === 'pending'
      ))) flushedPending = true
    })

    await expect(active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'busy scheduler', graph: singleRevision('busy-submission'),
    })).rejects.toThrow(/owned by another scheduler/)
    const state = active.ctx.graphMode.state(active.agent)
    expect(flushedPending).toBe(true)
    expect(state.graphs['busy-submission']).toBeUndefined()
    const submissions = Object.values(state.submissions)
    expect(submissions).toHaveLength(1)
    expect(submissions[0]?.outcome).toBe('failed')
    expect(submissions[0]?.error?.code).toBe('GRAPH_SUBMISSION_ACTIVATION_FAILED')
    expect(typeof submissions[0]?.error?.message).toBe('string')
  })

  it('recovers a graph submission whose pre-dispatch durability barrier failed', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'recovered submission complete', artifacts: [] }),
    ])
    const active = await harness({ provider, memoryCoordination: true })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const stopFailure = active.ctx.on('session/flush', () => { throw new Error('durability offline') })
    await expect(active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'recover pending submission', graph: singleRevision('recover-submission'),
    })).rejects.toThrow(/durability offline/)
    expect(active.ctx.graphMode.state(active.agent).graphs['recover-submission']).toBeUndefined()
    stopFailure()

    await active.ctx.graphMode.recover(active.agent)
    const recovered = await terminal(active.ctx, active.agent, 1)
    expect(recovered.phase).toBe('succeeded')
    expect(Object.values(active.ctx.graphMode.state(active.agent).submissions))
      .toEqual([expect.objectContaining({ outcome: 'accepted' })])
  })

  it('does not recover a pending submission while its original activation is in flight', async () => {
    let releasePrepare!: () => void
    const prepareWait = new Promise<void>((resolve) => { releasePrepare = resolve })
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'single activation complete', artifacts: [] }),
    ])
    const active = await harness({
      provider,
      coordination: { prepareWait },
      cwd: process.cwd(),
      recoveryScanIntervalMs: 100,
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submission = active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'hold activation across recovery scan', graph: singleRevision('single-flight-submission'),
    })
    await vi.waitFor(() => { expect(active.coordination?.prepares).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(active.coordination?.prepares).toHaveLength(1)
    releasePrepare()

    const accepted = await submission
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    expect(run.phase).toBe('succeeded')
    expect(provider.requests).toHaveLength(1)
    expect(active.coordination?.claims).toHaveLength(1)
    expect(active.agent.session.events.filter(event => event.type === 'graph/operation'
      && event.data.runId === run.id && event.data.stage === 'planned')).toHaveLength(1)
  })

  it('releases scheduler ownership when the post-acquisition handoff barrier fails', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const active = await harness({ scheduler })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const stopFailure = active.ctx.on('session/flush', (session) => {
      if (session === active.agent.session && session.events.some(event => (
        event.type === 'graph/change'
        && event.data.kind === 'graph/revision'
        && event.data.graph.graphId === 'handoff-flush-failure'
      ))) throw new Error('post-acquisition durability offline')
    })
    await expect(active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'fail the owned handoff', graph: singleRevision('handoff-flush-failure'),
    })).rejects.toThrow('post-acquisition durability offline')
    stopFailure()
    expect(scheduler.acquisitions).toHaveLength(1)
    expect(scheduler.releases).toHaveLength(1)
    expect(scheduler.releases[0]).toMatchObject({ ownerEpoch: 7, fencingToken: 7 })
  })

  it('resolves review drafts with the structured control decision schema', () => {
    const graph = resolveGraphRevisionDraft({
      graphId: GraphId('review-schema'),
      revision: 1,
      objective: 'review one result',
      userInput: 'review it',
      nodes: [{
        id: GraphNodeId('review'), title: 'Review', objective: 'decide acceptance', kind: 'review',
        roleId: GraphRoleId('reviewer'), acceptanceCriteria: ['decision is explicit'], effectPolicy: 'idempotent',
      }],
    }, defaultGraphModeConfig(), 5)
    const schema = graph.nodes[0]?.outputSchema.schema

    expect(schema?.required).toContain('data')
    expect(schema?.properties?.['data']).toMatchObject({
      required: ['decision', 'issues'],
      properties: { decision: { enum: ['approved', 'rejected', 'needs-user'] } },
    })
  })

  it('composes specialized verification fields with the structured control decision schema', () => {
    const specialized = defaultGraphOutputSchema('browser-result')
    const graph = resolveGraphRevisionDraft({
      graphId: GraphId('verification-schema'),
      revision: 1,
      objective: 'verify one browser flow',
      userInput: 'verify it',
      nodes: [{
        id: GraphNodeId('verify'), title: 'Verify', objective: 'test the login flow', kind: 'verification',
        roleId: GraphRoleId('browser-tester'), acceptanceCriteria: ['result is explicit'], effectPolicy: 'idempotent',
        outputSchema: {
          ...specialized,
          schema: {
            ...specialized.schema,
            properties: {
              ...specialized.schema.properties,
              data: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  moduleId: { type: 'string' },
                  result: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
                },
                required: ['moduleId', 'result'],
              },
            },
          },
        },
      }],
    }, defaultGraphModeConfig(), 5)
    const data = graph.nodes[0]?.outputSchema.schema.properties?.['data']

    expect(graph.nodes[0]?.outputSchema.id).toBe('browser-result')
    expect(data?.required).toEqual(['moduleId', 'result', 'decision', 'issues'])
    expect(data?.properties?.['result']).toEqual({ type: 'string', enum: ['pass', 'fail', 'blocked'] })
    expect(data?.properties?.['decision']).toEqual({ type: 'string', enum: ['approved', 'rejected', 'needs-user'] })
  })

  it('returns one aggregate admission diagnostic with a corrected minimal draft', () => {
    let failure: unknown
    try {
      resolveGraphRevisionDraft({
        graphId: 'unsafe graph id',
        revision: 0,
        objective: ' ',
        userInput: '',
        nodes: [{
          id: GraphNodeId('duplicate'), title: '', objective: '', kind: 'implementation',
          roleId: GraphRoleId('controller'), acceptanceCriteria: [], effectPolicy: 'idempotent', maxAttempts: 999,
        }, {
          id: GraphNodeId('duplicate'), title: 'Second', objective: 'Second', kind: 'implementation',
          roleId: GraphRoleId('missing-role'), acceptanceCriteria: ['done'], effectPolicy: 'idempotent',
        }],
        edges: [{ from: GraphNodeId('missing'), to: GraphNodeId('missing'), kind: 'data' }],
        unexpected: true,
      } as unknown as GraphRevisionDraft, defaultGraphModeConfig())
    } catch (error) {
      failure = error
    }
    const message = failure instanceof Error ? failure.message : ''

    expect(message).toContain('unexpected: unknown graph field')
    expect(message).toContain('graphId: use a normalized safe id')
    expect(message).toContain('revision: use a positive integer')
    expect(message).toContain('nodes[1].id: duplicate node id duplicate')
    expect(message).toContain('nodes[0].roleId: choose an enabled non-controller role')
    expect(message).toContain('edges[0].from: names an unknown node')
    expect(message).toContain('Corrected minimal example:')
  })

  it('returns a revision-specific corrected draft example', () => {
    const { parentRevision, ...missingParent } = revision(2, 'A', 'B')
    expect(parentRevision).toBe(1)
    expect(() => resolveGraphRevisionDraft(missingParent, defaultGraphModeConfig()))
      .toThrow(/"revision":2,"parentRevision":1/)
  })

  it('scopes stable logical work identities to the session rather than a reused agent id', async () => {
    const sharedAgentId = SessionId('reused-agent-id')
    const first = await harness({ agentId: sharedAgentId, sessionId: SessionId('graph-session-a') })
    const second = await harness({ agentId: sharedAgentId, sessionId: SessionId('graph-session-b') })
    const signal = new AbortController().signal
    await first.ctx.commands.execute(first.agent, '/graph', [], signal)
    await second.ctx.commands.execute(second.agent, '/graph', [], signal)

    await first.ctx.graphMode.submit(first.agent, { intent: 'new', reason: 'first session', graph: singleRevision('same-graph') })
    await second.ctx.graphMode.submit(second.agent, { intent: 'new', reason: 'second session', graph: singleRevision('same-graph') })
    const firstRun = await terminal(first.ctx, first.agent, 1)
    const secondRun = await terminal(second.ctx, second.agent, 1)

    expect(firstRun.nodes['a']?.workId).not.toBe(secondRun.nodes['a']?.workId)
  })

  it('activates per session through /graph and steers trailing text', async () => {
    const { ctx, agent, steer } = await harness()
    const signal = new AbortController().signal
    ctx.emit('agent/created', { agent })
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('graph_submit')
    const result = await ctx.commands.execute(agent, '/graph implement the feature', [], signal)
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(ctx.graphMode.state(agent).config.active).toBe(true)
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('graph_submit')
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('graph_submit')
    expect(steer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: 'implement the feature' }],
    }))
    const configured = defaultGraphModeConfig()
    const roles = configured.roles.map(role => role.controller
      ? { ...role, prompt: 'Custom controller policy.', model: { provider: 'controller-provider', model: 'controller-model', reasoningEffort: 'high' } }
      : role)
    ctx.graphMode.setConfig(agent, { ...configured, active: true, roles })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const policy = assembly.sections.find(section => section.name === 'graph:controller')?.text
    expect(policy).toContain('Custom controller policy.')
    expect(policy).toContain('never calculate or submit graph identifiers, revision numbers, parent revisions, timestamps, changed-node lists')
    expect(policy).toContain('assigns a safe unused graph id for new work')
    expect(policy).toContain("Preserve each still-valid accepted node's id, semantic definition, and incoming dependencies")
    expect(policy).toContain('set campaign.batchId exactly to campaign.plan.batches[0].id')
    expect(policy).toContain('campaign.planExtension containing the complete newly discovered ordered suffix')
    expect(policy).toContain('Never change, insert, reorder, or remove a registered batch')
    expect(policy).toContain('assign the browser-tester role when available')
    expect(policy).toContain('relevant console and failed-network inspection')
    expect(assembly.variables).toMatchObject({ provider: 'controller-provider', model: 'controller-model' })
    const routed = await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal },
      () => Promise.resolve({ provider: 'base', model: 'base' }),
    )
    expect(routed).toMatchObject({ provider: 'controller-provider', model: 'controller-model', reasoningEffort: 'high' })
    await ctx.commands.execute(agent, '/graph off', [], signal)
    expect(ctx.graphMode.state(agent).config.active).toBe(false)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('graph_submit')

    agent.session.append('graph/change', {
      kind: 'graph/config', version: 2, config: { ...defaultGraphModeConfig(), active: true },
    })
    ctx.emit('agent/created', { agent })
    ctx.emit('agent/created', { agent })
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('graph_submit')
    ctx.emit('agent/disposed', { agent })
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('graph_submit')
  })

  it('copies global role templates only on first session activation', async () => {
    const defaults = defaultGraphModeConfig()
    const firstRoles = defaults.roles.map(role => role.id === 'engineer'
      ? { ...role, prompt: 'Use the first global template.', model: { provider: 'local', model: 'first-model', reasoningEffort: 'medium' }, maxParallel: 2 }
      : role)
    const template = { roles: firstRoles, limits: defaults.limits, executionPolicy: defaults.executionPolicy }
    const active = await harness({ settings: { [GRAPH_TEMPLATE_SETTINGS_NAMESPACE]: template } })
    await active.ctx.commands.execute(active.agent, '/graph', [], new AbortController().signal)
    expect(active.ctx.graphMode.state(active.agent).config.roles.find(role => role.id === 'engineer')).toMatchObject({
      prompt: 'Use the first global template.', maxParallel: 2, model: { model: 'first-model' },
    })

    const secondRoles = firstRoles.map(role => role.id === 'engineer'
      ? { ...role, prompt: 'Use the changed global template.', model: { provider: 'local', model: 'second-model' } }
      : role)
    await active.ctx.settings.replace(GRAPH_TEMPLATE_SETTINGS_NAMESPACE, { ...template, roles: secondRoles })
    await active.ctx.commands.execute(active.agent, '/graph off', [], new AbortController().signal)
    await active.ctx.commands.execute(active.agent, '/graph', [], new AbortController().signal)
    expect(active.ctx.graphMode.state(active.agent).config.roles.find(role => role.id === 'engineer')?.model.model).toBe('first-model')

    const secondId = SessionId('graph-second-session')
    const secondSession = Session.create(secondId, [], { version: 0, id: secondId, createdAt: 2 })
    const secondAgent = { ...active.agent, id: secondId, session: secondSession, steer: vi.fn(), followup: vi.fn() } as unknown as Agent
    let secondScope!: Scope
    await active.ctx.plugin(Object.assign((inner: Context) => { secondScope = createScope(inner, secondAgent) }, {
      inject: ['tools', 'systemPrompt'],
    }))
    Object.assign(secondAgent, { ctx: secondScope.ctx })
    await active.ctx.commands.execute(secondAgent, '/graph', [], new AbortController().signal)
    expect(active.ctx.graphMode.state(secondAgent).config.roles.find(role => role.id === 'engineer')).toMatchObject({
      prompt: 'Use the changed global template.', model: { model: 'second-model' },
    })
  })

  it('keeps inactive prompt routes unchanged and validates command configuration', async () => {
    const { ctx, agent } = await harness()
    const signal = new AbortController().signal
    const agentless = await ctx.systemPrompt.assemble({ scope: ctx })
    expect(agentless.sections.find(section => section.name === 'graph:controller')?.text).toBe('')
    const inactiveAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(inactiveAssembly.sections.find(section => section.name === 'graph:controller')?.text).toBe('')
    const inactiveRoute = await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal },
      () => Promise.resolve({ provider: 'base', model: 'base' }),
    )
    expect(inactiveRoute).toEqual({ provider: 'base', model: 'base' })

    const invalidJson = await ctx.commands.execute(agent, '/graph config {', [], signal)
    expect(invalidJson?.result).toMatchObject({ kind: 'error', text: 'Graph settings must be valid JSON.' })
    const invalidConfig = await ctx.commands.execute(agent, '/graph config {}', [], signal)
    expect(invalidConfig?.result).toMatchObject({ kind: 'error' })
    const valid = { ...defaultGraphModeConfig(), active: true }
    const saved = await ctx.commands.execute(agent, `/graph config ${JSON.stringify(valid)}`, [], signal)
    expect(saved?.result).toMatchObject({ kind: 'success', text: 'Graph settings saved.' })
    const activeAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(activeAssembly.sections.find(section => section.name === 'graph:controller')?.text).toContain('Current graph: none')
    const inheritedRoute = await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 2, step: 1, signal },
      () => Promise.resolve({ provider: 'base', model: 'base' }),
    )
    expect(inheritedRoute).toEqual({ provider: 'base', model: 'base' })

    const original = ctx.graphMode.setConfig.bind(ctx.graphMode)
    ctx.graphMode.setConfig = () => { throw 'write failed' }
    const nonError = await ctx.commands.execute(agent, `/graph config ${JSON.stringify(valid)}`, [], signal)
    expect(nonError?.result).toMatchObject({ kind: 'error', text: 'write failed' })
    ctx.graphMode.setConfig = original
  })

  it('executes graph_submit through the tool boundary and renders both outcomes', async () => {
    const { ctx, agent } = await harness()
    const signal = new AbortController().signal
    const withoutAgent = await ctx.tools.execute({
      signal, callId: CallId('without-agent'), name: 'graph_submit',
      arguments: { intent: 'direct', reason: 'answer directly' },
    })
    expect(withoutAgent.isError).toBe(true)

    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'graph_submit')?.parameters
    expect(schema).toMatchObject({
      properties: {
        graph: {
          additionalProperties: true,
          properties: {
            nodes: { items: { additionalProperties: false, properties: { roleId: { type: 'string' } } } },
            edges: { items: { additionalProperties: false, properties: { condition: { additionalProperties: false } } } },
          },
        },
      },
    })
    expect(schema).not.toHaveProperty('properties.graph.properties.createdAt')
    expect(schema).not.toHaveProperty('properties.graph.properties.graphId')
    expect(schema).not.toHaveProperty('properties.graph.properties.revision')
    expect(schema).not.toHaveProperty('properties.graph.properties.parentRevision')
    expect(schema).not.toHaveProperty('properties.graph.properties.terminationPolicy')
    expect(schema).not.toHaveProperty('properties.changedNodeIds')
    expect(schema).toHaveProperty('properties.graph.properties.nodes.items.properties.workspace')
    expect(schema).not.toHaveProperty('properties.graph.properties.nodes.items.properties.workspace.properties.readRoots.required')
    expect(schema).not.toHaveProperty('properties.graph.properties.nodes.items.properties.workspace.properties.cleanup.required')
    expect(schema).not.toHaveProperty('properties.graph.properties.nodes.items.required', expect.arrayContaining(['outputSchema']))
    expect(schema).toHaveProperty(
      'properties.campaign.properties.batchId.description',
      expect.stringContaining('first batch in plan or planExtension'),
    )
    expect(schema).toHaveProperty(
      'properties.campaign.properties.plan.description',
      expect.stringContaining('only while starting its first listed batch'),
    )
    expect(schema).toHaveProperty(
      'properties.campaign.properties.planExtension.properties.batches.items.properties.dependsOn.items.type',
      'string',
    )
    const direct = await ctx.tools.execute({
      signal, callId: CallId('direct'), name: 'graph_submit', agent,
      arguments: { intent: 'direct', reason: 'answer directly' },
    })
    expect(direct).toMatchObject({
      isError: false,
      value: { accepted: true, intent: 'direct' },
      content: [{ type: 'text', text: 'Controller classification accepted: direct.' }],
    })
    const rejected = await ctx.tools.execute({
      signal, callId: CallId('invalid-new'), name: 'graph_submit', agent,
      arguments: {
        intent: 'new', reason: 'invalid work',
        graph: { graphId: 'bad graph id', objective: ' ', userInput: '', nodes: [] },
      },
    })
    expect(rejected.isError).toBe(true)
    const rejectedText = rejected.content.find(item => item.type === 'text')
    expect(rejectedText?.type === 'text' ? rejectedText.text : '').toContain('Corrected minimal example: {"objective"')
    expect(rejectedText?.type === 'text' ? rejectedText.text : '').not.toContain('"revision"')
    const rejectedWorkspace = await ctx.tools.execute({
      signal, callId: CallId('invalid-workspace'), name: 'graph_submit', agent,
      arguments: {
        intent: 'new', reason: 'invalid workspace',
        graph: {
          objective: 'Ship the requested change',
          userInput: 'invalid workspace',
          nodes: [{
            id: 'implementation', title: 'Implement', objective: 'Implement', kind: 'implementation', roleId: 'engineer',
            acceptanceCriteria: ['Implementation passes'], effectPolicy: 'idempotent',
            workspace: { mode: 'isolated-copy', readRoots: [''], writeRoots: ['src'] },
          }],
        },
      },
    })
    expect(rejectedWorkspace.isError).toBe(true)
    const workspaceText = rejectedWorkspace.content.find(item => item.type === 'text')
    expect(workspaceText?.type === 'text' ? workspaceText.text : '').toContain(
      'nodes[0].workspace.readRoots[0]: use "." for the whole workspace or a normalized source-relative path; empty roots are invalid',
    )
    const started = await ctx.tools.execute({
      signal, callId: CallId('new'), name: 'graph_submit', agent,
      arguments: {
        intent: 'new',
        reason: 'new work',
        graph: {
          graphId: 'bad graph id',
          "graphId'": '":".replace()',
          objective: 'Ship the requested change',
          userInput: 'revision 1',
          nodes: [
            {
              id: 'a', title: 'A', objective: 'A', kind: 'implementation', roleId: 'engineer',
              acceptanceCriteria: ['a accepted'], effectPolicy: 'idempotent',
            },
            {
              id: 'b', title: 'B', objective: 'B', kind: 'implementation', roleId: 'engineer',
              acceptanceCriteria: ['b accepted'], effectPolicy: 'idempotent',
            },
          ],
          edges: [{ from: 'a', to: 'b', kind: 'data' }],
        },
      },
    })
    expect(started.isError).toBe(false)
    const startedGraphId = ctx.graphMode.state(agent).currentGraphId
    expect(startedGraphId).toMatch(/^ship-the-requested-change-[a-f0-9]{12}$/)
    if (startedGraphId === undefined) throw new Error('new Graph submission did not assign an id')
    const startedProjection = ctx.graphMode.state(agent)
    const acceptedGraph = startedProjection.graphs[startedGraphId]?.[0]
    if (acceptedGraph === undefined) throw new Error('new Graph submission did not publish its revision')
    expect(typeof acceptedGraph?.createdAt).toBe('number')
    expect(acceptedGraph).toMatchObject({
      branchGroups: [],
      terminationPolicy: { ...defaultGraphExecutionPolicy(), onExhausted: 'awaiting_user' },
      nodes: [
        { id: 'a', maxAttempts: 3, weight: 1, skippable: false, outputSchema: { maxBytes: 262_144 } },
        { id: 'b', maxAttempts: 3, weight: 1, skippable: false, outputSchema: { maxBytes: 262_144 } },
      ],
    })
    const duplicate = resolveGraphControllerPlanDraft({
      objective: acceptedGraph.objective,
      userInput: acceptedGraph.userInput,
      nodes: acceptedGraph.nodes,
      edges: acceptedGraph.edges,
      branchGroups: acceptedGraph.branchGroups,
    }, 'new', startedProjection, startedProjection.config)
    expect(duplicate.graphId).toBe(`${startedGraphId}-2`)
    const rendered = started.content[0]
    expect(rendered?.type).toBe('text')
    if (rendered?.type === 'text') expect(rendered.text).toContain('not a JobRuntime job')
    await settled(ctx, agent, 1)
    const revised = await ctx.tools.execute({
      signal, callId: CallId('revise'), name: 'graph_submit', agent,
      arguments: {
        intent: 'revise',
        reason: 'change B',
        graph: {
          graphId: 'stale-controller-id',
          revision: 42,
          parentRevision: 41,
          parentRevisionNumber: 41,
          createdAt: 1,
          objective: 'Ship the requested change',
          userInput: 'revision 2',
          nodes: [
            {
              id: 'a', title: 'A', objective: 'A', kind: 'implementation', roleId: 'engineer',
              acceptanceCriteria: ['a accepted'], effectPolicy: 'idempotent',
            },
            {
              id: 'b', title: 'B', objective: 'B2', kind: 'implementation', roleId: 'engineer',
              acceptanceCriteria: ['b accepted'], effectPolicy: 'idempotent',
            },
          ],
          edges: [{ from: 'a', to: 'b', kind: 'data' }],
          terminationPolicy: { maxGraphRevisions: 1 },
          changedNodeIds: ['a'],
        },
        changedNodeIds: ['a'],
      },
    })
    expect(revised.isError).toBe(false)
    await settled(ctx, agent, 2)
    const projection = ctx.graphMode.state(agent)
    expect(projection.graphs[startedGraphId]?.[1]).toMatchObject({
      graphId: startedGraphId, revision: 2, parentRevision: 1,
      terminationPolicy: { maxGraphRevisions: defaultGraphExecutionPolicy().maxGraphRevisions },
    })
    expect(Object.values(projection.submissions).find(item => item.graph.revision === 2)?.changedNodeIds).toEqual(['b'])
    expect(Object.values(projection.submissions).find(item => item.graph.revision === 2)?.lineage).toMatchObject({
      kind: 'analysis_refactor',
      reason: 'change B',
      trigger: { source: 'user', summary: 'change B' },
      relationships: [{ kind: 'refactors', graphId: startedGraphId, revision: 1 }],
      changes: { changedNodeIds: ['b'], preservedNodeIds: ['a'], invalidatedNodeIds: ['b'] },
    })
  })

  it('requires explicit disjoint workspace ownership for concurrent mutating controller nodes', async () => {
    const { ctx, agent } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const projection = ctx.graphMode.state(agent)
    const nodes = [
      {
        id: GraphNodeId('backend'), title: 'Backend', objective: 'Implement the backend', kind: 'implementation' as const,
        roleId: GraphRoleId('engineer'), acceptanceCriteria: ['Backend passes'], effectPolicy: 'idempotent' as const,
      },
      {
        id: GraphNodeId('frontend'), title: 'Frontend', objective: 'Implement the frontend', kind: 'implementation' as const,
        roleId: GraphRoleId('engineer'), acceptanceCriteria: ['Frontend passes'], effectPolicy: 'idempotent' as const,
      },
    ]
    expect(() => resolveGraphControllerPlanDraft({
      objective: 'Ship both surfaces', userInput: 'Build the feature', nodes,
    }, 'new', projection, projection.config)).toThrow(/concurrent mutating work requires an explicit workspace policy/)

    const resolved = resolveGraphControllerPlanDraft({
      objective: 'Ship both surfaces',
      userInput: 'Build the feature',
      nodes: [
        { ...nodes[0]!, workspace: { mode: 'isolated-copy', writeRoots: ['backend'] } },
        { ...nodes[1]!, workspace: { mode: 'isolated-copy', writeRoots: ['frontend'] } },
      ],
    }, 'new', projection, projection.config)
    expect(resolved.nodes.map(node => node.workspace)).toEqual([
      { mode: 'isolated-copy', readRoots: ['.'], writeRoots: ['backend'], cleanup: 'retain-on-failure' },
      { mode: 'isolated-copy', readRoots: ['.'], writeRoots: ['frontend'], cleanup: 'retain-on-failure' },
    ])
  })

  it('derives revision changes from values rather than object property order', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'A complete', artifacts: [] }),
      workerResult({ summary: 'B complete', artifacts: [] }),
      workerResult({ summary: 'B revised', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, { intent: 'new', reason: 'initial values', graph: revision(1, 'A', 'B') })
    await settled(ctx, agent, 1)

    const next = revision(2, 'A', 'B revised')
    const a = next.nodes[0] as GraphNode
    const reorderedA: GraphNode = {
      id: a.id,
      title: a.title,
      objective: a.objective,
      kind: a.kind,
      roleId: a.roleId,
      acceptanceCriteria: a.acceptanceCriteria,
      effectPolicy: a.effectPolicy,
      outputSchema: a.outputSchema,
      maxAttempts: a.maxAttempts,
      weight: a.weight,
      executionBudget: a.executionBudget,
      skippable: a.skippable,
    }
    await ctx.graphMode.submit(agent, {
      intent: 'revise', reason: 'change B only', graph: { ...next, nodes: [reorderedA, next.nodes[1] as GraphNode] },
    })
    const run = await terminal(ctx, agent, 2)
    const state = ctx.graphMode.state(agent)
    expect(Object.values(state.submissions).find(item => item.graph.revision === 2)?.changedNodeIds).toEqual(['b'])
    expect(run.nodes['a']).toMatchObject({ phase: 'succeeded', attempts: [], reusedFrom: { nodeId: 'a' } })
    expect(provider.requests).toHaveLength(3)
  })

  it('advances ordered campaign batches as independent graphs without copying historical nodes', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'batch one accepted', artifacts: [] }),
      workerResult({ summary: 'batch two accepted', artifacts: [] }),
    ])
    const { ctx, agent, followup } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const first = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'start campaign batch one',
      graph: singleRevision('campaign-batch-one'),
      campaign: {
        batchId: 'batch-01',
        plan: {
          objective: 'Complete the acceptance campaign',
          batches: [
            { id: 'batch-01', title: 'Batch 01', objective: 'Accept batch one' },
            { id: 'batch-02', title: 'Batch 02', objective: 'Accept batch two', dependsOn: ['batch-01'] },
          ],
        },
      },
    })
    await terminalRunId(ctx, agent, first.runId as string)
    await vi.waitFor(() => {
      const campaign = Object.values(ctx.graphMode.state(agent).campaigns)[0]
      expect(campaign).toMatchObject({
        phase: 'running', activeBatchId: 'batch-02',
        batches: [{ id: 'batch-01', status: 'approved' }, { id: 'batch-02', status: 'planned' }],
      })
    })
    const batchFollowup = followup.mock.lastCall?.[0] as { readonly content: readonly { readonly text?: string }[] }
    expect(batchFollowup.content[0]?.text).toContain('[graph-batch-complete]')

    const second = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'start campaign batch two',
      graph: singleRevision('campaign-batch-two'),
      campaign: { batchId: 'batch-02' },
    })
    await terminalRunId(ctx, agent, second.runId as string)
    await vi.waitFor(() => {
      const campaign = Object.values(ctx.graphMode.state(agent).campaigns)[0]
      expect(campaign).toMatchObject({
        phase: 'succeeded',
        batches: [{ id: 'batch-01', status: 'approved' }, { id: 'batch-02', status: 'approved' }],
      })
    })
    const state = ctx.graphMode.state(agent)
    expect(state.graphs['campaign-batch-one']?.[0]?.nodes).toHaveLength(1)
    expect(state.graphs['campaign-batch-two']?.[0]?.nodes).toHaveLength(1)
    const secondPrompt = provider.requests[1]?.prompt[0]
    expect(secondPrompt?.type).toBe('text')
    expect(secondPrompt?.type === 'text' ? secondPrompt.text : '').toContain('"batchId":"batch-01"')
  })

  it('appends an audited batch suffix after the registered campaign is accepted', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'bootstrap accepted', artifacts: [] }),
      workerResult({ summary: 'customer batch accepted', artifacts: [] }),
      workerResult({ summary: 'diagnosis batch accepted', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const first = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'start the known bootstrap batch',
      graph: singleRevision('campaign-extension-bootstrap'),
      campaign: {
        batchId: 'batch-01',
        plan: {
          objective: 'Complete the acceptance campaign',
          batches: [{ id: 'batch-01', title: 'Bootstrap', objective: 'Discover the tested product' }],
        },
      },
    })
    await terminalRunId(ctx, agent, first.runId as string)
    await vi.waitFor(() => {
      expect(Object.values(ctx.graphMode.state(agent).campaigns)[0]?.phase).toBe('succeeded')
    })

    const second = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'accepted inventory discovered customer and diagnosis batches',
      graph: singleRevision('campaign-extension-customers'),
      campaign: {
        batchId: 'batch-02',
        planExtension: {
          batches: [
            { id: 'batch-02', title: 'Customers', objective: 'Accept customer workflows', dependsOn: ['batch-01'] },
            { id: 'batch-03', title: 'Diagnoses', objective: 'Accept diagnosis workflows', dependsOn: ['batch-02'] },
          ],
        },
      },
    })
    await terminalRunId(ctx, agent, second.runId as string)
    await vi.waitFor(() => {
      const campaign = Object.values(ctx.graphMode.state(agent).campaigns)[0]
      expect(campaign).toMatchObject({
        phase: 'running',
        activeBatchId: 'batch-03',
        planRevision: 2,
        planExtensions: [{
          revision: 2,
          reason: 'accepted inventory discovered customer and diagnosis batches',
          addedBatchIds: ['batch-02', 'batch-03'],
          sourceBatchId: 'batch-01',
          sourceRunId: first.runId,
        }],
        batches: [
          { id: 'batch-01', status: 'approved' },
          { id: 'batch-02', status: 'approved' },
          { id: 'batch-03', status: 'planned' },
        ],
      })
    })

    const third = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'start the next appended batch',
      graph: singleRevision('campaign-extension-diagnoses'),
      campaign: { batchId: 'batch-03' },
    })
    await terminalRunId(ctx, agent, third.runId as string)
    await vi.waitFor(() => {
      const campaign = Object.values(ctx.graphMode.state(agent).campaigns)[0]
      expect(campaign).toMatchObject({
        phase: 'succeeded',
        planRevision: 2,
        batches: [
          { id: 'batch-01', status: 'approved' },
          { id: 'batch-02', status: 'approved' },
          { id: 'batch-03', status: 'approved' },
        ],
      })
    })
  })

  it('rejects plan extension while a registered batch remains planned', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'batch one accepted', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const first = await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'start campaign',
      graph: singleRevision('campaign-extension-not-ready'),
      campaign: {
        batchId: 'batch-01',
        plan: {
          objective: 'Complete the acceptance campaign',
          batches: [
            { id: 'batch-01', title: 'Batch 01', objective: 'Accept batch one' },
            { id: 'batch-02', title: 'Batch 02', objective: 'Accept batch two', dependsOn: ['batch-01'] },
          ],
        },
      },
    })
    await terminalRunId(ctx, agent, first.runId as string)
    await vi.waitFor(() => {
      expect(Object.values(ctx.graphMode.state(agent).campaigns)[0]).toMatchObject({
        phase: 'running', activeBatchId: 'batch-02',
      })
    })

    await expect(ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'append too early',
      graph: singleRevision('campaign-extension-too-early'),
      campaign: {
        batchId: 'batch-03',
        planExtension: { batches: [{ id: 'batch-03', title: 'Batch 03', objective: 'Accept batch three' }] },
      },
    })).rejects.toThrow('campaign planExtension requires every registered batch to be accepted and no active batch')
  })

  it('retains settled campaign execution history when a revision replaces an active batch', async () => {
    const provider = new GraphWorkerProvider([
      abortResult,
      workerResult({ summary: 'replacement accepted', artifacts: [] }),
    ])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const firstGraph = singleRevision('campaign-revision-replacement')
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new',
      reason: 'start campaign batch',
      graph: firstGraph,
      campaign: {
        batchId: 'batch-01',
        plan: {
          objective: 'Complete the acceptance campaign',
          batches: [{ id: 'batch-01', title: 'Batch 01', objective: 'Accept batch one' }],
        },
      },
    })
    await waitForRequests(provider, 1)

    const replacementGraph: GraphRevision = {
      ...firstGraph,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'revise the active batch',
      nodes: firstGraph.nodes.map(node => ({ ...node, objective: 'complete revised A' })),
    }
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'revise', reason: 'replace active campaign work', graph: replacementGraph,
    })
    await terminal(active.ctx, active.agent, 2)
    await vi.waitFor(() => {
      const campaign = Object.values(active.ctx.graphMode.state(active.agent).campaigns)[0]
      expect(campaign).toMatchObject({
        phase: 'succeeded',
        batches: [{
          id: 'batch-01',
          executions: [{ status: 'canceled' }, { status: 'succeeded' }],
        }],
      })
    })

    expect(() => foldGraph(active.agent.session.events)).not.toThrow()
  })

  it('explains how to correct a campaign that starts with a later ordered batch', async () => {
    const active = await harness()
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })

    await expect(active.ctx.graphMode.submit(active.agent, {
      intent: 'new',
      reason: 'incorrectly start campaign batch two',
      graph: singleRevision('campaign-invalid-start'),
      campaign: {
        batchId: 'batch-02',
        plan: {
          objective: 'Complete the acceptance campaign',
          batches: [
            { id: 'batch-01', title: 'Batch 01', objective: 'Accept batch one' },
            { id: 'batch-02', title: 'Batch 02', objective: 'Accept batch two', dependsOn: ['batch-01'] },
          ],
        },
      },
    })).rejects.toThrow(
      'campaign.batchId "batch-02" must equal campaign.plan.batches[0].id "batch-01" when creating a campaign; '
      + 'to start a later batch after [graph-batch-complete], omit campaign.plan and submit only campaign.batchId',
    )
    expect(Object.values(active.ctx.graphMode.state(active.agent).campaigns)).toHaveLength(0)
  })

  it('admits only deployment-authorized environment plans and owns their execution policy', () => {
    const projection = foldGraph([])
    const config = defaultGraphModeConfig()
    const draft = {
      objective: 'Prepare Maven',
      userInput: 'Install Maven',
      nodes: [{
        id: GraphNodeId('prepare-maven'),
        title: 'Prepare Maven',
        objective: 'Install Maven on the host',
        kind: 'environment' as const,
        roleId: GraphRoleId('environment'),
        acceptanceCriteria: ['mvn --version succeeds'],
        environment: {
          requiredCapabilities: ['network', 'host-package-install'] as const,
          sandboxMode: 'danger-full-access' as const,
          operations: [{ id: 'install', description: 'Install Maven', command: 'winget install Apache.Maven' }],
        },
        effectPolicy: 'manual' as const,
      }],
    }
    expect(() => resolveGraphControllerPlanDraft(
      draft, 'new', projection, config, Date.now(),
      { enabled: false, capabilities: [], dangerFullAccess: false },
    )).toThrow(/environment nodes are disabled/)

    const resolved = resolveGraphControllerPlanDraft(
      draft, 'new', projection, config, Date.now(),
      { enabled: true, capabilities: ['network', 'host-package-install'], dangerFullAccess: true },
    )
    expect(resolved.nodes[0]).toMatchObject({
      kind: 'environment',
      maxAttempts: 1,
      effectPolicy: 'manual',
      workspace: { mode: 'shared', readRoots: ['.'], writeRoots: ['.'], cleanup: 'retain' },
    })
  })

  it.each([
    ['empty read root', { mode: 'isolated-copy', readRoots: [''], writeRoots: ['src'] }, /readRoots\[0\].*empty roots are invalid/],
    ['absolute read root', { mode: 'isolated-copy', readRoots: ['D:/work'], writeRoots: ['src'] }, /readRoots\[0\].*absolute paths are forbidden/],
    ['backslash read root', { mode: 'isolated-copy', readRoots: ['src\\main'], writeRoots: ['src'] }, /readRoots\[0\].*forward slashes/],
    ['unnormalized write root', { mode: 'isolated-copy', writeRoots: ['src/../other'] }, /writeRoots\[0\].*normalized source-relative path/],
    ['duplicate write root', { mode: 'isolated-copy', writeRoots: ['src', 'src'] }, /writeRoots\[1\].*duplicate root/],
    ['read-only write root', { mode: 'read-only-snapshot', writeRoots: ['src'] }, /writeRoots: use an empty array/],
    ['missing write roots', { mode: 'isolated-copy' }, /writeRoots: provide an array/],
    ['invalid cleanup', { mode: 'isolated-copy', writeRoots: ['src'], cleanup: 'discard' }, /cleanup: choose delete-on-settlement/],
    ['unknown workspace field', { mode: 'isolated-copy', writeRoots: ['src'], allocationId: 'forbidden' }, /allocationId: unknown workspace field/],
  ])('reports the exact controller workspace field for %s', (_label, workspace, expected) => {
    const config = defaultGraphModeConfig()
    const projection = foldGraph([])
    expect(() => resolveGraphControllerPlanDraft({
      objective: 'Ship one surface',
      userInput: 'Build the feature',
      nodes: [{
        id: GraphNodeId('implementation'), title: 'Implement', objective: 'Implement the feature', kind: 'implementation',
        roleId: GraphRoleId('engineer'), acceptanceCriteria: ['Feature passes'], effectPolicy: 'idempotent',
        workspace: workspace as NonNullable<GraphRevisionDraft['nodes'][number]['workspace']>,
      }],
    }, 'new', projection, config)).toThrow(expected)
  })

  it('rejects invalid controller classifications before graph execution', async () => {
    const inactive = await harness()
    await expect(inactive.ctx.graphMode.submit(inactive.agent, {
      intent: 'new', reason: 'new', graph: revision(1, 'A', 'B'),
    })).rejects.toThrow(/only while graph mode is active/)

    const { ctx, agent } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await expect(ctx.graphMode.submit(agent, { intent: 'direct', reason: ' ' })).rejects.toThrow(/reason/)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'inspect', reason: 'inspect', graph: revision(1, 'A', 'B'),
    })).rejects.toThrow(/cannot carry a graph/)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'control', reason: 'control', changedNodeIds: [GraphNodeId('a')],
    })).rejects.toThrow(/cannot carry a graph/)
    await expect(ctx.graphMode.submit(agent, { intent: 'new', reason: 'new' })).rejects.toThrow(/requires a graph/)

    await ctx.graphMode.submit(agent, { intent: 'new', reason: 'new', graph: revision(1, 'A', 'B') })
    await settled(ctx, agent, 1)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'new', reason: 'duplicate', graph: revision(1, 'A2', 'B'),
    })).rejects.toThrow(/new graph id/)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'revise', reason: 'wrong graph', graph: { ...revision(2, 'A2', 'B'), graphId: GraphId('other') },
    })).rejects.toThrow(/current graph/)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'revise', reason: 'wrong number', graph: { ...revision(2, 'A2', 'B'), revision: 3, parentRevision: 2 },
    })).rejects.toThrow(/immediately follow/)
    await expect(ctx.graphMode.submit(agent, {
      intent: 'revise', reason: 'unchanged', graph: revision(2, 'A', 'B'),
    })).rejects.toThrow(/change at least one node/)
  })

  it('executes dependencies, reruns transitive successors, and reuses unaffected results', async () => {
    const { ctx, provider, agent, followup } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })

    await ctx.graphMode.submit(agent, { intent: 'new', reason: 'new request', graph: revision(1, 'first A', 'first B') })
    await settled(ctx, agent, 1)
    expect(provider.requests).toHaveLength(2)

    await ctx.graphMode.submit(agent, {
      intent: 'revise',
      reason: 'change the prerequisite',
      graph: revision(2, 'revised A', 'first B'),
      changedNodeIds: [GraphNodeId('a')],
    })
    await settled(ctx, agent, 2)
    expect(provider.requests).toHaveLength(4)

    await ctx.graphMode.submit(agent, {
      intent: 'revise',
      reason: 'change only the successor',
      graph: revision(3, 'revised A', 'revised B'),
      changedNodeIds: [GraphNodeId('b')],
    })
    await settled(ctx, agent, 3)
    expect(provider.requests).toHaveLength(5)
    const latest = Object.values(ctx.graphMode.state(agent).runs).find(run => run.revision === 3)
    expect(latest?.nodes['a']).toMatchObject({ phase: 'succeeded', attempts: [], reusedFrom: { nodeId: 'a' } })
    expect(latest?.nodes['b']?.attempts).toHaveLength(1)
    expect(followup).toHaveBeenCalledTimes(3)
  })

  it('recovers idempotent interrupted work under a fenced generation and preserves attempt numbering', async () => {
    const { ctx, agent, provider } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph = singleRevision('recovery-graph', 2)
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
    const runId = GraphRunId('recovery-run')
    const workId = GraphWorkId('recovery-work')
    const generationId = GraphRunGenerationId('recovery-generation-1')
    agent.session.append('graph/run', {
      id: runId,
      graphId: graph.graphId,
      revision: graph.revision,
      generation: 1,
      generationId,
      ownerEpoch: 1,
      configSnapshot: { ...defaultGraphModeConfig(), active: true },
      overrides: {},
      phase: 'running',
      createdAt: 1,
      updatedAt: 2,
      nodes: {
        a: {
          workId,
          nodeId: GraphNodeId('a'),
          phase: 'running',
          attempts: [{ id: GraphAttemptId('interrupted-attempt'), number: 1, startedAt: 1 }],
        },
      },
    })
    const operationId = GraphControlOperationId('recovery-operation-1')
    for (const [index, stage] of (['planned', 'admitted', 'started'] as const).entries()) {
      agent.session.append('graph/operation', {
        version: 1,
        eventId: GraphOperationEventId(`recovery-event-${String(index + 1)}`),
        operationId,
        workId,
        runId,
        generationId,
        graphId: graph.graphId,
        revision: 1,
        nodeId: GraphNodeId('a'),
        ownerEpoch: 1,
        stage,
        ...index === 0 ? {} : { expectedPrevious: (['planned', 'admitted'] as const)[index - 1] },
        at: index + 1,
        externalReferences: [],
      })
    }

    await ctx.graphMode.recover(agent)
    const recovered = await terminal(ctx, agent, 1)
    expect(recovered).toMatchObject({ id: runId, generation: 2, ownerEpoch: 2, phase: 'succeeded' })
    expect(recovered.nodes['a']?.attempts.map(attempt => attempt.number)).toEqual([1, 2])
    expect(provider.requests).toHaveLength(1)
    const journal = ctx.graphMode.state(agent).operations[workId] ?? []
    expect(journal.map(item => item.stage)).toEqual([
      'planned', 'admitted', 'started', 'reconciled', 'admitted', 'started', 'output-staged', 'terminal',
    ])
    expect(journal[3]).toMatchObject({ ownerEpoch: 2, generationId: recovered.generationId })
  })

  it('settles orphan model capacity and cancels a still-claimed LoopX todo during recovery', async () => {
    const resources = new TestGraphResourceProvider()
    const active = await harness({
      resources,
      cwd: 'D:/work',
      coordination: {
        reconcileResult: {
          status: 'confirmed-running',
          observation: { status: 'claimed', cursor: '4', events: [], compacted: false },
          evidence: 'prior lease is still claimed',
        },
      },
    })
    const graph = singleRevision('orphan-recovery', 2)
    active.agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
    const runId = GraphRunId('orphan-run')
    const generationId = GraphRunGenerationId('orphan-generation')
    const workId = GraphWorkId('orphan-work')
    active.agent.session.append('graph/run', {
      id: runId, graphId: graph.graphId, revision: 1, generation: 1, generationId, ownerEpoch: 1,
      configSnapshot: { ...defaultGraphModeConfig(), active: true }, overrides: {}, phase: 'running', createdAt: 1, updatedAt: 4,
      nodes: { a: { workId, nodeId: GraphNodeId('a'), phase: 'running', attempts: [{ id: GraphAttemptId('orphan-attempt'), number: 1, startedAt: 2 }] } },
    })
    const stages = ['planned', 'admitted', 'claimed', 'started'] as const
    for (const [index, stage] of stages.entries()) {
      active.agent.session.append('graph/operation', {
        version: 1,
        eventId: GraphOperationEventId(`orphan-event-${String(index)}`),
        operationId: GraphControlOperationId('orphan-operation'),
        workId,
        runId,
        generationId,
        graphId: graph.graphId,
        revision: 1,
        nodeId: GraphNodeId('a'),
        ownerEpoch: 1,
        stage,
        ...index === 0 ? {} : { expectedPrevious: stages[index - 1] },
        at: index + 1,
        externalReferences: stage === 'admitted'
          ? [{ kind: 'model', provider: resources.name, id: 'reservation:orphan', fencingToken: 1 }]
          : stage === 'claimed'
            ? [
              { kind: 'coordination', provider: 'graph-coordination', id: 'claim-a' },
              { kind: 'coordination', provider: 'graph-coordination-lease', id: 'lease-a', fencingToken: 1 },
            ]
            : stage === 'started'
              ? [{ kind: 'worker', provider: 'local', id: 'worker:orphan' }]
              : [],
      })
    }

    await active.ctx.graphMode.recover(active.agent)
    expect(resources.reconciliations).toEqual([expect.objectContaining({ reservationId: 'reservation:orphan', workId })])
    expect(active.coordination?.cancellations).toEqual([expect.objectContaining({
      claimId: 'claim-a', leaseId: 'lease-a', workId,
    })])
    expect(active.coordination?.settlements[0]).toMatchObject({
      claimId: 'claim-a', leaseId: 'lease-a', workId, outcome: 'canceled',
    })
    const recoveredRun = await terminalRunId(active.ctx, active.agent, runId)
    expect(recoveredRun).toMatchObject({
      generation: 2, ownerEpoch: 2, phase: 'succeeded', nodes: { a: { phase: 'succeeded' } },
    })
    const recovered = active.ctx.graphMode.state(active.agent)
    expect(Object.values(recovered.settlements).flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resource-release', outcome: 'confirmed', attempt: 1 }),
      expect.objectContaining({ kind: 'cancellation', outcome: 'confirmed', attempt: 1 }),
    ]))
    const terminalCancellation = Object.values(recovered.settlements).flat()
      .find(item => item.kind === 'coordination' && item.outcome === 'confirmed')
    expect(terminalCancellation).toMatchObject({ kind: 'coordination', outcome: 'confirmed' })
    expect(terminalCancellation?.evidence).toContain('canceled during recovery')
  })

  it('settles durable staged output during recovery without re-running the Worker', async () => {
    const active = await harness({ coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph = singleRevision('staged-recovery', 2)
    active.agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
    const runId = GraphRunId('staged-recovery-run')
    const generationId = GraphRunGenerationId('staged-recovery-generation')
    const workId = GraphWorkId('staged-recovery-work')
    active.agent.session.append('graph/run', {
      id: runId, graphId: graph.graphId, revision: 1, generation: 1, generationId, ownerEpoch: 1,
      configSnapshot: { ...defaultGraphModeConfig(), active: true }, overrides: {}, phase: 'running', createdAt: 1, updatedAt: 2,
      nodes: { a: { workId, nodeId: GraphNodeId('a'), phase: 'running', attempts: [{ id: GraphAttemptId('staged-attempt'), number: 1, startedAt: 1 }], output: { summary: 'durable result', coordinationSummary: 'public durable result', artifacts: [] } } },
    })
    const stages = ['planned', 'admitted', 'claimed', 'started', 'output-staged'] as const
    for (const [index, stage] of stages.entries()) {
      active.agent.session.append('graph/operation', {
        version: 1, eventId: GraphOperationEventId(`staged-event-${String(index)}`), operationId: GraphControlOperationId('staged-operation'),
        workId, runId, generationId, graphId: graph.graphId, revision: 1, nodeId: GraphNodeId('a'), ownerEpoch: 1, stage,
        ...index === 0 ? {} : { expectedPrevious: stages[index - 1] }, at: index + 1,
        externalReferences: stage === 'claimed' ? [
          { kind: 'coordination', provider: 'graph-coordination', id: 'claim-a' },
          { kind: 'coordination', provider: 'graph-coordination-lease', id: 'lease-a', fencingToken: 1 },
        ] : [],
        ...stage === 'output-staged' ? { outputHash: 'sha256:staged' } : {},
      })
    }

    await active.ctx.graphMode.recover(active.agent)
    const recovered = active.ctx.graphMode.state(active.agent).runs[runId]
    expect(recovered).toMatchObject({ generation: 2, ownerEpoch: 2, phase: 'succeeded', nodes: { a: { phase: 'succeeded', output: { summary: 'durable result' } } } })
    expect(active.provider.requests).toHaveLength(0)
    expect(active.coordination?.settlements).toEqual([expect.objectContaining({ outcome: 'succeeded', evidence: 'public durable result' })])
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'coordination', outcome: 'confirmed' }),
    ]))
  })

  it('holds uncertain manual effects for user adjudication during recovery', async () => {
    const { ctx, agent, provider } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph = {
      ...singleRevision('manual-recovery', 2),
      nodes: [{ ...task('a', 'perform external effect'), effectPolicy: 'manual' as const, maxAttempts: 2 }],
    }
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
    agent.session.append('graph/run', {
      id: GraphRunId('manual-run'), graphId: graph.graphId, revision: 1, generation: 1,
      generationId: GraphRunGenerationId('manual-generation-1'), ownerEpoch: 1,
      configSnapshot: { ...defaultGraphModeConfig(), active: true }, overrides: {},
      phase: 'running', createdAt: 1, updatedAt: 2,
      nodes: { a: { workId: GraphWorkId('manual-work'), nodeId: GraphNodeId('a'), phase: 'running', attempts: [] } },
    })
    agent.session.append('graph/operation', {
      version: 1, eventId: GraphOperationEventId('manual-event-1'), operationId: GraphControlOperationId('manual-operation-1'),
      workId: GraphWorkId('manual-work'), runId: GraphRunId('manual-run'), generationId: GraphRunGenerationId('manual-generation-1'),
      graphId: graph.graphId, revision: 1, nodeId: GraphNodeId('a'), ownerEpoch: 1, stage: 'planned', at: 1, externalReferences: [],
    })

    await ctx.graphMode.recover(agent)
    const recovered = ctx.graphMode.state(agent).runs['manual-run']
    expect(recovered).toMatchObject({ generation: 2, ownerEpoch: 2, phase: 'awaiting_user', nodes: { a: { phase: 'awaiting_user' } } })
    expect(provider.requests).toEqual([])

    const record = await ctx.graphMode.control(agent, {
      operationId: GraphControlOperationId('manual-reconcile-control'),
      action: 'reconcile-run',
      ...controlAddress(ctx, agent, GraphRunId('manual-run')),
      reason: 'check again for externally provable completion evidence',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'recovery' })
    expect(ctx.graphMode.state(agent).runs['manual-run']).toMatchObject({
      generation: 3, ownerEpoch: 3, phase: 'awaiting_user', nodes: { a: { phase: 'awaiting_user' } },
    })
    expect(record).toMatchObject({
      action: 'reconcile-run', resultingGeneration: 3, result: { outcome: 'applied' },
    })
    expect(provider.requests).toEqual([])
  })

  it('pauses on a validated expansion proposal and resolves it through an immutable revision', async () => {
    const added = { ...task('generated', 'implement generated work'), id: GraphNodeId('generated') }
    const provider = new GraphWorkerProvider([
      workerResult({
        summary: 'proposed one generated node',
        artifacts: [],
        data: {
          proposal: {
            baseRevision: 1,
            nodes: [added],
            edges: [{ from: GraphNodeId('expand'), to: GraphNodeId('generated'), kind: 'control' }],
            branchGroups: [],
            changedNodeIds: [GraphNodeId('generated')],
          },
        },
      }),
      workerResult({ summary: 'generated work complete', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const expansionNode = {
      ...task('expand', 'propose bounded work'),
      kind: 'expansion' as const,
      expansion: { mode: 'controller' as const, maxNodes: 2 },
    }
    const first: GraphRevision = {
      ...singleRevision('expansion-graph'),
      nodes: [expansionNode],
    }
    await ctx.graphMode.submit(agent, { intent: 'new', reason: 'expand', graph: first })
    const paused = await runWithPhase(ctx, agent, 1, 'paused')
    expect(paused.nodes['expand']?.phase).toBe('succeeded')
    const checkpoint = Object.values(ctx.graphMode.state(agent).checkpoints)[0]
    expect(checkpoint).toMatchObject({ kind: 'expansion', status: 'pending', proposal: { baseRevision: 1 } })

    const second: GraphRevision = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'commit expansion',
      nodes: [expansionNode, added],
      edges: [{ from: GraphNodeId('expand'), to: GraphNodeId('generated'), kind: 'control' }],
    }
    await ctx.graphMode.submit(agent, { intent: 'revise', reason: 'accept expansion', graph: second, changedNodeIds: [GraphNodeId('generated')] })
    expect((await terminal(ctx, agent, 2)).phase).toBe('succeeded')
    expect(ctx.graphMode.state(agent).checkpoints[checkpoint!.id]).toMatchObject({ status: 'resolved', replacementRevision: 2 })
    expect(provider.requests).toHaveLength(2)
  })

  it('turns structured review rejection into a repair revision and exact downstream rerun', async () => {
    const reviewer = {
      ...task('review', 'review implementation'),
      kind: 'review' as const,
      roleId: GraphRoleId('reviewer'),
    }
    const first = {
      ...singleRevision('repair-graph'),
      nodes: [task('a', 'implement v1'), reviewer],
      edges: [{ from: GraphNodeId('a'), to: GraphNodeId('review'), kind: 'control' as const }],
    }
    const issue = { id: 'review-issue-1', severity: 'blocking' as const, summary: 'implementation is incomplete', evidence: ['child-session'], ownerNodeIds: [GraphNodeId('a')] }
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'implemented v1', artifacts: [] }),
      workerResult({ summary: 'rejected', artifacts: [], data: { decision: 'rejected', issues: [issue] } }),
      workerResult({ summary: 'implemented v2', artifacts: [] }),
      workerResult({ summary: 'approved', artifacts: [], data: { decision: 'approved', issues: [] } }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, { intent: 'new', reason: 'implement and review', graph: first })
    await runWithPhase(ctx, agent, 1, 'paused')
    const checkpoint = Object.values(ctx.graphMode.state(agent).checkpoints)[0]
    expect(checkpoint).toMatchObject({ kind: 'repair', status: 'pending', issues: [{ id: 'review-issue-1' }] })
    const reviewPrompt = provider.requests[1]?.prompt[0]
    expect(reviewPrompt?.type).toBe('text')
    if (reviewPrompt?.type === 'text') expect(reviewPrompt.text).toContain('data.decision to approved, rejected, or needs-user')

    const second: GraphRevision = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'repair review issue',
      nodes: [{ ...first.nodes[0]!, objective: 'implement v2' }, reviewer],
    }
    await ctx.graphMode.submit(agent, { intent: 'revise', reason: 'repair rejection', graph: second, changedNodeIds: [GraphNodeId('a')] })
    const repaired = await terminal(ctx, agent, 2)
    expect(repaired.phase).toBe('succeeded')
    expect(repaired.nodes['a']?.attempts).toHaveLength(1)
    expect(repaired.nodes['review']?.attempts).toHaveLength(1)
    expect(ctx.graphMode.state(agent).checkpoints[checkpoint!.id]?.status).toBe('resolved')
  })

  it('executes an exact nested graph revision and maps only its aggregate output', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'child result', data: { value: 42, private: 'not mapped' }, artifacts: ['child.txt'] }),
    ])
    const { ctx, agent } = await harness({ provider, scheduler })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const child: GraphRevision = {
      ...singleRevision('child-graph'),
      nodes: [{ ...task('child', 'produce child output'), id: GraphNodeId('child') }],
    }
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph: child, current: false })
    const parentNode = {
      ...task('nested', 'run child graph'),
      kind: 'subgraph' as const,
      subgraph: {
        graphId: child.graphId,
        revision: 1,
        input: {},
        output: { result: ['nodes', 'child', 'data', 'value'] },
      },
    }
    const parent: GraphRevision = { ...singleRevision('parent-graph'), nodes: [parentNode] }
    const submitted = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'nested work', graph: parent })
    const run = await terminalRunId(ctx, agent, submitted.runId as string)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['nested']?.output).toMatchObject({ data: { result: 42 }, artifacts: ['child.txt'] })
    expect(run.nodes['nested']?.attempts[0]?.childRunId).toBeTruthy()
    const childRun = ctx.graphMode.state(agent).runs[run.nodes['nested']?.attempts[0]?.childRunId as string]
    expect(childRun).toMatchObject({ graphId: 'child-graph', phase: 'succeeded' })
    expect(scheduler.acquisitions.map(request => request.runId)).toEqual([run.id, childRun?.id])
    expect(scheduler.releases.map(request => request.runId).sort()).toEqual([run.id, childRun?.id].sort())
    expect(provider.requests[0]?.prompt[0]).toMatchObject({ type: 'text' })
  })

  it('rejects nested graph ancestry cycles before a recursive worker starts', async () => {
    const { ctx, agent, provider } = await harness()
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const nestedNode = (id: string, graphId: string) => ({
      ...task(id, `run ${graphId}`),
      kind: 'subgraph' as const,
      subgraph: { graphId: GraphId(graphId), revision: 1, input: {}, output: {} },
    })
    const a: GraphRevision = { ...singleRevision('cycle-a'), nodes: [nestedNode('to-b', 'cycle-b')] }
    const b: GraphRevision = { ...singleRevision('cycle-b'), nodes: [nestedNode('to-a', 'cycle-a')] }
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph: a, current: false })
    agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph: b, current: false })
    const parent: GraphRevision = { ...singleRevision('cycle-parent'), nodes: [nestedNode('to-a-root', 'cycle-a')] }
    const submitted = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'cycle test', graph: parent })
    const run = await terminalRunId(ctx, agent, submitted.runId as string)
    expect(run).toMatchObject({ phase: 'failed', error: { code: 'GRAPH_SUBGRAPH_FAILED' } })
    expect(provider.requests).toEqual([])
  })

  it('retries bounded worker failures and records terminal failure evidence', async () => {
    const success = workerResult({ summary: 'recovered', artifacts: [] })
    const retryProvider = new GraphWorkerProvider([() => Promise.reject(new Error('transient')), success])
    const retry = await harness({ provider: retryProvider })
    retry.ctx.graphMode.setConfig(retry.agent, { ...defaultGraphModeConfig(), active: true })
    await retry.ctx.graphMode.submit(retry.agent, {
      intent: 'new', reason: 'retry', graph: singleRevision('retry-graph', 2),
    })
    const recovered = await terminal(retry.ctx, retry.agent, 1)
    expect(recovered.phase).toBe('succeeded')
    expect(recovered.nodes['a']?.attempts).toHaveLength(2)
    expect(retryProvider.disposed).toHaveLength(2)

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises defensive rendering of provider violations.
    const failedProvider = new GraphWorkerProvider([() => Promise.reject('worker crashed')])
    const failed = await harness({ provider: failedProvider })
    failed.ctx.graphMode.setConfig(failed.agent, { ...defaultGraphModeConfig(), active: true })
    await failed.ctx.graphMode.submit(failed.agent, {
      intent: 'new', reason: 'fail', graph: dependentRevision('failed-graph', false),
    })
    const failedRun = await terminal(failed.ctx, failed.agent, 1)
    expect(failedRun.phase).toBe('failed')
    expect(failedRun.nodes['a']?.attempts[0]?.error).toMatchObject({
      code: 'GRAPH_NODE_ATTEMPT_FAILED', message: 'worker crashed',
    })
    expect(failedRun.nodes['b']?.phase).toBe('canceled')
    expect(failed.followup).toHaveBeenCalledOnce()

    const laterFailureProvider = new GraphWorkerProvider([
      workerResult({ summary: 'A complete', artifacts: [] }),
      () => Promise.reject(new Error('B failed')),
    ])
    const laterFailure = await harness({ provider: laterFailureProvider })
    laterFailure.ctx.graphMode.setConfig(laterFailure.agent, { ...defaultGraphModeConfig(), active: true })
    await laterFailure.ctx.graphMode.submit(laterFailure.agent, {
      intent: 'new', reason: 'later failure', graph: dependentRevision('later-failure', false),
    })
    expect((await terminal(laterFailure.ctx, laterFailure.agent, 1)).error).toMatchObject({
      nodeId: 'b', message: 'B failed',
    })
  })

  it('returns a deterministic workspace failure to the controller without repeating the node', async () => {
    const graphWorker = new RevisionRequiredGraphWorkerAdapter()
    const active = await harness({ graphWorker, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const base = singleRevision('workspace-revision-required', 3)
    const graph: GraphRevision = {
      ...base,
      nodes: base.nodes.map(node => ({
        ...node,
        workspace: {
          mode: 'isolated-copy' as const,
          readRoots: ['architecture'],
          writeRoots: ['docs/architecture'],
          cleanup: 'retain-on-failure' as const,
        },
      })),
    }

    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'exercise workspace correction', graph,
    })
    const run = await runWithPhase(active.ctx, active.agent, 1, 'paused')

    expect(graphWorker.assignments).toHaveLength(1)
    expect(run.nodes['a']).toMatchObject({
      phase: 'failed',
      attempts: [{ error: { code: 'GRAPH_WORKER_UNDECLARED_WRITE' } }],
    })
    const prompt = (graphWorker.assignments[0]?.prompt[0] as { text?: string } | undefined)?.text
    expect(prompt).toContain('Workspace policy: mode=isolated-copy; readRoots=["architecture"]; writeRoots=["docs/architecture"].')
    expect(prompt).toContain('Never write through an absolute source-workspace path or outside writeRoots.')
    expect(active.followup).toHaveBeenCalledOnce()
    const followup = JSON.stringify(active.followup.mock.lastCall?.[0])
    expect(followup).toContain('[graph-planning-checkpoint]')
    expect(followup).toContain('GRAPH_WORKER_UNDECLARED_WRITE')
    expect(followup).toContain('actual repository paths')
  })

  it('requires generation-bound human approval before executing exact environment commands', async () => {
    const active = await harness({ cwd: 'D:/project' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'prepare the host toolchain', graph: environmentRevision('environment-approval'),
    })
    const waiting = await runInPhase(active.ctx, active.agent, 1, 'awaiting_user')
    const checkpoint = Object.values(active.ctx.graphMode.state(active.agent).checkpoints)
      .find(item => item.kind === 'environment' && item.status === 'pending')
    if (checkpoint === undefined) throw new Error('environment approval checkpoint must exist')

    expect(active.shell.requests).toEqual([])
    expect(active.provider.requests).toEqual([])
    expect(checkpoint.reason).toContain('winget install --id Apache.Maven --exact')
    expect(checkpoint.reason).toContain('winget uninstall --id Apache.Maven --exact')
    expect(JSON.stringify(active.followup.mock.lastCall?.[0])).toContain('do not call graph_submit')

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('approve-environment'),
      action: 'approve-checkpoint',
      ...controlAddress(active.ctx, active.agent, waiting.id),
      checkpointId: checkpoint.id,
      reason: 'approve the exact Maven installation command',
    })
    const completed = await terminalRunId(active.ctx, active.agent, submitted.runId as string)

    expect(record.resultingGeneration).toBe(2)
    expect(active.ctx.graphMode.state(active.agent).checkpoints[checkpoint.id])
      .toMatchObject({ status: 'resolved', authorizedGeneration: 2 })
    expect(active.shell.requests).toHaveLength(1)
    expect(active.shell.requests[0]).toMatchObject({
      command: 'winget install --id Apache.Maven --exact',
      workdir: 'D:/project',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'D:/project' },
    })
    expect(completed).toMatchObject({
      generation: 2,
      phase: 'succeeded',
      nodes: {
        'environment-setup': {
          phase: 'succeeded',
          attempts: [{ number: 1 }],
          output: { data: { sandboxMode: 'danger-full-access' } },
        },
      },
    })
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'environment', outcome: 'confirmed' }))

    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('retry-environment'),
      action: 'retry-node',
      ...controlAddress(active.ctx, active.agent, completed.id),
      nodeId: GraphNodeId('environment-setup'),
      reason: 'repeat the environment operation only after a fresh approval',
    })
    const repeated = await runInPhase(active.ctx, active.agent, 1, 'awaiting_user')
    expect(repeated.generation).toBe(3)
    expect(active.shell.requests).toHaveLength(1)
    expect(Object.values(active.ctx.graphMode.state(active.agent).checkpoints)
      .filter(item => item.kind === 'environment' && item.status === 'pending')).toHaveLength(1)
  })

  it('normalizes verification output before publishing a recoverable checkpoint', async () => {
    const provider = new GraphWorkerProvider([
      commandWorkerResult('npm run build', 'Build complete\r\n', { summary: 'verified', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'normalize verification', graph: singleRevision('normalized-verification'),
    })
    const run = await terminal(active.ctx, active.agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.attempts[0]?.checkpoints).toHaveLength(2)
    expect(run.nodes['a']?.attempts[0]?.checkpoints?.[0]?.verification).toEqual([{
      command: 'npm run build', exitCode: 0, summary: 'Build complete',
    }])
  })

  it('normalizes verification output after truncating it to the checkpoint limit', async () => {
    const retained = 'b'.repeat(1_999)
    const provider = new GraphWorkerProvider([
      commandWorkerResult('npm run build', `${'a'.repeat(100)} ${retained}`, { summary: 'verified', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'normalize truncated verification', graph: singleRevision('normalized-truncated-verification'),
    })
    const run = await terminal(active.ctx, active.agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.attempts[0]?.checkpoints?.[0]?.verification).toEqual([{
      command: 'npm run build', exitCode: 0, summary: retained,
    }])
  })

  it('does not treat PowerShell Test-Path as recoverable test evidence', async () => {
    const provider = new GraphWorkerProvider([
      commandWorkerResult(
        'node --version; Test-Path D:\\work',
        'v22.23.2\r\nTrue\r\n',
        { summary: 'environment inspected', artifacts: [] },
      ),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'inspect environment', graph: singleRevision('test-path-inspection'),
    })
    const run = await terminal(active.ctx, active.agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.attempts[0]?.checkpoints).toHaveLength(1)
    expect(run.nodes['a']?.attempts[0]?.checkpoints?.[0]?.verification).toEqual([])
  })

  it('does not continue a token-limited worker from failed verification', async () => {
    const provider = new GraphWorkerProvider([
      commandWorkerResult(
        'npm run build',
        'Error: spawn EPERM\n[exit code: 1]',
        { summary: 'build failed', artifacts: [] },
        'max-tokens',
      ),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'reject failed verification progress', graph: singleRevision('failed-verification'),
    })
    const run = await runWithPhase(active.ctx, active.agent, 1, 'paused')
    expect(run.nodes['a']?.attempts[0]).toMatchObject({
      checkpoints: [],
      health: { status: 'stalled', stalledReason: 'max-tokens-without-progress', durableActions: 0 },
    })
    expect(provider.requests).toHaveLength(1)
    expect((provider.requests[0]?.prompt[0] as { text?: string } | undefined)?.text).toContain(
      'Do not patch dependencies, package-manager caches, or build tools to evade the sandbox.',
    )
  })

  it('settles external ownership when a future progress checkpoint is invalid', async () => {
    const invalidProgress = async (
      request: ResolvedSubagentStartRequest,
      session: Session,
    ): Promise<Awaited<SubagentRun['result']>> => {
      return await commandWorkerResult(
        'npm run build',
        `[exit code: ${'9'.repeat(400)}]`,
        { summary: 'unreachable', artifacts: [] },
      )(request, session)
    }
    const provider = new GraphWorkerProvider([invalidProgress])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'invalid progress', graph: singleRevision('invalid-progress', 2),
    })
    const run = await terminal(active.ctx, active.agent, 1)
    expect(run).toMatchObject({
      phase: 'failed',
      error: { code: 'GRAPH_WORKER_PROGRESS_INVALID', nodeId: 'a' },
      nodes: { a: { phase: 'failed', attempts: [{ error: { code: 'GRAPH_WORKER_PROGRESS_INVALID' } }] } },
    })
    expect(provider.requests).toHaveLength(1)
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'failed', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'coordination', outcome: 'confirmed' }))
  })

  it('continues token-limited workers within one logical attempt', async () => {
    const provider = new GraphWorkerProvider([
      durableWorkerResult({ summary: 'partial', artifacts: [] }, 'max-tokens'),
      workerResult({ summary: 'complete after continuation', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, {
      intent: 'new', reason: 'continue bounded output', graph: singleRevision('continued-child'),
    })
    const run = await terminal(ctx, agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.attempts).toHaveLength(1)
    expect(run.nodes['a']?.attempts[0]).toMatchObject({
      childSessionId: 'child-1', continuationSessionIds: ['child-2'],
    })
    expect(run.nodes['a']?.attempts[0]?.checkpoints?.at(-1)).toMatchObject({
      workId: run.nodes['a']?.workId,
      attemptId: run.nodes['a']?.attempts[0]?.id,
      activation: 1,
      completedCriteria: ['a accepted'],
      remainingWork: [],
    })
    expect(provider.requests[1]?.prompt[0]).toMatchObject({ type: 'text' })
    expect(provider.disposed).toEqual(['child-1', 'child-2'])
  })

  it('pauses for controller replanning when max-tokens has no durable checkpoint', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'reasoning-only partial', artifacts: [] }, 'max-tokens'),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, {
      intent: 'new', reason: 'replan reasoning-only work', graph: singleRevision('reasoning-only-child'),
    })
    const run = await runWithPhase(ctx, agent, 1, 'paused')
    expect(run.nodes['a']?.attempts[0]).toMatchObject({
      error: { code: 'GRAPH_NODE_STALLED' },
      health: { status: 'stalled', stalledReason: 'max-tokens-without-progress', durableActions: 0 },
    })
    expect(provider.requests).toHaveLength(1)
    expect(Object.values(ctx.graphMode.state(agent).checkpoints)).toContainEqual(expect.objectContaining({
      kind: 'planning', nodeId: 'a', status: 'pending',
    }))
  })

  it('interrupts reasoning-only work at its node budget and preserves the stall evidence', async () => {
    const provider = new GraphWorkerProvider([reasoningOnlyWorkerResult])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph = singleRevision('reasoning-budget')
    await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'bound hidden reasoning',
      graph: {
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          executionBudget: { ...node.executionBudget, maxReasoningOnlyTokens: 1 },
        })),
      },
    })
    const run = await runWithPhase(ctx, agent, 1, 'paused')
    expect(run.nodes['a']?.attempts[0]?.health).toMatchObject({
      status: 'stalled',
      stalledReason: 'reasoning-budget',
      durableActions: 0,
    })
    expect(run.nodes['a']?.attempts[0]?.health?.estimatedReasoningTokens).toBeGreaterThan(0)
  })

  it('resumes a reasoning-stalled activation from its durable checkpoint', async () => {
    const stalledAfterWrite = async (
      request: ResolvedSubagentStartRequest,
      session: Session,
    ): Promise<Awaited<SubagentRun['result']>> => {
      const partial = await durableWorkerResult({ summary: 'partial', artifacts: [] }, 'max-tokens')(request, session)
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning after recoverable work' },
      })
      return partial
    }
    const provider = new GraphWorkerProvider([
      stalledAfterWrite,
      workerResult({ summary: 'completed from checkpoint', artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph = singleRevision('checkpointed-reasoning-budget')
    await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'resume recoverable work',
      graph: {
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          executionBudget: { ...node.executionBudget, maxReasoningOnlyTokens: 1 },
        })),
      },
    })
    const run = await terminal(ctx, agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.attempts[0]?.continuationSessionIds).toEqual(['child-2'])
    const continuationPrompt = provider.requests[1]?.prompt[0]
    expect(continuationPrompt?.type).toBe('text')
    if (continuationPrompt?.type !== 'text') throw new Error('continuation prompt must be text')
    expect(continuationPrompt.text).toContain('stopped because reasoning-budget')
  })

  it('fails after the continuation budget and rejects malformed child results', async () => {
    const cases = [
      workerResult(null),
      workerResult({ summary: '', artifacts: [] }),
      workerResult({ summary: 'done', artifacts: ['ok'], coordinationSummary: ' bad' }),
    ]
    for (const [index, outcome] of cases.entries()) {
      const provider = new GraphWorkerProvider([outcome])
      const { ctx, agent } = await harness({ provider })
      ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
      await ctx.graphMode.submit(agent, {
        intent: 'new', reason: 'invalid child result', graph: singleRevision(`invalid-${String(index)}`),
      })
      const run = await terminal(ctx, agent, 1)
      expect(run.phase).toBe('failed')
      expect(provider.disposed).toHaveLength(1)
    }

    const provider = new GraphWorkerProvider([
      durableWorkerResult({ summary: 'partial 1', artifacts: [] }, 'max-tokens'),
      durableWorkerResult({ summary: 'partial 2', artifacts: [] }, 'max-tokens'),
    ])
    const { ctx, agent } = await harness({ provider })
    const defaults = defaultGraphModeConfig()
    ctx.graphMode.setConfig(agent, {
      ...defaults,
      active: true,
      executionPolicy: { ...defaults.executionPolicy, maxRuntimeContinuations: 1 },
    })
    const graph = singleRevision('continuation-exhausted')
    await ctx.graphMode.submit(agent, {
      intent: 'new',
      reason: 'bounded continuation',
      graph: {
        ...graph,
        nodes: graph.nodes.map(node => ({ ...node, executionBudget: { ...node.executionBudget, maxContinuations: 1 } })),
        terminationPolicy: { ...graph.terminationPolicy, maxRuntimeContinuations: 1 },
      },
    })
    expect((await terminal(ctx, agent, 1)).phase).toBe('failed')
    expect(provider.disposed).toEqual(['child-1', 'child-2'])
  })

  it('skips false conditional successors without spawning them', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'not needed', data: { ok: false }, artifacts: [] }),
    ])
    const { ctx, agent } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, {
      intent: 'new', reason: 'conditional', graph: dependentRevision('conditional-graph', true),
    })
    const run = await terminal(ctx, agent, 1)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['b']?.phase).toBe('skipped')
    expect(run.nodes['b']?.branchEvaluation).toMatchObject({
      decision: 'inactive',
      groups: [{ id: 'to-b', mode: 'all', matched: 0, considered: 1, active: false }],
    })
    expect(provider.requests).toHaveLength(1)
  })

  it('returns architecture evidence to the controller and resumes only unfinished nodes', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'architecture accepted', data: { modules: ['core'] }, artifacts: [] }),
      workerResult({ summary: 'implementation accepted', artifacts: [] }),
    ])
    const { ctx, agent, followup } = await harness({ provider, scheduler })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const graph: GraphRevision = {
      ...singleRevision('planning-checkpoint'),
      objective: 'Plan before implementation',
      nodes: [
        { ...task('architecture', 'inspect and design'), kind: 'design', roleId: GraphRoleId('architect') },
        task('implementation', 'implement the accepted design'),
      ],
      edges: [{ from: GraphNodeId('architecture'), to: GraphNodeId('implementation'), kind: 'data' }],
    }
    const submitted = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'progressive plan', graph })
    if (submitted.runId === undefined) throw new Error('new Graph submission must return a run id')
    const runId = GraphRunId(submitted.runId)
    await vi.waitFor(() => {
      expect(ctx.graphMode.state(agent).runs[runId]?.phase).toBe('paused')
    })
    const checkpoint = Object.values(ctx.graphMode.state(agent).checkpoints).find(item => item.kind === 'planning')
    if (checkpoint === undefined) throw new Error('planning checkpoint must be recorded')
    expect(checkpoint).toMatchObject({ nodeId: 'architecture', status: 'pending' })
    expect(followup).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'plugin', plugin: 'graph-mode' } }))
    const planningFollowup = followup.mock.lastCall?.[0] as { content: Array<{ type: string; text?: string }> }
    expect(planningFollowup.content[0]?.text).toContain('"modelProfile":{"provider":"test","model":"coder","contextWindow":262144,"maxOutputTokens":32000')
    expect(planningFollowup.content[0]?.text).toContain('"executionBudget":{"maxOutputTokens":16384')

    await ctx.graphMode.recover(agent)
    expect(ctx.graphMode.state(agent).runs[runId]).toMatchObject({ phase: 'paused', generation: 1, ownerEpoch: 7 })
    expect(provider.requests).toHaveLength(1)
    expect(scheduler.acquisitions).toHaveLength(1)

    await ctx.graphMode.control(agent, {
      operationId: GraphControlOperationId('approve-planning'),
      action: 'approve-checkpoint',
      ...controlAddress(ctx, agent, runId),
      checkpointId: checkpoint?.id,
      reason: 'architecture evidence matches the repository and worker capability',
    })
    expect(await terminalRunId(ctx, agent, runId)).toMatchObject({ phase: 'succeeded', generation: 2, ownerEpoch: 8 })
    expect(scheduler.acquisitions.map(request => request.minimumOwnerEpoch)).toEqual([1, 8])
    expect(scheduler.releases.map(request => request.ownerEpoch)).toEqual([7, 8])
    expect(provider.requests.map(request => request.label)).toEqual([
      'Architect: ARCHITECTURE',
      'Engineer: IMPLEMENTATION',
    ])
  })

  it('returns accepted outputs from earlier revisions when a revised plan makes them pending again', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'baseline implementation accepted', data: { module: 'domain' }, artifacts: ['src/domain.ts'] }),
      workerResult({ summary: 'revised architecture accepted', data: { modules: ['domain', 'api'] }, artifacts: [] }),
    ])
    const { ctx, agent, followup } = await harness({ provider })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    const acceptedImplementation = task('implementation', 'implement the domain baseline')
    const firstGraph: GraphRevision = {
      ...singleRevision('historical-planning-evidence'),
      objective: 'Create the baseline',
      nodes: [acceptedImplementation],
    }
    const first = await ctx.graphMode.submit(agent, { intent: 'new', reason: 'create baseline', graph: firstGraph })
    if (first.runId === undefined) throw new Error('new Graph submission must return a run id')
    expect(await terminalRunId(ctx, agent, first.runId)).toMatchObject({ phase: 'succeeded' })

    const secondGraph: GraphRevision = {
      ...firstGraph,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'extend the accepted baseline',
      nodes: [
        { ...task('architecture', 'design the API extension'), kind: 'design', roleId: GraphRoleId('architect') },
        { ...acceptedImplementation, objective: 'preserve and reconcile the existing domain baseline' },
      ],
      edges: [{ from: GraphNodeId('architecture'), to: GraphNodeId('implementation'), kind: 'data' }],
    }
    const second = await ctx.graphMode.submit(agent, { intent: 'revise', reason: 'extend baseline', graph: secondGraph })
    if (second.runId === undefined) throw new Error('revision submission must return a run id')
    await runWithPhase(ctx, agent, 2, 'paused')

    const planningFollowup = followup.mock.lastCall?.[0] as { content: Array<{ type: string; text?: string }> }
    const text = planningFollowup.content[0]?.text ?? ''
    const serializedContext = /planningContext=(\{.*\})\nTreat priorAcceptedEvidence/.exec(text)?.[1]
    if (serializedContext === undefined) throw new Error('planning follow-up must contain structured context')
    const planningContext = JSON.parse(serializedContext) as {
      priorAcceptedEvidence: Array<Record<string, unknown>>
    }
    expect(planningContext.priorAcceptedEvidence).toHaveLength(1)
    expect(planningContext.priorAcceptedEvidence[0]).toMatchObject({
      nodeId: 'implementation',
      acceptedRevision: 1,
      acceptedRunId: first.runId,
      definitionChanged: true,
      incomingDependenciesChanged: true,
      acceptedDefinition: {
        id: 'implementation',
        objective: 'implement the domain baseline',
      },
      currentDefinition: {
        id: 'implementation',
        objective: 'preserve and reconcile the existing domain baseline',
      },
      output: {
        summary: 'baseline implementation accepted',
        data: { module: 'domain' },
        artifacts: ['src/domain.ts'],
      },
    })
    expect(text).toContain('Do not create preserve or baseline-discovery nodes for accepted work.')
    expect(provider.requests.map(request => request.label)).toEqual([
      'Engineer: IMPLEMENTATION',
      'Architect: ARCHITECTURE',
    ])
  })

  it('requires every incoming conditional edge to pass before dispatching a join node', async () => {
    const conditionalJoin = (id: string): GraphRevision => ({
      ...singleRevision(id),
      nodes: [task('a', 'check A'), task('b', 'check B'), task('c', 'join results')],
      edges: [
        { from: GraphNodeId('a'), to: GraphNodeId('c'), kind: 'conditional', branchGroupId: GraphBranchGroupId('to-c'), condition: { path: ['passed'], operator: 'truthy' } },
        { from: GraphNodeId('b'), to: GraphNodeId('c'), kind: 'conditional', branchGroupId: GraphBranchGroupId('to-c'), condition: { path: ['passed'], operator: 'truthy' } },
      ],
      branchGroups: [{ id: GraphBranchGroupId('to-c'), to: GraphNodeId('c'), mode: 'all' }],
    })
    const blockedProvider = new GraphWorkerProvider([
      workerResult({ summary: 'A passed', data: { passed: true }, artifacts: [] }),
      workerResult({ summary: 'B failed', data: { passed: false }, artifacts: [] }),
    ])
    const blocked = await harness({ provider: blockedProvider })
    blocked.ctx.graphMode.setConfig(blocked.agent, { ...defaultGraphModeConfig(), active: true })
    await blocked.ctx.graphMode.submit(blocked.agent, {
      intent: 'new', reason: 'conditional join', graph: conditionalJoin('blocked-join'),
    })
    const blockedRun = await terminal(blocked.ctx, blocked.agent, 1)
    expect(blockedRun.nodes['c']?.phase).toBe('skipped')
    expect(blockedProvider.requests).toHaveLength(2)

    const passingProvider = new GraphWorkerProvider([
      workerResult({ summary: 'A passed', data: { passed: true }, artifacts: [] }),
      workerResult({ summary: 'B passed', data: { passed: true }, artifacts: [] }),
      workerResult({ summary: 'joined', artifacts: [] }),
    ])
    const passing = await harness({ provider: passingProvider })
    passing.ctx.graphMode.setConfig(passing.agent, { ...defaultGraphModeConfig(), active: true })
    await passing.ctx.graphMode.submit(passing.agent, {
      intent: 'new', reason: 'conditional join', graph: conditionalJoin('passing-join'),
    })
    const passingRun = await terminal(passing.ctx, passing.agent, 1)
    expect(passingRun.nodes['c']?.phase).toBe('succeeded')
    expect(passingProvider.requests).toHaveLength(3)
  })

  it('prepares, claims, and settles successful coordination work', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'done', coordinationSummary: 'public evidence', artifacts: [] }),
    ])
    const { ctx, agent, coordination } = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    ctx.graphMode.setConfig(agent, { ...defaultGraphModeConfig(), active: true })
    await ctx.graphMode.submit(agent, {
      intent: 'new', reason: 'coordinated', graph: singleRevision('coordinated'),
    })
    await settled(ctx, agent, 1)
    expect(coordination?.prepares).toHaveLength(1)
    expect(coordination?.claims).toHaveLength(1)
    expect(coordination?.settlements[0]).toMatchObject({
      claimId: 'claim-a', outcome: 'succeeded', evidence: 'public evidence', cwd: 'D:/work',
    })
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt?.type).toBe('text')
    if (prompt?.type === 'text') expect(prompt.text).toContain('shared progress')
  })

  it('validates control output before staging or settling coordinated work', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'browser flow passed without a control decision', artifacts: [], data: { result: 'pass' } }),
      workerResult({
        summary: 'browser flow approved',
        artifacts: [],
        data: { result: 'pass', decision: 'approved', issues: [] },
      }),
    ])
    const specialized = defaultGraphOutputSchema('historical-browser-result')
    const graph: GraphRevision = {
      ...singleRevision('control-validation-order', 2),
      nodes: [{
        ...task('a', 'verify the browser flow'),
        kind: 'verification',
        roleId: GraphRoleId('browser-tester'),
        maxAttempts: 2,
        outputSchema: {
          ...specialized,
          schema: {
            ...specialized.schema,
            properties: {
              ...specialized.schema.properties,
              data: {
                type: 'object',
                additionalProperties: false,
                properties: { result: { type: 'string', enum: ['pass', 'fail'] } },
                required: ['result'],
              },
            },
          },
        },
      }],
    }
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'validate before settlement', graph,
    })
    const run = await terminal(active.ctx, active.agent, 1)
    const operations = active.ctx.graphMode.state(active.agent).operations[run.nodes['a']!.workId] ?? []

    expect(run.phase).toBe('succeeded')
    expect(provider.requests).toHaveLength(2)
    expect(active.coordination?.claims).toHaveLength(2)
    expect(active.coordination?.settlements).toHaveLength(1)
    expect(active.coordination?.settlements[0]?.outcome).toBe('succeeded')
    expect(operations.filter(operation => operation.stage === 'output-staged')).toHaveLength(1)
    expect(operations.findIndex(operation => operation.stage === 'reconciled'))
      .toBeLessThan(operations.findIndex(operation => operation.stage === 'output-staged'))
  })

  it('publishes bounded progress and watches external coordination while a worker is active', async () => {
    const provider = new GraphWorkerProvider([async () => {
      await new Promise(resolve => setTimeout(resolve, 240))
      return {
        output: [{ type: 'text', text: 'worker complete' }],
        structured: { summary: 'done', coordinationSummary: 'public final evidence', artifacts: [] },
        stopReason: 'completed',
      }
    }])
    const active = await harness({
      provider,
      cwd: 'D:/work',
      coordinationHeartbeatMs: 100,
      coordination: {
        heartbeatFencingDelta: 1,
        watchObservation: {
          status: 'claimed',
          cursor: 'external-1',
          compacted: false,
          events: [{ id: 'peer-progress', cursor: 'external-1', kind: 'progress', at: 2, sequence: 7, evidence: 'peer completed inspection' }],
        },
      },
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'live coordination', graph: singleRevision('live-coordination'),
    })
    const runId = accepted.runId as GraphRun['id']
    let run: GraphRun | undefined
    for (let turn = 0; turn < 100; turn++) {
      run = active.ctx.graphMode.state(active.agent).runs[runId]
      if (run?.phase === 'succeeded') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(run?.phase).toBe('succeeded')
    expect(active.coordination?.heartbeats.length).toBeGreaterThan(0)
    expect(active.coordination?.watches[0]).toMatchObject({ workId: run?.nodes['a']?.workId, afterCursor: 'progress-1' })
    expect(active.coordination?.progresses.map(item => item.progressSequence)).toEqual([1, 2])
    expect(active.coordination?.progresses[0]?.evidence).toContain('attempt 1 admitted')
    expect(active.coordination?.progresses[1]?.evidence).toBe('public final evidence')
    expect(active.coordination?.settlements[0]?.fencingToken).toBeGreaterThan(1)
    expect(active.coordination?.settlements[0]?.leaseId).toBe(`lease-a-${String(active.coordination?.settlements[0]?.fencingToken)}`)
    const details = active.ctx.graphMode.state(active.agent).operations[run?.nodes['a']?.workId as string]
      ?.filter(operation => operation.stage === 'progress').map(operation => operation.detail) ?? []
    expect(details.some(detail => detail?.includes('attempt 1 admitted'))).toBe(true)
    expect(details.some(detail => detail?.includes('peer completed inspection'))).toBe(true)
    expect(details).toContain('public final evidence')
    const leaseReferences = active.ctx.graphMode.state(active.agent).operations[run?.nodes['a']?.workId as string]
      ?.flatMap(operation => operation.externalReferences) ?? []
    expect(leaseReferences.some(reference => reference.provider === 'graph-coordination-lease'
      && typeof reference.fencingToken === 'number')).toBe(true)
  })

  it('drains an in-flight heartbeat and refreshes its lease before terminal writeback', async () => {
    let markHeartbeatStarted!: () => void
    const heartbeatStarted = new Promise<void>((resolve) => { markHeartbeatStarted = resolve })
    let releaseHeartbeat!: () => void
    const heartbeatWait = new Promise<void>((resolve) => { releaseHeartbeat = resolve })
    const provider = new GraphWorkerProvider([async () => {
      await heartbeatStarted
      setTimeout(releaseHeartbeat, 0)
      return {
        output: [{ type: 'text', text: 'worker complete' }],
        structured: { summary: 'completed during lease renewal', artifacts: [] },
        stopReason: 'completed',
      }
    }])
    const active = await harness({
      provider,
      coordination: {
        heartbeatFencingDelta: 1,
        heartbeatWait,
        onHeartbeat: markHeartbeatStarted,
      },
      coordinationHeartbeatMs: 100,
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'heartbeat settlement race', graph: singleRevision('heartbeat-settlement-race'),
    })
    await heartbeatStarted
    const run = await terminal(active.ctx, active.agent, 1)

    expect(run.phase).toBe('succeeded')
    expect(active.coordination?.heartbeats).toHaveLength(1)
    expect(active.coordination?.heartbeatSignals[0]?.aborted).toBe(true)
    expect(active.coordination?.settlements[0]).toMatchObject({ fencingToken: 2, leaseId: 'lease-a-2', outcome: 'succeeded' })
  })

  it('does not append delayed coordination progress after a failed attempt becomes terminal', async () => {
    let releaseProgress!: () => void
    const progressWait = new Promise<void>((resolve) => { releaseProgress = resolve })
    const provider = new GraphWorkerProvider([new Error('worker start failed')])
    const active = await harness({ provider, cwd: 'D:/work', coordination: { progressWait } })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph = { ...singleRevision('delayed-progress'), nodes: [{ ...task('a', 'complete A'), maxAttempts: 1 }] }
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'race regression', graph,
    })
    await waitForRequests(provider, 1)
    releaseProgress()
    const run = await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const operations = active.ctx.graphMode.state(active.agent).operations[run.nodes['a']!.workId] ?? []

    expect(run.error?.message).toBe('worker start failed')
    expect(operations.map(operation => operation.stage)).toEqual(['planned', 'admitted', 'claimed', 'terminal'])
  })

  it('waits for live model capacity and records the fenced release', async () => {
    const resources = new TestGraphResourceProvider(['wait', 'grant'])
    const active = await harness({ resources })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'resource admission', graph: singleRevision('resource-admission'),
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    expect(run.phase).toBe('succeeded')
    expect(resources.requests).toHaveLength(2)
    expect(resources.requests[0]).toMatchObject({ model: 'coder', hardMaxParallel: 1, weight: 1 })
    expect(active.agent.session.events.some(event => event.type === 'graph/run'
      && (event.data as { nodes?: Record<string, { resourceWait?: { reason?: string } }> }).nodes?.['a']?.resourceWait?.reason === 'memory')).toBe(true)
    expect(resources.outcomes).toEqual([expect.objectContaining({ outcome: 'completed', providerId: 'resources' })])
    const projection = active.ctx.graphMode.state(active.agent)
    expect(projection.operations[run.nodes['a']?.workId as string]?.flatMap(operation => operation.externalReferences))
      .toContainEqual(expect.objectContaining({ kind: 'model', provider: 'resources' }))
    expect(Object.values(projection.settlements).flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resource-release', outcome: 'confirmed' }),
    ]))
  })

  it('keeps resource settlement failure terminal without opening another attempt', async () => {
    const resources = new TestGraphResourceProvider(['grant'])
    resources.reportError = new Error('resource settlement unavailable')
    const active = await harness({ resources })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'resource settlement failure', graph: singleRevision('resource-settlement-failure'),
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    const operations = active.ctx.graphMode.state(active.agent).operations[run.nodes['a']!.workId] ?? []

    expect(run).toMatchObject({
      phase: 'failed',
      error: { code: 'GRAPH_RESOURCE_RELEASE_FAILED', message: 'resource settlement unavailable', nodeId: 'a' },
    })
    expect(active.provider.requests).toHaveLength(1)
    expect(resources.requests).toHaveLength(1)
    expect(operations.filter(operation => operation.stage === 'admitted')).toHaveLength(1)
    expect(operations.at(-1)).toMatchObject({
      stage: 'terminal', terminalOutcome: 'failed', detail: 'resource settlement unavailable',
    })
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({
        kind: 'resource-release', outcome: 'failed', error: { code: 'GRAPH_RESOURCE_RELEASE_FAILED', message: 'resource settlement unavailable' },
      }))
  })

  it('fails without dispatch when the live model route rejects work', async () => {
    const resources = new TestGraphResourceProvider(['reject'])
    const active = await harness({ resources })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'resource rejection', graph: singleRevision('resource-rejection'),
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    expect(run).toMatchObject({ phase: 'failed', error: { code: 'GRAPH_RESOURCE_REJECTED', nodeId: 'a' } })
    expect(active.provider.requests).toHaveLength(0)
    expect(resources.outcomes).toHaveLength(0)
  })

  it('releases a granted model reservation when external coordination rejects the claim', async () => {
    const resources = new TestGraphResourceProvider(['grant'])
    const active = await harness({
      resources,
      coordination: { claimError: new Error('claim unavailable') },
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'claim cleanup', graph: singleRevision('claim-cleanup'),
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    expect(run).toMatchObject({ phase: 'failed', error: { code: 'GRAPH_COORDINATION_CLAIM_FAILED', nodeId: 'a' } })
    const followup = active.followup.mock.lastCall?.[0] as { content: Array<{ type: string; text?: string }> }
    expect(followup.content[0]?.text).toContain('error={"code":"GRAPH_COORDINATION_CLAIM_FAILED","message":"claim unavailable","nodeId":"a"}')
    expect(resources.outcomes).toEqual([expect.objectContaining({ outcome: 'released', evidence: 'Worker dispatch did not start: claim unavailable' })])
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'resource-release', outcome: 'confirmed' }))
  })

  it('treats an already terminal coordination activation as an idempotent pre-dispatch result', async () => {
    const active = await harness({
      coordination: { terminalClaim: { outcome: 'succeeded', evidence: 'durable LoopX result already accepted' } },
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'repeat terminal activation', graph: singleRevision('terminal-activation'),
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)

    expect(run).toMatchObject({
      phase: 'failed',
      error: {
        code: 'GRAPH_COORDINATION_ALREADY_TERMINAL',
        message: 'coordination activation already settled as succeeded: durable LoopX result already accepted',
        nodeId: 'a',
      },
      nodes: { a: { attempts: [] } },
    })
    expect(active.coordination?.claims).toHaveLength(1)
    expect(active.provider.requests).toHaveLength(0)
  })

  it('releases pre-dispatch ownership when cancellation interrupts a pending coordination claim', async () => {
    let granted!: () => void
    const reservationGranted = new Promise<void>((resolve) => { granted = resolve })
    const resources = new TestGraphResourceProvider(['grant', 'grant'])
    resources.onGrant = () => { granted() }
    const active = await harness({
      resources,
      coordination: {
        claimWaitFor: (request, signal) => request.graph.graphId !== 'pre-dispatch-cancel'
          ? undefined
          : new Promise<void>((_resolve, reject) => {
            const abort = (): void => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('claim canceled'))
            }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          }),
      },
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'exercise pre-dispatch cancellation', graph: singleRevision('pre-dispatch-cancel'),
    })
    await reservationGranted
    const runId = GraphRunId(submitted.runId as string)
    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-pre-dispatch-cancel'),
      action: 'cancel-run',
      ...controlAddress(active.ctx, active.agent, runId),
      reason: 'cancel while coordination claim is pending',
    })
    expect(active.ctx.graphMode.state(active.agent).runs[runId]?.phase).toBe('canceled')
    expect(resources.outcomes).toHaveLength(1)
    expect(resources.outcomes[0]?.outcome).toBe('released')
    expect(resources.outcomes[0]?.evidence).toContain('Worker dispatch did not start')
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'resource-release', outcome: 'confirmed' }))

    const replacement = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'prove admission remains usable', graph: singleRevision('post-cancel-admission'),
    })
    expect(await terminalRunId(active.ctx, active.agent, replacement.runId as string)).toMatchObject({ phase: 'succeeded' })
    expect(resources.requests).toHaveLength(2)
    expect(resources.outcomes.at(-1)).toMatchObject({ outcome: 'completed' })
  })

  it('surfaces coordination preparation, claim, and writeback failures', async () => {
    const noCwd = await harness({ coordination: {} })
    noCwd.ctx.graphMode.setConfig(noCwd.agent, { ...defaultGraphModeConfig(), active: true })
    await expect(noCwd.ctx.graphMode.submit(noCwd.agent, {
      intent: 'new', reason: 'no cwd', graph: singleRevision('no-cwd'),
    })).rejects.toThrow(/working directory/)

    const prepare = await harness({ coordination: { prepareError: new Error('prepare failed') }, cwd: 'D:/work' })
    prepare.ctx.graphMode.setConfig(prepare.agent, { ...defaultGraphModeConfig(), active: true })
    await expect(prepare.ctx.graphMode.submit(prepare.agent, {
      intent: 'new', reason: 'prepare', graph: singleRevision('prepare-failure'),
    })).rejects.toThrow('prepare failed')

    const claim = await harness({ coordination: { claimError: new Error('claim failed') }, cwd: 'D:/work' })
    claim.ctx.graphMode.setConfig(claim.agent, { ...defaultGraphModeConfig(), active: true })
    await claim.ctx.graphMode.submit(claim.agent, {
      intent: 'new', reason: 'claim', graph: singleRevision('claim-failure'),
    })
    const claimRun = await terminal(claim.ctx, claim.agent, 1)
    expect(claimRun).toMatchObject({
      phase: 'failed',
      error: { code: 'GRAPH_COORDINATION_CLAIM_FAILED', message: 'claim failed', nodeId: 'a' },
    })
    expect(claimRun.nodes['a']?.attempts).toEqual([])

    const settleProvider = new GraphWorkerProvider([
      workerResult({ summary: 'done', artifacts: [] }),
    ])
    const settle = await harness({
      provider: settleProvider, coordination: { settleError: new Error('writeback failed\n') }, cwd: 'D:/work',
    })
    settle.ctx.graphMode.setConfig(settle.agent, { ...defaultGraphModeConfig(), active: true })
    await settle.ctx.graphMode.submit(settle.agent, {
      intent: 'new', reason: 'settle', graph: singleRevision('settle-failure'),
    })
    const settleRun = await runInPhase(settle.ctx, settle.agent, 1, 'awaiting_user')
    expect(settleRun.nodes['a']?.output?.summary).toBe('done')
    expect(settleRun.nodes['a']?.attempts[0]?.error).toMatchObject({
      code: 'GRAPH_COORDINATION_WRITEBACK_FAILED', message: 'writeback failed',
    })
    const settlementCheckpoint = Object.values(settle.ctx.graphMode.state(settle.agent).checkpoints)
      .find(item => item.runId === settleRun.id && item.nodeId === 'a')
    expect(settlementCheckpoint).toMatchObject({ kind: 'awaiting_user', status: 'pending' })
    settle.coordination!.settleError = undefined
    await new Promise(resolve => setTimeout(resolve, 20))
    await settle.ctx.graphMode.recover(settle.agent, settleRun.id)
    expect(settle.ctx.graphMode.state(settle.agent).runs[settleRun.id]?.generation).toBe(2)
    expect(settle.ctx.graphMode.state(settle.agent).operations[settleRun.nodes['a']!.workId]?.at(-1)?.detail)
      .toBe('staged output settlements recovered')
    const recovered = await terminalRunId(settle.ctx, settle.agent, settleRun.id)
    expect(recovered).toMatchObject({ generation: 2, phase: 'succeeded', nodes: { a: { phase: 'succeeded', output: { summary: 'done' } } } })
    expect(settleProvider.requests).toHaveLength(1)
    expect(Object.values(settle.ctx.graphMode.state(settle.agent).settlements).flat().map(item => item.outcome))
      .toEqual(['pending', 'failed', 'pending', 'confirmed'])

    const blank = await harness({ coordination: { claimError: new Error(' ') }, cwd: 'D:/work' })
    blank.ctx.graphMode.setConfig(blank.agent, { ...defaultGraphModeConfig(), active: true })
    await blank.ctx.graphMode.submit(blank.agent, {
      intent: 'new', reason: 'blank claim failure', graph: singleRevision('blank-claim-failure'),
    })
    expect((await terminal(blank.ctx, blank.agent, 1)).error?.message).toBe('unknown failure')

    const long = await harness({ coordination: { claimError: new Error('x'.repeat(5_000)) }, cwd: 'D:/work' })
    long.ctx.graphMode.setConfig(long.agent, { ...defaultGraphModeConfig(), active: true })
    await long.ctx.graphMode.submit(long.agent, {
      intent: 'new', reason: 'long claim failure', graph: singleRevision('long-claim-failure'),
    })
    const longMessage = (await terminal(long.ctx, long.agent, 1)).error?.message
    expect(longMessage).toHaveLength(4_000)
    expect(longMessage?.endsWith('...')).toBe(true)
  })

  it('reports a failed coordination settlement after bounded worker exhaustion', async () => {
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('worker failed once')),
      () => Promise.reject(new Error('worker failed twice')),
    ])
    const coordinated = await harness({
      provider, coordination: { settleError: new Error('blocker writeback failed') }, cwd: 'D:/work',
    })
    coordinated.ctx.graphMode.setConfig(coordinated.agent, { ...defaultGraphModeConfig(), active: true })
    await coordinated.ctx.graphMode.submit(coordinated.agent, {
      intent: 'new', reason: 'failure writeback', graph: singleRevision('failure-writeback', 2),
    })
    expect((await terminal(coordinated.ctx, coordinated.agent, 1)).phase).toBe('failed')
    expect(coordinated.coordination?.settlements[0]?.outcome).toBe('failed')
  })

  it('detects incoming-edge changes and removed-node impact without a previous run', async () => {
    const loaded = await harness()
    loaded.ctx.graphMode.setConfig(loaded.agent, { ...defaultGraphModeConfig(), active: true })
    const first = {
      ...singleRevision('loaded-graph'),
      nodes: [task('a', 'A'), task('b', 'B'), task('c', 'C')],
      edges: [
        { from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'control' as const },
        { from: GraphNodeId('b'), to: GraphNodeId('c'), kind: 'control' as const },
      ],
    }
    loaded.agent.session.append('graph/change', {
      kind: 'graph/revision', version: 2, graph: first, current: true,
    })
    const second = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'remove B',
      nodes: [first.nodes[0]!, first.nodes[2]!],
      edges: [{ from: GraphNodeId('a'), to: GraphNodeId('c'), kind: 'control' as const }],
    }
    await loaded.ctx.graphMode.submit(loaded.agent, {
      intent: 'revise', reason: 'remove obsolete work', graph: second, changedNodeIds: [GraphNodeId('b')],
    })
    const run = await terminal(loaded.ctx, loaded.agent, 2)
    expect(run.phase).toBe('succeeded')
    expect(run.nodes['a']?.invalidatedBy).toBeUndefined()
    expect(run.nodes['c']?.invalidatedBy).toContain('c')
  })

  it('resolves inherited and explicit worker model selections', async () => {
    const inherited = await harness({
      agentOptions: { provider: 'test', model: 'coder', reasoningEffort: ReasoningEffortId('high') },
    })
    inherited.ctx.graphMode.setConfig(inherited.agent, { ...defaultGraphModeConfig(), active: true })
    await inherited.ctx.graphMode.submit(inherited.agent, {
      intent: 'new', reason: 'inherit reasoning', graph: singleRevision('inherited-selection'),
    })
    await settled(inherited.ctx, inherited.agent, 1)
    expect(inherited.provider.requests[0]?.agentOptions).toEqual({
      provider: 'test', model: 'coder', reasoningEffort: 'high',
    })
    expect((await terminal(inherited.ctx, inherited.agent, 1)).nodes['a']?.attempts[0]?.modelProfile).toMatchObject({
      provider: 'test', model: 'coder', contextWindow: 262_144, maxOutputTokens: 32_000,
    })

    const explicit = await harness({ agentOptions: {} })
    const configured = defaultGraphModeConfig()
    const roles = configured.roles.map(role => role.id === 'engineer'
      ? { ...role, model: { provider: 'local', model: 'coder', reasoningEffort: 'medium' } }
      : role)
    explicit.ctx.graphMode.setConfig(explicit.agent, { ...configured, active: true, roles })
    await explicit.ctx.graphMode.submit(explicit.agent, {
      intent: 'new', reason: 'explicit selection', graph: singleRevision('explicit-selection'),
    })
    await settled(explicit.ctx, explicit.agent, 1)
    expect(explicit.provider.requests[0]?.agentOptions).toEqual({
      provider: 'local', model: 'coder', reasoningEffort: 'medium',
    })
  })

  it('routes a role through its configured Worker Provider and node workspace policy', async () => {
    const active = await harness()
    active.ctx.graphWorkers.register(new TestGraphWorkerAdapter(active.ctx, 'remote'))
    const configured = defaultGraphModeConfig()
    active.ctx.graphMode.setConfig(active.agent, {
      ...configured,
      active: true,
      roles: configured.roles.map(role => role.id === 'engineer' ? { ...role, workerProvider: 'remote' } : role),
    })
    const graph = singleRevision('worker-route')
    const revisionWithWorkspace = {
      ...graph,
      nodes: graph.nodes.map(node => ({
        ...node,
        workspace: { mode: 'shared' as const, readRoots: ['src'], writeRoots: ['src'], cleanup: 'retain' as const },
      })),
    }
    const accepted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'route worker', graph: revisionWithWorkspace,
    })
    const run = await terminalRunId(active.ctx, active.agent, accepted.runId as string)
    expect(run.phase).toBe('succeeded')
    const references = active.ctx.graphMode.state(active.agent).operations[run.nodes['a']?.workId as string]
      ?.flatMap(operation => operation.externalReferences)
    expect(references).toContainEqual(expect.objectContaining({ kind: 'worker', provider: 'remote' }))
  })

  it('materializes each successful isolated node before dispatching its successor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-graph-integration-'))
    try {
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'src', 'shared.ts'), 'base')
      const baseSha256 = createHash('sha256').update('base').digest('hex')
      const artifacts = new TestGraphArtifactProvider()
      const provider = new GraphWorkerProvider([
        workerResult({
          summary: 'isolated implementation',
          data: { testArtifact: { path: 'src/shared.ts', content: 'engineered', baseSha256 } },
          artifacts: ['src/shared.ts'],
        }),
        async (request) => {
          expect(await readFile(join(request.workspaceCwd as string, 'src', 'shared.ts'), 'utf8')).toBe('engineered')
          return {
            output: [{ type: 'text', text: 'integration complete' }],
            structured: { summary: 'integrated and verified', artifacts: [] },
            stopReason: 'completed',
          }
        },
      ])
      const active = await harness({ provider, artifacts, cwd })
      active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
      const graph: GraphRevision = {
        ...singleRevision('isolated-integration'),
        nodes: [task('implementation', 'implement in isolation'), { ...task('integration', 'integrate accepted artifacts'), kind: 'integration' }],
        edges: [{ from: GraphNodeId('implementation'), to: GraphNodeId('integration'), kind: 'data' }],
      }
      await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'isolate writes', graph })
      const run = await terminal(active.ctx, active.agent, 1)
      expect(run.phase).toBe('succeeded')
      expect(await readFile(join(cwd, 'src', 'shared.ts'), 'utf8')).toBe('engineered')
      expect(run.nodes['implementation']?.attempts[0]?.artifactManifest?.entries[0]).toMatchObject({
        path: 'src/shared.ts', baseSha256,
      })
      expect(artifacts.materializations).toEqual([['src/shared.ts']])
      const settlement = Object.values(active.ctx.graphMode.state(active.agent).settlements)
        .flat()
        .find(candidate => candidate.kind === 'artifact' && candidate.outcome === 'confirmed')
      expect(settlement).toMatchObject({
        kind: 'artifact', outcome: 'confirmed', externalReference: { provider: 'test-artifacts' },
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects isolated artifact publication after the source file drifts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-graph-integration-drift-'))
    try {
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'src', 'shared.ts'), 'base')
      const baseSha256 = createHash('sha256').update('base').digest('hex')
      const artifacts = new TestGraphArtifactProvider()
      const provider = new GraphWorkerProvider([
        async (request) => {
          await writeFile(join(request.workspaceCwd as string, 'src', 'shared.ts'), 'external change')
          return {
            output: [{ type: 'text', text: 'implementation complete' }],
            structured: {
              summary: 'isolated implementation',
              data: { testArtifact: { path: 'src/shared.ts', content: 'engineered', baseSha256 } },
              artifacts: ['src/shared.ts'],
            },
            stopReason: 'completed',
          }
        },
      ])
      const active = await harness({ provider, artifacts, cwd })
      active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
      const graph: GraphRevision = {
        ...singleRevision('isolated-integration-drift'),
        nodes: [task('implementation', 'implement in isolation'), { ...task('integration', 'integrate accepted artifacts'), kind: 'integration' }],
        edges: [{ from: GraphNodeId('implementation'), to: GraphNodeId('integration'), kind: 'data' }],
      }
      await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'detect source drift', graph })
      const run = await terminal(active.ctx, active.agent, 1)
      expect(run).toMatchObject({
        phase: 'failed',
        nodes: { implementation: { attempts: [{ error: { code: 'GRAPH_ARTIFACT_SOURCE_DRIFT' } }] } },
      })
      expect(await readFile(join(cwd, 'src', 'shared.ts'), 'utf8')).toBe('external change')
      expect(artifacts.materializations).toHaveLength(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('preserves earlier attempts when successful coordination writeback fails', async () => {
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('retry first')),
      workerResult({ summary: 'done', artifacts: [] }),
    ])
    const writeback = await harness({
      provider, coordination: { settleError: new Error('settle failed') }, cwd: 'D:/work',
    })
    writeback.ctx.graphMode.setConfig(writeback.agent, { ...defaultGraphModeConfig(), active: true })
    await writeback.ctx.graphMode.submit(writeback.agent, {
      intent: 'new', reason: 'retry writeback', graph: singleRevision('retry-writeback', 2),
    })
    const run = await runInPhase(writeback.ctx, writeback.agent, 1, 'awaiting_user')
    expect(run.nodes['a']?.attempts).toHaveLength(2)
    expect(run.nodes['a']?.attempts[1]?.error?.code).toBe('GRAPH_COORDINATION_WRITEBACK_FAILED')
    expect(run.nodes['a']?.output?.summary).toBe('done')
  })

  it('cancels and awaits an active run before executing its replacement revision', async () => {
    let markSlowAbort!: () => void
    const slowAbortObserved = new Promise<void>((resolve) => { markSlowAbort = resolve })
    let releaseSlowAbort!: () => void
    const slowAbortWait = new Promise<void>((resolve) => { releaseSlowAbort = resolve })
    const slowAbortResult = async (request: ResolvedSubagentStartRequest): Promise<Awaited<SubagentRun['result']>> => {
      if (!request.signal.aborted) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      markSlowAbort()
      await slowAbortWait
      return { output: [], stopReason: 'aborted' }
    }
    const provider = new GraphWorkerProvider([
      abortResult,
      slowAbortResult,
      workerResult({ summary: 'replacement A complete', artifacts: [] }),
      workerResult({ summary: 'replacement complete', artifacts: [] }),
    ])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    const config = defaultGraphModeConfig()
    active.ctx.graphMode.setConfig(active.agent, {
      ...config,
      active: true,
      roles: config.roles.map(role => role.id === 'engineer' ? { ...role, maxParallel: 2 } : role),
    })
    const first = {
      ...singleRevision('active-revision'),
      nodes: [
        { ...task('a', 'complete A'), workspace: { mode: 'shared' as const, readRoots: ['.'], writeRoots: ['src/a'], cleanup: 'retain' as const } },
        { ...task('b', 'complete B'), workspace: { mode: 'shared' as const, readRoots: ['.'], writeRoots: ['src/b'], cleanup: 'retain' as const } },
      ],
    }
    await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'start', graph: first })
    await waitForRequests(provider, 2)
    const running = Object.values(active.ctx.graphMode.state(active.agent).runs)[0]!
    active.agent.session.append('graph/run', { ...running, id: GraphRunId('older-observation') })
    const second = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'revise it',
      nodes: [
        { ...first.nodes[0]!, objective: 'complete revised A' },
        { ...first.nodes[1]!, objective: 'complete revised B' },
      ],
    }
    let revisionSettled = false
    const revisionSubmission = active.ctx.graphMode.submit(active.agent, {
      intent: 'revise', reason: 'replace active work', graph: second,
    })
    void revisionSubmission.then(() => { revisionSettled = true }, () => { revisionSettled = true })
    await slowAbortObserved
    for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve))
    const beforeRelease = active.ctx.graphMode.state(active.agent).runs[running.id]
    const settledBeforeRelease = revisionSettled
    releaseSlowAbort()
    await revisionSubmission
    const replacement = await terminal(active.ctx, active.agent, 2)
    expect(settledBeforeRelease).toBe(false)
    expect(beforeRelease).toMatchObject({ phase: 'running', nodes: { a: { phase: 'canceled' }, b: { phase: 'running' } } })
    expect(beforeRelease?.terminal).toBeUndefined()
    expect(replacement.phase).toBe('succeeded')
    expect(active.ctx.graphMode.state(active.agent).runs[running.id]).toMatchObject({
      phase: 'canceled',
      terminal: { outcome: 'canceled', rule: 'run-aborted' },
      nodes: { a: { phase: 'canceled' }, b: { phase: 'canceled' } },
    })
    expect(active.coordination?.settlements.slice(0, 2).map(item => item.outcome)).toEqual(['canceled', 'canceled'])
    expect(active.coordination?.settlements.slice(0, 2).map(item => item.evidence)).toEqual([
      'dsh graph node a canceled: graph revision superseded the active run',
      'dsh graph node b canceled: graph revision superseded the active run',
    ])
    expect(active.coordination?.settlementSignals.slice(0, 2)).toEqual([false, false])
    const oldSnapshots = active.agent.session.events.filter(event => event.type === 'graph/run' && event.data.id === running.id)
    const terminalIndex = oldSnapshots.findIndex(event => 'terminal' in event.data && event.data.terminal !== undefined)
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(oldSnapshots.slice(terminalIndex + 1)).toHaveLength(0)
  })

  it('bounds plugin disposal when a terminal coordination write does not settle', async () => {
    let releaseSettlement!: () => void
    const settleWait = new Promise<void>((resolve) => { releaseSettlement = resolve })
    const provider = new GraphWorkerProvider([abortResult])
    const active = await harness({ provider, coordination: { settleWait }, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'dispose', graph: singleRevision('dispose-active'),
    })
    await waitForRequests(provider, 1)
    const disposal = active.ctx.fiber.dispose()
    for (let turn = 0; active.coordination?.settlements.length === 0 && turn < 50; turn++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    let disposed = false
    void disposal.then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    await disposal
    expect(disposed).toBe(true)
    const settlement = active.agent.session.events.filter(event => event.type === 'graph/settlement').at(-1)
    expect(settlement?.data.outcome).toBe('pending')
    expect(active.coordination?.settlements).toHaveLength(0)
    releaseSettlement()
    expect(provider.disposed).toEqual(['child-1'])
  })

  it('cancels one active child through a durable node control operation', async () => {
    const provider = new GraphWorkerProvider([abortResult])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'active node', graph: singleRevision('node-control', 2),
    })
    await waitForRequests(provider, 1)
    const attemptId = active.ctx.graphMode.state(active.agent).runs[submitted.runId as string]?.nodes['a']?.attempts.at(-1)?.id
    if (attemptId === undefined) throw new Error('active node must expose its current attempt id')
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-cancel-node'),
      action: 'cancel-node',
      ...controlAddress(active.ctx, active.agent, GraphRunId(submitted.runId as string)),
      expectedAttemptId: attemptId,
      nodeId: GraphNodeId('a'),
      reason: 'user canceled the active node',
    })
    const run = active.ctx.graphMode.state(active.agent).runs[submitted.runId as string]
    expect(run).toMatchObject({ phase: 'failed', nodes: { a: { phase: 'canceled' } } })
    expect(record).toMatchObject({ action: 'cancel-node', nodeId: 'a' })
    expect(active.ctx.graphMode.state(active.agent).controls[record.id]).toEqual(record)
    expect(active.coordination?.cancellations[0]).toMatchObject({
      workId: run?.nodes['a']?.workId,
      claimId: 'claim-a',
      leaseId: 'lease-a',
      reason: 'user canceled the active node',
    })
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'cancellation', outcome: 'confirmed' }))
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'coordination', outcome: 'confirmed' }))
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'canceled', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(provider.requests).toHaveLength(1)
  })

  it('cancels an active run and preserves the addressed control evidence', async () => {
    const provider = new GraphWorkerProvider([abortResult])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'active run', graph: singleRevision('run-control', 2),
    })
    await waitForRequests(provider, 1)
    const runId = GraphRunId(submitted.runId as string)
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-cancel-run'),
      action: 'cancel-run',
      ...controlAddress(active.ctx, active.agent, runId),
      reason: 'operator canceled the whole run',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })
    const run = active.ctx.graphMode.state(active.agent).runs[runId]
    expect(run).toMatchObject({ phase: 'canceled', terminal: { outcome: 'canceled', rule: 'run-aborted' } })
    expect(record).toMatchObject({ action: 'cancel-run', actor: { kind: 'human', id: 'operator-1' }, result: { outcome: 'applied' } })
    expect(active.coordination?.cancellations).toHaveLength(1)
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'cancellation', outcome: 'confirmed' }))
    expect(Object.values(active.ctx.graphMode.state(active.agent).settlements).flat())
      .toContainEqual(expect.objectContaining({ kind: 'coordination', outcome: 'confirmed' }))
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'canceled', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(provider.requests).toHaveLength(1)
  })

  it('pauses an active run at a durable human checkpoint and resumes exactly once', async () => {
    let finishFirst!: () => void
    const firstResult = async (): Promise<Awaited<SubagentRun['result']>> => await new Promise((resolve) => {
      finishFirst = () => { resolve({
        output: [{ type: 'text', text: 'first node complete' }],
        structured: { summary: 'first node complete', artifacts: [] },
        stopReason: 'completed',
      }) }
    })
    const provider = new GraphWorkerProvider([
      firstResult,
      workerResult({ summary: 'resumed result', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph: GraphRevision = {
      ...singleRevision('pause-control'),
      nodes: [task('a', 'first stage'), task('b', 'second stage')],
      edges: [{ from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'data' }],
    }
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'human pause', graph,
    })
    await waitForRequests(provider, 1)
    const runId = GraphRunId(submitted.runId as string)
    const pauseRequest = active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-pause-run'),
      action: 'pause-run',
      ...controlAddress(active.ctx, active.agent, runId),
      reason: 'operator needs to inspect the active attempt',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })
    await new Promise(resolve => setImmediate(resolve))
    finishFirst()
    const pause = await pauseRequest
    const paused = active.ctx.graphMode.state(active.agent).runs[runId]
    const checkpoint = Object.values(active.ctx.graphMode.state(active.agent).checkpoints)
      .find(item => item.runId === runId && item.kind === 'awaiting_user')

    expect(paused).toMatchObject({ phase: 'awaiting_user', generation: 1, nodes: { a: { phase: 'succeeded' }, b: { phase: 'awaiting_user' } } })
    expect(pause).toMatchObject({ action: 'pause-run', actor: { kind: 'human', id: 'operator-1' }, result: { outcome: 'applied' } })
    if (checkpoint === undefined) throw new Error('pause control must create a checkpoint')
    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-resume-paused-run'),
      action: 'approve-checkpoint',
      ...controlAddress(active.ctx, active.agent, runId),
      checkpointId: checkpoint.id,
      reason: 'inspection complete',
    })
    const resumed = await terminalRunId(active.ctx, active.agent, runId)
    expect(resumed).toMatchObject({ generation: 2, phase: 'succeeded', nodes: { a: { phase: 'succeeded' }, b: { phase: 'succeeded' } } })
    expect(provider.requests).toHaveLength(2)
  })

  it('records a task modification request before asking the controller for a new revision', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'original result', artifacts: [] }),
      workerResult({ summary: 'revised result', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const first = singleRevision('modify-task-control')
    const submitted = await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'original task', graph: first })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const runId = GraphRunId(submitted.runId as string)

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-modify-task'),
      action: 'modify-task',
      ...controlAddress(active.ctx, active.agent, runId),
      nodeId: GraphNodeId('a'),
      reason: 'replace the implementation objective with the corrected requirement',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })
    const checkpoint = Object.values(active.ctx.graphMode.state(active.agent).checkpoints)
      .find(item => item.runId === runId && item.issues?.some(issue => issue.id === 'modify-a'))
    expect(record).toMatchObject({ action: 'modify-task', nodeId: 'a', result: { outcome: 'applied' } })
    expect(checkpoint).toMatchObject({ kind: 'awaiting_user', status: 'pending', nodeId: 'a' })
    const modificationFollowup = active.followup.mock.lastCall?.[0] as unknown
    expect(modificationFollowup).toMatchObject({
      source: { kind: 'plugin', plugin: 'graph-mode' },
    })
    expect(JSON.stringify(modificationFollowup)).toContain('[graph-modification-request]')
    if (checkpoint === undefined) throw new Error('task modification checkpoint must exist')

    const second: GraphRevision = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'corrected requirement',
      nodes: [task('a', 'corrected implementation objective')],
    }
    const revised = await active.ctx.graphMode.submit(active.agent, {
      intent: 'revise',
      reason: 'apply the persisted task modification',
      graph: second,
      changedNodeIds: [GraphNodeId('a')],
    })
    await terminalRunId(active.ctx, active.agent, revised.runId as string)
    expect(active.ctx.graphMode.state(active.agent).checkpoints[checkpoint.id]).toMatchObject({
      status: 'resolved', replacementRevision: 2,
    })
    expect(active.ctx.graphMode.state(active.agent).graphs[first.graphId]?.at(-1)).toMatchObject({
      revision: 2, nodes: [{ objective: 'corrected implementation objective' }],
    })
    expect(provider.requests).toHaveLength(2)
  })

  it('interrupts an active modified node before its internal retry', async () => {
    const provider = new GraphWorkerProvider([abortResult])
    const active = await harness({ provider, coordination: {}, cwd: 'D:/work' })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new',
      reason: 'active task that needs correction',
      graph: singleRevision('modify-active-task-control', 3),
    })
    await waitForRequests(provider, 1)
    const runId = GraphRunId(submitted.runId as string)
    const attemptId = active.ctx.graphMode.state(active.agent).runs[runId]?.nodes['a']?.attempts.at(-1)?.id
    if (attemptId === undefined) throw new Error('active node must expose its current attempt id')

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-modify-active-task'),
      action: 'modify-task',
      ...controlAddress(active.ctx, active.agent, runId),
      expectedAttemptId: attemptId,
      nodeId: GraphNodeId('a'),
      reason: 'correct the active node workspace before retrying it',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })

    const run = active.ctx.graphMode.state(active.agent).runs[runId]
    expect(run).toMatchObject({ phase: 'awaiting_user', nodes: { a: { phase: 'canceled' } } })
    expect(record).toMatchObject({ action: 'modify-task', nodeId: 'a', result: { outcome: 'applied' } })
    expect(active.coordination?.cancellations).toEqual([
      expect.objectContaining({
        workId: run?.nodes['a']?.workId,
        reason: 'correct the active node workspace before retrying it',
      }),
    ])
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'canceled', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(provider.requests).toHaveLength(1)
    expect(active.followup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(active.followup.mock.lastCall?.[0])).toContain('[graph-modification-request]')
  })

  it('settles a prior attempt claim when modification interrupts retry admission', async () => {
    let claimCount = 0
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('transient worker failure')),
    ])
    const active = await harness({
      provider,
      coordination: {
        claimWaitFor: async (_request, signal) => {
          claimCount += 1
          if (claimCount !== 2) return
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          throw signal.reason
        },
      },
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new',
      reason: 'task whose retry admission will be corrected',
      graph: singleRevision('modify-retry-admission-control', 3),
    })
    for (let turn = 0; (active.coordination?.claims.length ?? 0) < 2 && turn < 50; turn++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(active.coordination?.claims).toHaveLength(2)
    const runId = GraphRunId(submitted.runId as string)

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-modify-retry-admission'),
      action: 'modify-task',
      ...controlAddress(active.ctx, active.agent, runId),
      nodeId: GraphNodeId('a'),
      reason: 'correct the node while its retry is awaiting admission',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })

    const run = active.ctx.graphMode.state(active.agent).runs[runId]
    expect(run).toMatchObject({ nodes: { a: { phase: 'canceled' } } })
    expect(record).toMatchObject({ action: 'modify-task', nodeId: 'a', result: { outcome: 'applied' } })
    expect(active.coordination?.cancellations).toEqual([
      expect.objectContaining({
        workId: run?.nodes['a']?.workId,
        reason: 'correct the node while its retry is awaiting admission',
      }),
    ])
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'canceled', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(provider.requests).toHaveLength(1)
  })

  it('settles a prior attempt claim before retry control starts a new generation', async () => {
    let claimCount = 0
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('transient worker failure')),
      workerResult({ summary: 'controlled retry succeeded', artifacts: [] }),
    ])
    const active = await harness({
      provider,
      coordination: {
        claimWaitFor: async (_request, signal) => {
          claimCount += 1
          if (claimCount !== 2) return
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          throw signal.reason
        },
      },
      cwd: 'D:/work',
    })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new',
      reason: 'task whose retry admission will be superseded',
      graph: singleRevision('retry-admission-control', 3),
    })
    for (let turn = 0; (active.coordination?.claims.length ?? 0) < 2 && turn < 50; turn++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(active.coordination?.claims).toHaveLength(2)
    const runId = GraphRunId(submitted.runId as string)

    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-retry-admission'),
      action: 'retry-node',
      ...controlAddress(active.ctx, active.agent, runId),
      nodeId: GraphNodeId('a'),
      reason: 'replace the interrupted retry with a controlled generation',
    })

    const run = await terminalRunId(active.ctx, active.agent, runId)
    expect(record).toMatchObject({ action: 'retry-node', resultingGeneration: 2 })
    expect(run).toMatchObject({ generation: 2, phase: 'succeeded' })
    expect(active.coordination?.cancellations).toEqual([
      expect.objectContaining({
        workId: run.nodes['a']?.workId,
        reason: 'graph generation superseded by control at node a',
      }),
    ])
    expect(active.coordination?.settlements).toEqual([
      expect.objectContaining({ outcome: 'canceled', claimId: 'claim-a', leaseId: 'lease-a' }),
      expect.objectContaining({ outcome: 'succeeded', claimId: 'claim-a', leaseId: 'lease-a' }),
    ])
    expect(provider.requests).toHaveLength(2)
  })

  it('retries a failed node in a new generation and deduplicates the control id', async () => {
    const scheduler = new TestGraphSchedulerProvider()
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('first generation failed')),
      workerResult({ summary: 'retry succeeded', artifacts: [] }),
    ])
    const active = await harness({ provider, scheduler })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'retry control', graph: singleRevision('retry-control'),
    })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const request = {
      operationId: GraphControlOperationId('control-retry-node'),
      action: 'retry-node' as const,
      ...controlAddress(active.ctx, active.agent, GraphRunId(submitted.runId as string)),
      nodeId: GraphNodeId('a'),
      reason: 'retry after diagnosed transient failure',
    }
    const first = await active.ctx.graphMode.control(active.agent, request)
    const recovered = await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    expect(recovered).toMatchObject({ generation: 2, ownerEpoch: 8, phase: 'succeeded' })
    expect(scheduler.acquisitions.map(acquisition => acquisition.minimumOwnerEpoch)).toEqual([1, 8])
    expect(scheduler.releases.map(release => release.ownerEpoch)).toEqual([7, 8])
    expect(recovered.nodes['a']?.attempts.map(attempt => attempt.number)).toEqual([1])
    expect(first).toMatchObject({
      version: 2,
      graphId: request.graphId,
      expectedRevision: 1,
      expectedGeneration: 1,
      actor: { kind: 'system', id: 'graph-mode' },
      source: 'host-api',
      result: { outcome: 'applied' },
      resultingGeneration: 2,
    })
    const duplicate = await active.ctx.graphMode.control(active.agent, request)
    expect(duplicate).toEqual(first)
    expect(active.ctx.graphMode.state(active.agent).runs[submitted.runId as string]?.generation).toBe(2)
    await expect(active.ctx.graphMode.control(active.agent, { ...request, reason: 'conflicting reuse' }))
      .rejects.toThrow('was reused with different input')
    await expect(active.ctx.graphMode.control(active.agent, {
      ...request,
      operationId: GraphControlOperationId('stale-retry-node'),
    })).rejects.toThrow('stale graph control generation: expected 1, current 2')
  })

  it('retries one logical work item through a distinct real coordination activation', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'first activation complete', artifacts: [] }),
      workerResult({ summary: 'second activation complete', artifacts: [] }),
    ])
    const active = await harness({ provider, memoryCoordination: true })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'activation identity', graph: singleRevision('activation-identity'),
    })
    const first = await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    expect(first.phase).toBe('succeeded')

    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('retry-real-coordination'),
      action: 'retry-node',
      ...controlAddress(active.ctx, active.agent, first.id),
      nodeId: GraphNodeId('a'),
      reason: 'verify physical activation identity',
    })
    const second = await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    expect(second).toMatchObject({ generation: 2, phase: 'succeeded' })
    const activations = active.agent.session.events
      .filter(event => event.type === 'graph/operation' && event.data.stage === 'claimed')
      .map(event => (event.data as GraphOperationTransition).generationId)
    expect(new Set(activations)).toEqual(new Set([first.generationId, second.generationId]))
  })

  it('skips only a declared skippable node in a new generation', async () => {
    const provider = new GraphWorkerProvider([() => Promise.reject(new Error('operator will skip'))])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph = { ...singleRevision('skip-control'), nodes: [{ ...task('a', 'optional work'), skippable: true }] }
    const submitted = await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'optional work', graph })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const runId = GraphRunId(submitted.runId as string)
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-skip-node'),
      action: 'skip-node',
      ...controlAddress(active.ctx, active.agent, runId),
      nodeId: GraphNodeId('a'),
      reason: 'the optional output is not needed',
    })
    const skipped = await terminalRunId(active.ctx, active.agent, runId)
    expect(skipped).toMatchObject({ generation: 2, phase: 'succeeded', nodes: { a: { phase: 'skipped' } } })
    expect(record).toMatchObject({ resultingGeneration: 2, impact: { invalidatedNodeIds: ['a'] } })
    expect(provider.requests).toHaveLength(1)
  })

  it('resumes from one failed node without rerunning an accepted predecessor', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'accepted predecessor', artifacts: [] }),
      () => Promise.reject(new Error('second node failed')),
      workerResult({ summary: 'resumed successor', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph: GraphRevision = {
      ...singleRevision('resume-control'),
      nodes: [task('a', 'accepted first'), task('b', 'resume here')],
      edges: [{ from: GraphNodeId('a'), to: GraphNodeId('b'), kind: 'data' }],
    }
    const submitted = await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'resume work', graph })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const runId = GraphRunId(submitted.runId as string)
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-resume-node'),
      action: 'resume-from-node',
      ...controlAddress(active.ctx, active.agent, runId),
      nodeId: GraphNodeId('b'),
      reason: 'resume after repairing the external dependency',
    })
    const resumed = await terminalRunId(active.ctx, active.agent, runId)
    expect(resumed).toMatchObject({
      generation: 2,
      phase: 'succeeded',
      nodes: { a: { phase: 'succeeded', output: { summary: 'accepted predecessor' } }, b: { phase: 'succeeded' } },
    })
    expect(record.impact).toEqual({ invalidatedNodeIds: ['b'], reusedNodeIds: ['a'] })
    expect(provider.requests.map(request => request.label)).toEqual(['Engineer: A', 'Engineer: B', 'Engineer: B'])
  })

  it('rejects a planning checkpoint into an auditable canceled terminal run', async () => {
    const provider = new GraphWorkerProvider([workerResult({ summary: 'architecture evidence', artifacts: [] })])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const graph: GraphRevision = {
      ...singleRevision('reject-checkpoint'),
      nodes: [
        { ...task('architecture', 'design the change'), kind: 'design', roleId: GraphRoleId('architect') },
        task('implementation', 'implement after approval'),
      ],
      edges: [{ from: GraphNodeId('architecture'), to: GraphNodeId('implementation'), kind: 'data' }],
    }
    const submitted = await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'review architecture', graph })
    const runId = GraphRunId(submitted.runId as string)
    await vi.waitFor(() => { expect(active.ctx.graphMode.state(active.agent).runs[runId]?.phase).toBe('paused') })
    const checkpoint = Object.values(active.ctx.graphMode.state(active.agent).checkpoints).find(item => item.runId === runId)
    if (checkpoint === undefined) throw new Error('planning checkpoint must exist')
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-reject-checkpoint'),
      action: 'reject-checkpoint',
      ...controlAddress(active.ctx, active.agent, runId),
      checkpointId: checkpoint.id,
      reason: 'architecture does not meet the acceptance criteria',
    })
    expect(active.ctx.graphMode.state(active.agent).checkpoints[checkpoint.id]?.status).toBe('canceled')
    expect(active.ctx.graphMode.state(active.agent).runs[runId]).toMatchObject({
      phase: 'canceled', terminal: { outcome: 'canceled', rule: 'checkpoint-rejected' },
    })
    expect(record).toMatchObject({ action: 'reject-checkpoint', checkpointId: checkpoint.id })
    expect(provider.requests).toHaveLength(1)
  })

  it('rolls a historical design forward as a new immutable head revision', async () => {
    const provider = new GraphWorkerProvider([
      workerResult({ summary: 'revision one', artifacts: [] }),
      workerResult({ summary: 'revision two', artifacts: [] }),
      workerResult({ summary: 'rolled-forward revision', artifacts: [] }),
    ])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const first = { ...singleRevision('rollback-control'), nodes: [task('a', 'original objective')] }
    const acceptedFirst = await active.ctx.graphMode.submit(active.agent, { intent: 'new', reason: 'original design', graph: first })
    await terminalRunId(active.ctx, active.agent, acceptedFirst.runId as string)
    const second: GraphRevision = {
      ...first,
      revision: 2,
      parentRevision: 1,
      createdAt: 2,
      userInput: 'replace objective',
      nodes: [task('a', 'replacement objective')],
    }
    const acceptedSecond = await active.ctx.graphMode.submit(active.agent, {
      intent: 'revise', reason: 'replacement design', graph: second, changedNodeIds: [GraphNodeId('a')],
    })
    await terminalRunId(active.ctx, active.agent, acceptedSecond.runId as string)
    const runId = GraphRunId(acceptedSecond.runId as string)
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-rollback-revision'),
      action: 'rollback',
      ...controlAddress(active.ctx, active.agent, runId),
      targetRevision: 1,
      reason: 'restore the accepted original design',
    })
    await vi.waitFor(() => {
      expect(Object.values(active.ctx.graphMode.state(active.agent).runs)
        .find(run => run.graphId === first.graphId && run.revision === 3)?.phase).toBe('succeeded')
    })
    const head = active.ctx.graphMode.state(active.agent).graphs[first.graphId]?.at(-1)
    expect(head).toMatchObject({ revision: 3, parentRevision: 2, nodes: [{ objective: 'original objective' }] })
    expect(record).toMatchObject({ resultingRevision: 3, targetRevision: 1 })
  })

  it('accepts schema-valid substitute output with durable control provenance', async () => {
    const provider = new GraphWorkerProvider([() => Promise.reject(new Error('manual evidence required'))])
    const active = await harness({ provider })
    active.ctx.graphMode.setConfig(active.agent, { ...defaultGraphModeConfig(), active: true })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'supply output', graph: singleRevision('supply-output'),
    })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const operationId = GraphControlOperationId('control-supply-output')
    const record = await active.ctx.graphMode.control(active.agent, {
      operationId,
      action: 'supply-output',
      ...controlAddress(active.ctx, active.agent, GraphRunId(submitted.runId as string)),
      nodeId: GraphNodeId('a'),
      output: { summary: 'human-verified result', data: { source: 'operator' }, artifacts: ['evidence.txt'] },
      reason: 'operator supplied independently verified evidence',
    }, { actor: { kind: 'human', id: 'operator-1' }, source: 'host-api' })
    const run = await terminalRunId(active.ctx, active.agent, submitted.runId as string)

    expect(run).toMatchObject({
      generation: 2,
      phase: 'succeeded',
      nodes: { a: { phase: 'succeeded', attempts: [], suppliedByControlId: operationId, output: { summary: 'human-verified result' } } },
    })
    expect(record).toMatchObject({
      suppliedOutput: { summary: 'human-verified result' },
      actor: { kind: 'human', id: 'operator-1' },
      resultingGeneration: 2,
    })
    expect(provider.requests).toHaveLength(1)
  })

  it('freezes historical settings and applies a forced model only to the controlled generation', async () => {
    const provider = new GraphWorkerProvider([
      () => Promise.reject(new Error('force a retry')),
      workerResult({ summary: 'override succeeded', artifacts: [] }),
    ])
    const active = await harness({ provider })
    const original = defaultGraphModeConfig()
    const roles = original.roles.map(role => role.id === 'engineer'
      ? { ...role, model: { provider: 'local', model: 'original-model', reasoningEffort: 'low' } }
      : role)
    active.ctx.graphMode.setConfig(active.agent, { ...original, active: true, roles })
    const submitted = await active.ctx.graphMode.submit(active.agent, {
      intent: 'new', reason: 'historical settings', graph: singleRevision('override-control'),
    })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const changedRoles = roles.map(role => role.id === 'engineer' ? { ...role, model: { provider: 'remote', model: 'new-global' } } : role)
    active.ctx.graphMode.setConfig(active.agent, { ...original, active: true, roles: changedRoles })
    await active.ctx.graphMode.control(active.agent, {
      operationId: GraphControlOperationId('control-override-node'),
      action: 'override-node',
      ...controlAddress(active.ctx, active.agent, GraphRunId(submitted.runId as string)),
      nodeId: GraphNodeId('a'),
      override: {
        model: { provider: 'forced', model: 'forced-model', reasoningEffort: 'high' },
        executionBudget: {
          ...defaultGraphNodeExecutionBudget(),
          maxOutputTokens: 4_096,
          maxReasoningOnlyTokens: 512,
        },
      },
      reason: 'use a larger model for this retry only',
    })
    await terminalRunId(active.ctx, active.agent, submitted.runId as string)
    const run = active.ctx.graphMode.state(active.agent).runs[submitted.runId as string]
    expect(run?.configSnapshot.roles.find(role => role.id === 'engineer')?.model.model).toBe('original-model')
    expect(run?.overrides['a']?.model?.model).toBe('forced-model')
    expect(run?.nodes['a']?.attempts[0]?.executionBudget).toMatchObject({
      maxOutputTokens: 4_096,
      maxReasoningOnlyTokens: 512,
    })
    expect(provider.requests[1]?.agentOptions).toMatchObject({ provider: 'forced', model: 'forced-model', reasoningEffort: ReasoningEffortId('high') })
    expect(active.ctx.graphMode.state(active.agent).config.roles.find(role => role.id === 'engineer')?.model.model).toBe('new-global')
  })
})
