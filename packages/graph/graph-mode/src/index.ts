/**
 * Session-scoped graph controller and bounded background DAG scheduler.
 * @module @deepseek-ai/dsh-graph-mode
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GraphActivationId,
  GraphAttemptId,
  GraphCampaignBatchId,
  GraphCampaignId,
  GraphCheckpointId,
  GraphControlOperationId,
  GraphOperationEventId,
  GraphSubmissionId,
  GraphTaskId,
  GraphRunGenerationId,
  GraphSettlementId,
  GraphWorkId,
  MAX_GRAPH_TIMER_MS,
  GraphRunId,
  GraphId,
  MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES,
  MAX_GRAPH_ENVIRONMENT_OPERATIONS,
  defaultGraphModeConfig,
  defaultGraphControllerResiliencePolicy,
  defaultGraphNodeExecutionBudget,
  defaultGraphOutputSchema,
  downstreamInvalidation,
  foldGraph,
  graphEnvironmentApprovalText,
  graphActiveSubagentLimit,
  validateGraphModeConfig,
  validateGraphCheckpoint,
  validateGraphNodeOutput,
  validateGraphRevision,
} from '@deepseek-ai/dsh-graph'
import type {
  GraphCondition,
  GraphCampaign,
  GraphCheckpoint,
  GraphControlActor,
  GraphExpansionProposal,
  GraphExecutionCheckpoint,
  GraphExecutionHealth,
  GraphEnvironmentCapability,
  GraphEnvironmentPlan,
  GraphAttempt,
  GraphJsonValue,
  GraphModelExecutionProfile,
  GraphModeConfig,
  GraphControllerFallbackModel,
  GraphNode,
  GraphNodeId,
  GraphNodeWorkspacePolicy,
  GraphNodeExecutionOverride,
  GraphNodeExecutionBudget,
  GraphNodeOutput,
  GraphOutputSchema,
  GraphNodeRun,
  GraphProjection,
  GraphRevision,
  GraphRole,
  GraphRun,
  GraphRunUpdate,
  GraphRunError,
  GraphReviewIssue,
  GraphOperationTransition,
  GraphOperationStage,
  GraphExternalReference,
  GraphBranchEvaluation,
  GraphSettlementRecord,
  GraphRevisionSubmissionRecord,
  GraphRevisionKind,
  GraphRevisionLineage,
  GraphTerminationPolicy,
} from '@deepseek-ai/dsh-graph'
import type { CompactionRequestPolicy } from '@deepseek-ai/dsh-compaction'
import type GraphCoordination from '@deepseek-ai/dsh-graph-coordination'
import type {
  GraphCoordinationClaim,
  GraphCoordinationHeartbeat,
  GraphCoordinationObservation,
  GraphCoordinationObserveRequest,
} from '@deepseek-ai/dsh-graph-coordination'
import type {} from '@deepseek-ai/dsh-graph-artifacts'
import type { GraphResourceReservation, GraphResourceSnapshot } from '@deepseek-ai/dsh-graph-resources'
import {
  GraphSchedulerAuthorityError,
  GraphSchedulerOwnerId,
  type GraphSchedulerLease,
  type GraphSchedulerLeaseRequest,
  type GraphSchedulerDecision,
} from '@deepseek-ai/dsh-graph-scheduler'
import {
  GraphWorkerId,
  GraphWorkspaceAllocationId,
  type GraphWorkerAssignment,
  type GraphArtifactManifest,
  type GraphWorkerResult,
  type GraphWorkerRun,
  type GraphWorkspaceMode,
} from '@deepseek-ai/dsh-graph-worker'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'graph-mode': { kind: 'graph-mode' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphMode: GraphModeController
  }
}

/** Deployment choices for graph worker dispatch. */
export interface Config {
  /** Registered Graph Worker Provider used unless a later role override selects another. */
  workerProvider?: string
  /** Default workspace guarantee resolved for nodes without an explicit policy. */
  workspaceMode?: GraphWorkspaceMode
  /** Optional live model-resource Provider used below static hard ceilings. */
  resourceProvider?: string
  /** Maximum interval between coordination lease heartbeats. */
  coordinationHeartbeatMs?: number
  /** Optional cross-process authority that owns each whole Graph run. */
  schedulerProvider?: string
  /** Maximum interval between whole-run scheduler lease heartbeats. */
  schedulerHeartbeatMs?: number
  /** Deadline for one external cleanup, settlement, or reconciliation operation. */
  externalOperationTimeoutMs?: number
  /** Interval for detecting durable nonterminal runs without a local executor. */
  recoveryScanIntervalMs?: number
  /** Whether immutable environment nodes may request host command execution. */
  environmentEnabled?: boolean
  /** Host capability names environment nodes may request. */
  environmentCapabilities?: GraphEnvironmentCapability[]
  /** Whether an approved environment node may bypass filesystem confinement. */
  environmentDangerFullAccess?: boolean
  /** Live defaults copied only when a session first activates Graph Mode. */
  roles?: Volatile<GraphTemplateSettings['roles']>
  /** Global scheduling limits copied when a session first activates Graph Mode. */
  limits?: Volatile<GraphTemplateSettings['limits']>
  /** Default worker execution policy copied when a session first activates Graph Mode. */
  executionPolicy?: Volatile<GraphTemplateSettings['executionPolicy']>
  /** Controller fallback and compaction policy copied when a session first activates Graph Mode. */
  controllerResilience?: Volatile<GraphTemplateSettings['controllerResilience']>
}

/** Deployment authority applied while admitting environment nodes. */
export interface GraphEnvironmentHostPolicy {
  readonly enabled: boolean
  readonly capabilities: readonly GraphEnvironmentCapability[]
  readonly dangerFullAccess: boolean
}

const DISABLED_ENVIRONMENT_POLICY: GraphEnvironmentHostPolicy = {
  enabled: false,
  capabilities: [],
  dangerFullAccess: false,
}

/** Global role and scheduler defaults copied into a session on first activation. */
export interface GraphTemplateSettings {
  /** Default roles and their model selections. */
  readonly roles: GraphModeConfig['roles']
  /** Global and per-model scheduling limits. */
  readonly limits: GraphModeConfig['limits']
  /** Default limits applied to Graph worker execution. */
  readonly executionPolicy: GraphModeConfig['executionPolicy']
  /** Controller fallback models and recovery policy. */
  readonly controllerResilience: NonNullable<GraphModeConfig['controllerResilience']>
}

interface GraphRecoverySource {
  readonly run: GraphRun
  readonly transitions: readonly GraphOperationTransition[]
  readonly inherited: boolean
}

/** User-settings namespace rendered by plugin settings surfaces. */
export const GRAPH_TEMPLATE_SETTINGS_NAMESPACE = 'graph-mode'

const modelSelectionConfig = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string() })
const controllerFallbackModelConfig = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  controller: z.boolean().required(),
  compaction: z.boolean().required(),
})
/** Settings schema rendered by the general plugin settings surface. */
const graphTemplateFields = {
  roles: z.array(z.object({
    id: z.string().required(),
    label: z.string().required(),
    description: z.string().required(),
    controller: z.boolean().required(),
    enabled: z.boolean().required(),
    model: modelSelectionConfig.required(),
    prompt: z.string().required(),
    workerProvider: z.string(),
    maxParallel: z.natural().min(1).required(),
  })).required(),
  limits: z.object({
    globalMaxParallel: z.natural().min(1).required(),
    controllerReserve: z.natural().min(1).required(),
    maxActiveSubagents: z.natural().min(1),
    models: z.array(z.object({
      provider: z.string(),
      model: z.string().required(),
      maxParallel: z.natural().min(1).required(),
      maxWeight: z.number().min(0),
    })).required(),
  }).required(),
  executionPolicy: z.object({
    maxNodesPerRevision: z.natural().min(1).required(),
    maxAttemptsPerNode: z.natural().min(1).required(),
    maxGraphRevisions: z.natural().min(1).required(),
    maxRepairRevisions: z.natural().min(1).required(),
    maxDynamicExpansions: z.natural().min(1).required(),
    maxSubgraphDepth: z.natural().min(1).required(),
    maxRuntimeContinuations: z.natural().min(1).required(),
    maxOutputTokens: z.natural().min(1).required(),
    maxReasoningOnlyTokens: z.natural().min(1).required(),
    firstDurableActionMs: z.natural().min(1).max(MAX_GRAPH_TIMER_MS).required(),
    maxNoDurableProgressMs: z.natural().min(1).max(MAX_GRAPH_TIMER_MS).required(),
    checkpointIntervalMs: z.natural().min(1).max(MAX_GRAPH_TIMER_MS).required(),
    maxWallTimeMs: z.natural().min(1).max(MAX_GRAPH_TIMER_MS).required(),
    maxOutputBytes: z.natural().min(1).required(),
    noProgressLimit: z.natural().min(1).required(),
  }).required(),
  controllerResilience: z.object({
    enabled: z.boolean().required(),
    maxFallbackAttemptsPerTurn: z.natural().min(1).required(),
    retryableFailureCodes: z.array(z.string().required()).required(),
    fallbackModels: z.array(controllerFallbackModelConfig).required(),
    compaction: z.object({
      enabled: z.boolean().required(),
      thresholdRatio: z.number().min(0).max(1).required(),
      retainRatio: z.number().min(0).max(1).required(),
      maxTokens: z.natural().min(1).required(),
      reasoningEffort: z.string(),
    }).required(),
  }).required(),
} as const

/** Validates the Graph role template copied into each newly activated session. */
export const GraphTemplateSettings = z.object(graphTemplateFields) as unknown as z<GraphTemplateSettings>

/** Plugin configuration schema; template fields remain live in the profile editor. */
export const Config: z<Config> = z.object({
  workerProvider: z.string().default('local'),
  workspaceMode: z.union(['shared', 'isolated-copy', 'read-only-snapshot', 'git-worktree', 'sandbox-mount'] as const).default('shared'),
  resourceProvider: z.string(),
  coordinationHeartbeatMs: z.natural().min(100).max(300_000).default(15_000),
  schedulerProvider: z.string(),
  schedulerHeartbeatMs: z.natural().min(100).max(300_000).default(5_000),
  externalOperationTimeoutMs: z.natural().min(1).max(MAX_GRAPH_TIMER_MS).default(60_000),
  recoveryScanIntervalMs: z.natural().min(100).max(300_000).default(15_000),
  environmentEnabled: z.boolean().default(true),
  environmentCapabilities: z.array(z.union(['network', 'host-package-install', 'docker'] as const))
    .default(['network', 'host-package-install', 'docker']),
  environmentDangerFullAccess: z.boolean().default(true),
  roles: graphTemplateFields.roles.default(defaultGraphModeConfig().roles as never).volatile(),
  limits: graphTemplateFields.limits.default(defaultGraphModeConfig().limits as never).volatile(),
  executionPolicy: graphTemplateFields.executionPolicy.default(defaultGraphModeConfig().executionPolicy as never).volatile(),
  controllerResilience: graphTemplateFields.controllerResilience.default(defaultGraphControllerResiliencePolicy() as never).volatile(),
}) as unknown as z<Config>

type ControllerIntent = 'new' | 'revise' | 'inspect' | 'control' | 'clarify' | 'direct'
const terminalNodePhase = (phase: GraphNodeRun['phase']): boolean => ['succeeded', 'failed', 'skipped', 'blocked', 'stale', 'canceled', 'exhausted'].includes(phase)
const taskModificationCheckpoint = (checkpoint: GraphCheckpoint): boolean => (
  checkpoint.kind === 'awaiting_user'
  && checkpoint.issues?.some(issue => issue.id === `modify-${checkpoint.nodeId}`) === true
)

/** Build the smallest durable replacement that advances one existing run generation. */
const runUpdateOf = (prior: GraphRun, next: GraphRun): GraphRunUpdate => ({
  version: 1,
  runId: next.id,
  graphId: next.graphId,
  revision: next.revision,
  generation: next.generation,
  generationId: next.generationId,
  ownerEpoch: next.ownerEpoch,
  phase: next.phase,
  updatedAt: next.updatedAt,
  nodes: Object.fromEntries(Object.entries(next.nodes).filter(([id, node]) => (
    !isDeepStrictEqual(prior.nodes[id], node)
  ))),
  ...next.terminal === undefined || isDeepStrictEqual(prior.terminal, next.terminal)
    ? {}
    : { terminal: next.terminal },
  ...next.error === undefined || isDeepStrictEqual(prior.error, next.error)
    ? {}
    : { error: next.error },
})

/** Append one incremental run update and return the complete state held by the scheduler. */
const appendRunUpdate = (agent: Agent, prior: GraphRun, next: GraphRun): GraphRun => {
  agent.session.append('graph/run-update', runUpdateOf(prior, next))
  return next
}

const waitForHeartbeat = async (milliseconds: number, signal: AbortSignal): Promise<boolean> => {
  if (signal.aborted) return false
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(true) }, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false) }, { once: true })
  })
}

type GraphStallReason = NonNullable<GraphExecutionHealth['stalledReason']>

interface WorkerProgressSnapshot {
  readonly health: GraphExecutionHealth
  readonly checkpoints: readonly GraphExecutionCheckpoint[]
}

const parsedToolArguments = (value: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined
  } catch {
    return undefined
  }
}

const commandText = (args: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const candidate = args?.['command'] ?? args?.['cmd']
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

const durableToolAction = (name: string, args: Readonly<Record<string, unknown>> | undefined): boolean => {
  if (['write', 'edit', 'apply_patch', 'str_replace_editor'].includes(name)) return true
  if (!['bash', 'pwsh', 'shell', 'terminal'].includes(name)) return false
  return /(?:^|\W)(?:test(?!-)|build|typecheck|lint|check|verify)(?:\W|$)/iu.test(commandText(args) ?? '')
}

const toolResultText = (event: Extract<SessionEvent, { type: 'tool/result' }>): string => (
  event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
)

const verificationExitCode = (event: Extract<SessionEvent, { type: 'tool/result' }>): number => {
  const text = toolResultText(event)
  const marker = text.match(/\[(?:exit code|shell exited: code)[: ]+(\d+)\]/iu)
  return marker === null ? 0 : Number(marker[1])
}

const checkpointFile = (workspaceRoot: string, value: string): { readonly path: string; readonly contentHash: string } | undefined => {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value)
  const portable = relative(workspaceRoot, absolute).replaceAll('\\', '/')
  if (!portable || portable === '..' || portable.startsWith('../')) return undefined
  try {
    return { path: portable, contentHash: `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}` }
  } catch (error) {
    return { path: portable, contentHash: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable' }
  }
}

const workspaceContentHash = (workspaceRoot: string, value: string): string | null => {
  const absolute = resolve(workspaceRoot, value)
  const portable = relative(workspaceRoot, absolute).replaceAll('\\', '/')
  if (!portable || portable === '..' || portable.startsWith('../')) throw new Error(`artifact path escapes the integration workspace: ${value}`)
  try {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) return createHash('sha256').update(readlinkSync(absolute)).digest('hex')
    if (!stat.isFile()) throw new Error(`artifact target is not a regular file or symlink: ${value}`)
    return createHash('sha256').update(readFileSync(absolute)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

class WorkerProgressMonitor {
  private health: GraphExecutionHealth
  private readonly checkpoints: GraphExecutionCheckpoint[] = []
  private readonly calls = new Map<string, { readonly name: string; readonly args?: Readonly<Record<string, unknown>> }>()
  private readonly changedFiles = new Map<string, string>()
  private readonly seen = new Set<number>()
  private firstActionTimer: ReturnType<typeof setTimeout> | undefined
  private noProgressTimer: ReturnType<typeof setTimeout> | undefined
  private reasoningTokensSinceDurableProgress = 0
  private liveChunksSinceSettlement = false
  private disposed = false
  private readonly disposeEvent: () => void
  private readonly disposeStream: () => void

  constructor(
    ctx: Context,
    private readonly run: GraphWorkerRun,
    private readonly node: GraphNode,
    private readonly budget: GraphNodeExecutionBudget,
    private readonly workId: GraphWorkId,
    private readonly attemptId: GraphAttemptId,
    private readonly activation: number,
    private readonly externalOperationTimeoutMs: number,
    private readonly beforeCancel: () => Promise<void>,
    attemptStartedAt: number,
    private readonly publish: (snapshot: WorkerProgressSnapshot) => void,
    baseline?: WorkerProgressSnapshot,
  ) {
    this.checkpoints.push(...baseline?.checkpoints ?? [])
    for (const file of baseline?.checkpoints.at(-1)?.changedFiles ?? []) this.changedFiles.set(file.path, file.contentHash)
    if (baseline === undefined) {
      this.health = {
        status: 'starting', startedAt: attemptStartedAt, estimatedReasoningTokens: 0, reasoningCharacters: 0,
        inputTokens: 0, outputTokens: 0, providerReasoningTokens: 0,
        toolCalls: 0, durableActions: 0, changedFileCount: 0, checkpointCount: 0,
      }
    } else {
      const { stalledReason: _stalledReason, ...resumedHealth } = baseline.health
      this.health = { ...resumedHealth, status: 'checkpointed' }
    }
    this.disposeEvent = ctx.on('session/event', (session, event) => {
      if (String(session.id) === run.childSessionId) this.accept(event)
    })
    this.disposeStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (String(agent.session.id) !== run.childSessionId || frame.type !== 'chunk') return
      this.liveChunksSinceSettlement = true
      this.acceptModelChunk(frame.chunk, frame.time)
    })
    const session = run.childSessionId === undefined ? undefined : ctx.sessions.get(SessionId(run.childSessionId))
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session?.snapshotEvents() ?? []) this.accept(event)
    this.firstActionTimer = setTimeout(() => { this.stall('first-durable-action-timeout') }, budget.firstDurableActionMs)
    this.resetNoProgressTimer()
    this.publish(this.snapshot())
  }

  stop(): WorkerProgressSnapshot {
    if (!this.disposed) {
      this.disposed = true
      this.disposeEvent()
      this.disposeStream()
      if (this.firstActionTimer !== undefined) clearTimeout(this.firstActionTimer)
      if (this.noProgressTimer !== undefined) clearTimeout(this.noProgressTimer)
    }
    return this.snapshot()
  }

  markMaxTokensWithoutProgress(): WorkerProgressSnapshot {
    if (this.health.durableActions === 0) this.setStalled('max-tokens-without-progress', false)
    return this.snapshot()
  }

  markStalled(reason: GraphStallReason): WorkerProgressSnapshot {
    this.setStalled(reason, false)
    return this.snapshot()
  }

  private snapshot(): WorkerProgressSnapshot {
    return { health: { ...this.health }, checkpoints: this.checkpoints.map(checkpoint => ({ ...checkpoint })) }
  }

  private accept(event: SessionEvent): void {
    if (this.disposed || this.seen.has(event.seq)) return
    this.seen.add(event.seq)
    const at = event.time
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      if (!this.liveChunksSinceSettlement) {
        for (const item of expandAssistantStream(event.data.stream)) this.acceptModelChunk(item.chunk, item.time)
      }
      this.liveChunksSinceSettlement = false
    }
    if (event.type === 'request/context') {
      this.health = {
        ...this.health,
        ...event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow },
      }
      this.publish(this.snapshot())
      return
    }
    if (event.type === 'request/header') {
      this.health = {
        ...this.health,
        ...event.data.header.config.maxTokens === undefined ? {} : { maxOutputTokens: event.data.header.config.maxTokens },
      }
      this.publish(this.snapshot())
      return
    }
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      this.health = {
        ...this.health,
        inputTokens: this.health.inputTokens + event.data.usage.inputTokens,
        outputTokens: this.health.outputTokens + event.data.usage.outputTokens,
        providerReasoningTokens: this.health.providerReasoningTokens + (event.data.usage.reasoningTokens ?? 0),
      }
      this.publish(this.snapshot())
      return
    }
    if (event.type === 'tool/call') {
      const args = parsedToolArguments(event.data.arguments)
      this.calls.set(String(event.data.callId), { name: event.data.name, ...args === undefined ? {} : { args } })
      this.health = { ...this.health, status: 'active', lastModelActivityAt: at, toolCalls: this.health.toolCalls + 1 }
      return
    }
    if (event.type !== 'tool/result' || event.data.error !== undefined) return
    const call = this.calls.get(String(event.data.message.toolCallId))
    if (call === undefined || !durableToolAction(call.name, call.args)) return
    const command = commandText(call.args)
    const exitCode = command === undefined ? undefined : verificationExitCode(event)
    if (exitCode !== undefined && Number.isSafeInteger(exitCode) && exitCode !== 0) return
    const path = call.args?.['file_path'] ?? call.args?.['path']
    if (typeof path === 'string' && path.trim()) {
      const evidence = checkpointFile(this.run.workspace.root, path.trim())
      if (evidence !== undefined) this.changedFiles.set(evidence.path, evidence.contentHash)
    }
    const resultSummary = toolResultText(event).trim()
    const verificationSummary = resultSummary.slice(-2_000).trim()
    const checkpoint: GraphExecutionCheckpoint = {
      workId: this.workId,
      attemptId: this.attemptId,
      activation: this.activation,
      sequence: this.checkpoints.length + 1,
      createdAt: at,
      completedCriteria: [],
      changedFiles: [...this.changedFiles].sort(([left], [right]) => left.localeCompare(right))
        .map(([file, contentHash]) => ({ path: file, contentHash })),
      verification: command === undefined ? [] : [{
        command,
        exitCode: exitCode ?? 0,
        summary: verificationSummary || 'Command completed without output.',
      }],
      remainingWork: [...this.node.acceptanceCriteria],
      nextAction: 'Continue with the next unmet acceptance criterion.',
    }
    this.checkpoints.push(checkpoint)
    this.reasoningTokensSinceDurableProgress = 0
    if (this.firstActionTimer !== undefined) clearTimeout(this.firstActionTimer)
    this.health = {
      ...this.health,
      status: 'checkpointed',
      lastDurableProgressAt: at,
      durableActions: this.health.durableActions + 1,
      changedFileCount: this.changedFiles.size,
      checkpointCount: this.checkpoints.length,
    }
    this.resetNoProgressTimer()
    this.publish(this.snapshot())
  }

  private acceptModelChunk(chunk: import('@deepseek-ai/dsh-llm').StreamChunk, at: number): void {
    if (this.disposed) return
    this.health = { ...this.health, lastModelActivityAt: at }
    if (chunk.type !== 'reasoning-delta') return
    const characters = Array.from(chunk.text).length
    const estimated = Math.ceil(Buffer.byteLength(chunk.text, 'utf8') / 4)
    this.health = {
      ...this.health,
      status: this.health.durableActions === 0 ? 'reasoning' : this.health.status,
      reasoningCharacters: this.health.reasoningCharacters + characters,
      estimatedReasoningTokens: this.health.estimatedReasoningTokens + estimated,
    }
    this.reasoningTokensSinceDurableProgress += estimated
    if (this.reasoningTokensSinceDurableProgress >= this.budget.maxReasoningOnlyTokens) this.stall('reasoning-budget')
  }

  private resetNoProgressTimer(): void {
    if (this.noProgressTimer !== undefined) clearTimeout(this.noProgressTimer)
    const checkpointFirst = this.budget.checkpointIntervalMs < this.budget.maxNoDurableProgressMs
    this.noProgressTimer = setTimeout(
      () => { this.stall(checkpointFirst ? 'checkpoint-timeout' : 'no-durable-progress-timeout') },
      Math.min(this.budget.checkpointIntervalMs, this.budget.maxNoDurableProgressMs),
    )
  }

  private stall(reason: GraphStallReason): void {
    this.setStalled(reason, true)
  }

  private setStalled(reason: GraphStallReason, cancel: boolean): void {
    if (this.disposed || this.health.status === 'stalled') return
    this.health = { ...this.health, status: 'stalled', stalledReason: reason }
    this.publish(this.snapshot())
    if (cancel) {
      void this.beforeCancel()
        .then(async () => {
          await this.run.cancel(`graph worker stalled: ${reason}`, AbortSignal.timeout(this.externalOperationTimeoutMs))
        })
        .catch(() => { /* terminal Worker settlement reports cancellation failure */ })
    }
  }
}

class GraphWorkerStalledError extends Error {
  constructor(
    readonly reason: GraphStallReason,
    readonly snapshot: WorkerProgressSnapshot,
  ) {
    super(`worker made no recoverable progress: ${reason}`)
    this.name = 'GraphWorkerStalledError'
  }
}

class GraphWorkerRevisionRequiredError extends Error {
  constructor(
    readonly code: string,
    readonly workerMessage: string,
  ) {
    super(workerMessage)
    this.name = 'GraphWorkerRevisionRequiredError'
  }
}

const conditionToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'array',
      items: { type: 'string' },
      description: 'Property path within the predecessor output data object.',
      required: true,
    },
    operator: { type: 'string', enum: ['exists', 'truthy', 'equals', 'not-equals'], required: true },
    value: {
      oneOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
      ],
      description: 'Required for equals and not-equals; forbidden for exists and truthy.',
    },
  },
} as const

const standardOutputSchemaTool = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    version: { type: 'number', required: true },
    maxBytes: { type: 'number', required: true },
    schema: { type: 'object', additionalProperties: true, required: true },
  },
} as const

const graphRevisionToolSchema = {
  type: 'object',
  // Top-level extras reach the strict durable validator after session defaults are resolved.
  additionalProperties: true,
  properties: {
    objective: { type: 'string', description: 'Complete graph outcome.', required: true },
    userInput: { type: 'string', description: 'The current human request represented by this revision.', required: true },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          objective: { type: 'string', required: true },
          kind: {
            type: 'string',
            enum: ['analysis', 'design', 'environment', 'implementation', 'review', 'verification', 'documentation', 'integration', 'specialist', 'expansion', 'subgraph'],
            required: true,
          },
          roleId: { type: 'string', description: 'One enabled non-controller role id.', required: true },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, required: true },
          outputSchema: { ...standardOutputSchemaTool, description: 'Optional specialized result schema; ordinary nodes inherit the standard structured result, while review and verification nodes also require Host-owned data.decision and data.issues fields.' },
          maxAttempts: { type: 'number', description: 'Optional positive attempt ceiling; defaults to the frozen session policy.' },
          weight: { type: 'number', description: 'Optional positive scheduling weight; defaults to one.' },
          executionBudget: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional per-node limits within the frozen session policy.',
            properties: {
              maxOutputTokens: { type: 'number', required: true },
              maxReasoningOnlyTokens: { type: 'number', required: true },
              firstDurableActionMs: { type: 'number', required: true },
              maxNoDurableProgressMs: { type: 'number', required: true },
              checkpointIntervalMs: { type: 'number', required: true },
              maxWallTimeMs: { type: 'number', required: true },
              maxContinuations: { type: 'number', required: true },
            },
          },
          expansion: { type: 'object', additionalProperties: true },
          subgraph: { type: 'object', additionalProperties: true },
          environment: {
            type: 'object',
            additionalProperties: false,
            description: 'Required only for environment nodes. Every exact command receives mandatory human approval before execution.',
            properties: {
              requiredCapabilities: {
                type: 'array',
                items: { type: 'string', enum: ['network', 'host-package-install', 'docker'] },
                required: true,
              },
              sandboxMode: {
                type: 'string',
                enum: ['workspace-write', 'danger-full-access'],
                required: true,
              },
              operations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                    command: { type: 'string', required: true },
                    rollbackCommand: {
                      type: 'string',
                      description: 'Documentary rollback command; it is never executed automatically.',
                    },
                  },
                },
                required: true,
              },
            },
          },
          workspace: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional relative workspace ownership. Parallel mutating nodes must declare disjoint writeRoots.',
            properties: {
              mode: { type: 'string', enum: ['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared'], required: true },
              readRoots: {
                type: 'array',
                items: { type: 'string', description: 'Use "." for the whole source workspace or a normalized source-relative path.' },
                description: 'Readable source roots. Omission defaults to ["."]. Empty strings and absolute paths are invalid.',
              },
              writeRoots: {
                type: 'array',
                items: { type: 'string', description: 'A normalized source-relative path; use "." only for intentional whole-workspace ownership.' },
                required: true,
              },
              cleanup: {
                type: 'string',
                enum: ['delete-on-settlement', 'retain-on-failure', 'retain'],
                description: 'Omission retains shared workspaces and retains failed isolated workspaces for recovery.',
              },
            },
          },
          skippable: { type: 'boolean', description: 'Whether human control may skip this node; defaults to false.' },
          effectPolicy: { type: 'string', enum: ['idempotent', 'reconcile', 'manual'], required: true },
        },
      },
      required: true,
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          kind: { type: 'string', enum: ['control', 'data', 'conditional'], required: true },
          condition: conditionToolSchema,
          branchGroupId: { type: 'string' },
        },
      },
    },
    branchGroups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          to: { type: 'string', required: true },
          mode: { type: 'string', enum: ['all', 'any', 'exactly-one', 'activated'], required: true },
        },
      },
    },
  },
} as const

const errorMessage = (error: unknown): string => {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  if (message.length === 0) return 'unknown failure'
  return message.length <= 4_000 ? message : `${message.slice(0, 3_997)}...`
}
const failControl = (message: string): never => { throw new Error(message) }

const controlFingerprint = (
  request: GraphControlRequest,
  authority: GraphControlAuthority,
): string => JSON.stringify([
  request.action,
  request.graphId,
  request.runId,
  request.expectedRevision,
  request.expectedGeneration,
  request.expectedAttemptId,
  request.nodeId,
  request.checkpointId,
  request.targetRevision,
  request.override?.roleId,
  request.override?.model?.provider,
  request.override?.model?.model,
  request.override?.model?.reasoningEffort,
  request.override?.workerProvider,
  request.output,
  request.reason,
  authority.actor.kind,
  authority.actor.id,
  authority.source,
])

const recordedControlFingerprint = (record: import('@deepseek-ai/dsh-graph').GraphControlRecord): string => controlFingerprint({
  operationId: record.id,
  action: record.action,
  graphId: record.graphId,
  runId: record.runId,
  expectedRevision: record.expectedRevision,
  expectedGeneration: record.expectedGeneration,
  ...record.expectedAttemptId === undefined ? {} : { expectedAttemptId: record.expectedAttemptId },
  reason: record.reason,
  ...record.nodeId === undefined ? {} : { nodeId: record.nodeId },
  ...record.checkpointId === undefined ? {} : { checkpointId: record.checkpointId },
  ...record.targetRevision === undefined ? {} : { targetRevision: record.targetRevision },
  ...record.override === undefined ? {} : { override: record.override },
  ...record.suppliedOutput === undefined ? {} : { output: record.suppliedOutput },
}, { actor: record.actor, source: record.source })

const controlImpact = (run: GraphRun): import('@deepseek-ai/dsh-graph').GraphControlRecord['impact'] => ({
  invalidatedNodeIds: Object.values(run.nodes).filter(node => node.invalidatedBy !== undefined).map(node => node.nodeId),
  reusedNodeIds: Object.values(run.nodes).filter(node => node.invalidatedBy === undefined && ['succeeded', 'skipped'].includes(node.phase)).map(node => node.nodeId),
})

/** Stable logical execution identity; tuple fields remain separately durable on the run. */
const workIdOf = (agent: Agent, graph: GraphRevision, node: GraphNode): GraphWorkId => GraphWorkId(
  `work:${createHash('sha256')
    .update(JSON.stringify([agent.session.id, graph.graphId, graph.revision, node.id]))
    .digest('hex')}`,
)

const stableId = (prefix: string, fields: readonly unknown[]): string => `${prefix}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
const generationIdOf = (agent: Agent, graph: GraphRevision, generation: number): GraphRunGenerationId => GraphRunGenerationId(
  stableId('generation', [agent.session.id, graph.graphId, graph.revision, generation]),
)
const activationIdOf = (workId: GraphWorkId, generationId: GraphRunGenerationId): GraphActivationId => GraphActivationId(
  stableId('activation', [workId, generationId]),
)
const operationIdOf = (workId: GraphWorkId, generationId: GraphRunGenerationId): GraphControlOperationId => GraphControlOperationId(
  stableId('operation', [workId, generationId]),
)
const settlementIdOf = (workId: GraphWorkId, generationId: GraphRunGenerationId, kind: string): GraphSettlementId => GraphSettlementId(
  stableId('settlement', [workId, generationId, kind]),
)
const outputHashOf = (output: GraphNodeOutput): string => stableId('sha256', [output])

class GraphRunExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly nodeId: GraphNodeId,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause })
    this.name = 'GraphRunExecutionError'
  }
}

class GraphNodeCancellation extends Error {
  constructor(readonly nodeId: GraphNodeId, reason: string) {
    super(reason)
    this.name = 'GraphNodeCancellation'
  }
}

const terminalRunError = (run: GraphRun): GraphRunError | undefined => {
  for (const node of Object.values(run.nodes)) {
    const error = node.attempts.at(-1)?.error
    if (node.phase === 'failed' && error !== undefined) return { ...error, nodeId: node.nodeId }
  }
  /* v8 ignore next -- a failed node is published only after its terminal attempt error is stored. */
  return undefined
}

/** Semantic workspace ownership before Graph Mode resolves safe read and cleanup defaults. */
export interface GraphNodeWorkspaceDraft extends Omit<GraphNodeWorkspacePolicy, 'readRoots' | 'cleanup'> {
  readonly readRoots?: readonly string[]
  readonly cleanup?: GraphNodeWorkspacePolicy['cleanup']
}

/** Semantic node fields submitted by the controller before deployment defaults are resolved. */
export interface GraphNodeDraft extends Omit<GraphNode, 'outputSchema' | 'maxAttempts' | 'weight' | 'executionBudget' | 'workspace' | 'skippable'> {
  readonly outputSchema?: GraphNode['outputSchema']
  readonly maxAttempts?: number
  readonly weight?: number
  readonly executionBudget?: GraphNode['executionBudget']
  readonly workspace?: GraphNodeWorkspaceDraft
  readonly skippable?: boolean
}

/** Semantic graph plan submitted by the controller before session-owned fields are resolved. */
export interface GraphRevisionDraft extends Omit<GraphRevision, 'createdAt' | 'nodes' | 'edges' | 'branchGroups' | 'terminationPolicy'> {
  readonly createdAt?: number
  readonly nodes: readonly GraphNodeDraft[]
  readonly edges?: GraphRevision['edges']
  readonly branchGroups?: GraphRevision['branchGroups']
  readonly terminationPolicy?: Partial<GraphTerminationPolicy>
}

/** Semantic controller plan before Graph Mode assigns graph identity, revision lineage, and session policy. */
export type GraphControllerPlanDraft = Omit<GraphRevisionDraft, 'graphId' | 'revision' | 'parentRevision' | 'createdAt' | 'terminationPolicy'>

const resolvedDefaultOutputSchema = (node: GraphNodeDraft, maxBytes: number): GraphOutputSchema => {
  const base = defaultGraphOutputSchema(`node-output:${createHash('sha256').update(node.id).digest('hex').slice(0, 32)}`)
  if (node.kind !== 'review' && node.kind !== 'verification') return { ...base, maxBytes }
  return {
    ...base,
    maxBytes,
    schema: {
      ...base.schema,
      properties: {
        ...base.schema.properties,
        data: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['approved', 'rejected', 'needs-user'] },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
                  summary: { type: 'string' },
                  evidence: { type: 'array', items: { type: 'string' } },
                  ownerNodeIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'severity', 'summary', 'evidence', 'ownerNodeIds'],
              },
            },
          },
          required: ['decision', 'issues'],
        },
      },
      required: [...(base.schema.required ?? []), 'data'],
    },
  }
}

const resolvedOutputSchema = (node: GraphNodeDraft, maxBytes: number): GraphOutputSchema => {
  const declared = node.outputSchema
  if (declared === undefined) return resolvedDefaultOutputSchema(node, maxBytes)
  if (node.kind !== 'review' && node.kind !== 'verification') return declared
  const control = resolvedDefaultOutputSchema(node, maxBytes)
  const declaredData = declared.schema.properties?.['data']
  const controlData = control.schema.properties?.['data']
  if (controlData?.type !== 'object') throw new Error('Graph control output schema is invalid')
  const specializedData = declaredData?.type === 'object' ? declaredData : { type: 'object' as const }
  return {
    ...declared,
    schema: {
      ...declared.schema,
      properties: {
        ...declared.schema.properties,
        data: {
          ...specializedData,
          properties: {
            ...specializedData.properties,
            ...controlData.properties,
          },
          required: [...new Set([...(specializedData.required ?? []), ...(controlData.required ?? [])])],
        },
      },
      required: [...new Set([...(declared.schema.required ?? []), 'data'])],
    },
  }
}

const workspaceRootIssue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return 'provide a string root'
  if (value.length === 0) return 'use "." for the whole workspace or a normalized source-relative path; empty roots are invalid'
  if (value.trim() !== value) return 'remove surrounding whitespace'
  if (value === '.') return undefined
  if (value.includes('\\')) return 'use forward slashes in source-relative paths'
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return 'use "." or a source-relative path; absolute paths are forbidden'
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) return 'use a normalized source-relative path without empty, ".", or ".." segments'
  return undefined
}

const collectWorkspaceDraftIssues = (workspace: unknown, path: string, issues: string[]): void => {
  if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
    issues.push(`${path}: provide a workspace object`)
    return
  }
  const value = workspace as Record<string, unknown>
  const allowedKeys = new Set(['mode', 'readRoots', 'writeRoots', 'cleanup'])
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) issues.push(`${path}.${key}: unknown workspace field`)
  const modes = ['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared']
  if (typeof value.mode !== 'string' || !modes.includes(value.mode)) {
    issues.push(`${path}.mode: choose read-only-snapshot, isolated-copy, git-worktree, sandbox-mount, or shared`)
  }
  const roots = (field: 'readRoots' | 'writeRoots', optional: boolean): readonly unknown[] | undefined => {
    const candidate = value[field]
    if (candidate === undefined && optional) return undefined
    if (!Array.isArray(candidate)) {
      issues.push(`${path}.${field}: provide an array of normalized source-relative roots`)
      return undefined
    }
    const rootValues = candidate as readonly unknown[]
    const seen = new Set<string>()
    for (const [index, root] of rootValues.entries()) {
      const issue = workspaceRootIssue(root)
      if (issue !== undefined) issues.push(`${path}.${field}[${String(index)}]: ${issue}`)
      if (typeof root === 'string' && seen.has(root)) issues.push(`${path}.${field}[${String(index)}]: remove duplicate root ${JSON.stringify(root)}`)
      if (typeof root === 'string') seen.add(root)
    }
    return rootValues
  }
  roots('readRoots', true)
  const writeRoots = roots('writeRoots', false)
  if (value.cleanup !== undefined && (typeof value.cleanup !== 'string'
    || !['delete-on-settlement', 'retain-on-failure', 'retain'].includes(value.cleanup))) {
    issues.push(`${path}.cleanup: choose delete-on-settlement, retain-on-failure, or retain`)
  }
  if (value.mode === 'read-only-snapshot' && writeRoots !== undefined && writeRoots.length > 0) {
    issues.push(`${path}.writeRoots: use an empty array for read-only-snapshot`)
  }
}

const collectEnvironmentDraftIssues = (
  environment: unknown,
  path: string,
  policy: GraphEnvironmentHostPolicy,
  issues: string[],
): void => {
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    issues.push(`${path}: provide an environment plan object`)
    return
  }
  const value = environment as Record<string, unknown>
  const allowedKeys = new Set(['requiredCapabilities', 'sandboxMode', 'operations'])
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) issues.push(`${path}.${key}: unknown environment field`)
  if (!policy.enabled) issues.push(`${path}: environment nodes are disabled by the deployment`)
  const capabilities = Array.isArray(value.requiredCapabilities) ? value.requiredCapabilities as readonly unknown[] : undefined
  if (capabilities === undefined || capabilities.length === 0
    || capabilities.some(capability => typeof capability !== 'string')
    || new Set(capabilities).size !== capabilities.length) {
    issues.push(`${path}.requiredCapabilities: provide unique network, host-package-install, or docker capabilities`)
  } else {
    const allowed = new Set(policy.capabilities)
    for (const [index, capability] of capabilities.entries()) {
      if (!['network', 'host-package-install', 'docker'].includes(capability as string)) {
        issues.push(`${path}.requiredCapabilities[${String(index)}]: choose network, host-package-install, or docker`)
      } else if (!allowed.has(capability as GraphEnvironmentCapability)) {
        issues.push(`${path}.requiredCapabilities[${String(index)}]: capability ${String(capability)} is disabled by the deployment`)
      }
    }
  }
  if (value.sandboxMode !== 'workspace-write' && value.sandboxMode !== 'danger-full-access') {
    issues.push(`${path}.sandboxMode: choose workspace-write or danger-full-access`)
  } else if (value.sandboxMode === 'danger-full-access' && !policy.dangerFullAccess) {
    issues.push(`${path}.sandboxMode: danger-full-access environment operations are disabled by the deployment`)
  }
  const operations = Array.isArray(value.operations) ? value.operations as readonly unknown[] : undefined
  if (operations === undefined || operations.length === 0 || operations.length > MAX_GRAPH_ENVIRONMENT_OPERATIONS) {
    issues.push(`${path}.operations: provide 1-${String(MAX_GRAPH_ENVIRONMENT_OPERATIONS)} exact operations`)
    return
  }
  const ids = new Set<string>()
  for (const [index, candidate] of operations.entries()) {
    const operationPath = `${path}.operations[${String(index)}]`
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      issues.push(`${operationPath}: provide an operation object`)
      continue
    }
    const operation = candidate as Record<string, unknown>
    const operationKeys = new Set(['id', 'description', 'command', 'rollbackCommand'])
    for (const key of Object.keys(operation)) if (!operationKeys.has(key)) issues.push(`${operationPath}.${key}: unknown operation field`)
    if (typeof operation.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operation.id)
      || ids.has(operation.id)) {
      issues.push(`${operationPath}.id: use a unique normalized safe id`)
    } else ids.add(operation.id)
    for (const field of ['description', 'command'] as const) {
      if (typeof operation[field] !== 'string' || operation[field].trim() !== operation[field]
        || operation[field].length === 0) issues.push(`${operationPath}.${field}: provide normalized non-empty text`)
    }
    if (operation.rollbackCommand !== undefined && (typeof operation.rollbackCommand !== 'string'
      || operation.rollbackCommand.trim() !== operation.rollbackCommand || operation.rollbackCommand.length === 0)) {
      issues.push(`${operationPath}.rollbackCommand: provide normalized non-empty text or omit it`)
    }
  }
  if (issues.some(issue => issue.startsWith(path))) return
  const approvalText = graphEnvironmentApprovalText(value as unknown as GraphEnvironmentPlan)
  if (new TextEncoder().encode(approvalText).byteLength > MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES) {
    issues.push(`${path}: approval text exceeds ${String(MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES)} bytes; split the change into smaller environment nodes`)
  }
}

const draftAdmissionIssues = (
  draft: GraphRevisionDraft,
  config: GraphModeConfig,
  environmentPolicy: GraphEnvironmentHostPolicy,
): string[] => {
  const issues: string[] = []
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  const normalized = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  const allowedKeys = new Set([
    'graphId', 'revision', 'objective', 'createdAt', 'parentRevision', 'userInput',
    'nodes', 'edges', 'branchGroups', 'terminationPolicy',
  ])
  for (const key of Object.keys(draft)) if (!allowedKeys.has(key)) issues.push(`${key}: unknown graph field`)
  if (!normalized(draft.graphId) || !safeId.test(draft.graphId)) issues.push('graphId: use a normalized safe id')
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 1) issues.push('revision: use a positive integer')
  if (draft.revision === 1 && draft.parentRevision !== undefined) issues.push('parentRevision: omit it for revision 1')
  if (draft.revision > 1 && draft.parentRevision !== draft.revision - 1) issues.push('parentRevision: use revision - 1')
  if (!normalized(draft.objective)) issues.push('objective: provide a normalized non-empty outcome')
  if (!normalized(draft.userInput)) issues.push('userInput: provide the represented human request')
  if (!Array.isArray(draft.nodes) || draft.nodes.length === 0) {
    issues.push('nodes: provide at least one task')
    return issues
  }
  if (draft.nodes.length > config.executionPolicy.maxNodesPerRevision) {
    issues.push(`nodes: exceeds the ${String(config.executionPolicy.maxNodesPerRevision)} node ceiling`)
  }
  const ids = new Set<string>()
  const enabledRoles = new Set<string>(
    config.roles.filter(role => role.enabled && !role.controller).map(role => role.id),
  )
  for (const [index, candidate] of (draft.nodes as unknown[]).entries()) {
    const path = `nodes[${String(index)}]`
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      issues.push(`${path}: provide a task object`)
      continue
    }
    const node = candidate as Record<string, unknown>
    if (!normalized(node.id) || !safeId.test(node.id)) issues.push(`${path}.id: use a normalized safe id`)
    else if (ids.has(node.id)) issues.push(`${path}.id: duplicate node id ${node.id}`)
    else ids.add(node.id)
    if (!normalized(node.title)) issues.push(`${path}.title: provide a normalized non-empty title`)
    if (!normalized(node.objective)) issues.push(`${path}.objective: provide a measurable outcome`)
    if (!normalized(node.roleId) || !enabledRoles.has(node.roleId)) {
      issues.push(`${path}.roleId: choose an enabled non-controller role`)
    }
    if (!Array.isArray(node.acceptanceCriteria) || node.acceptanceCriteria.length === 0
      || node.acceptanceCriteria.some((item: unknown) => !normalized(item))) issues.push(`${path}.acceptanceCriteria: provide normalized measurable criteria`)
    if (!normalized(node.effectPolicy) || !['idempotent', 'reconcile', 'manual'].includes(node.effectPolicy)) {
      issues.push(`${path}.effectPolicy: choose idempotent, reconcile, or manual`)
    }
    if ((node.kind === 'environment') !== (node.environment !== undefined)) {
      issues.push(`${path}.environment: exactly environment nodes require an environment plan`)
    }
    if (node.environment !== undefined) {
      collectEnvironmentDraftIssues(node.environment, `${path}.environment`, environmentPolicy, issues)
      if (node.effectPolicy !== 'manual') issues.push(`${path}.effectPolicy: environment nodes require manual`)
      if (node.maxAttempts !== undefined && node.maxAttempts !== 1) issues.push(`${path}.maxAttempts: environment nodes allow exactly one attempt`)
      if (node.workspace !== undefined && (node.workspace as Record<string, unknown>).mode !== 'shared') {
        issues.push(`${path}.workspace.mode: environment nodes require shared`)
      }
    }
    if (node.maxAttempts !== undefined && (!Number.isSafeInteger(node.maxAttempts)
      || typeof node.maxAttempts !== 'number' || node.maxAttempts < 1
      || node.maxAttempts > config.executionPolicy.maxAttemptsPerNode)) {
      issues.push(`${path}.maxAttempts: use a positive integer within the session ceiling`)
    }
    if (node.weight !== undefined
      && (typeof node.weight !== 'number' || !Number.isFinite(node.weight) || node.weight <= 0)) {
      issues.push(`${path}.weight: use a positive finite number`)
    }
    if (node.executionBudget !== undefined) {
      const budget = node.executionBudget as Record<string, unknown>
      const expected = ['maxOutputTokens', 'maxReasoningOnlyTokens', 'firstDurableActionMs', 'maxNoDurableProgressMs', 'checkpointIntervalMs', 'maxWallTimeMs', 'maxContinuations']
      if (Object.keys(budget).some(key => !expected.includes(key))
        || expected.some(key => !Number.isSafeInteger(budget[key]) || (budget[key] as number) < (key === 'maxContinuations' ? 0 : 1))) {
        issues.push(`${path}.executionBudget: provide positive integer limits and a non-negative maxContinuations`)
      }
    }
    if ((node.kind === 'review' || node.kind === 'verification') && node.outputSchema !== undefined) {
      const dataSchema = (node.outputSchema as GraphOutputSchema).schema.properties?.['data']
      if (dataSchema !== undefined && dataSchema.type !== undefined && dataSchema.type !== 'object') {
        issues.push(`${path}.outputSchema.schema.properties.data: review and verification nodes require an object data schema`)
      }
      if (dataSchema !== undefined && dataSchema.oneOf !== undefined) {
        issues.push(`${path}.outputSchema.schema.properties.data: review and verification nodes cannot replace the required control object with oneOf`)
      }
    }
    if (node.workspace !== undefined) collectWorkspaceDraftIssues(node.workspace, `${path}.workspace`, issues)
  }
  const edgeKeys = new Set<string>()
  for (const [index, edge] of (draft.edges ?? []).entries()) {
    const path = `edges[${String(index)}]`
    if (!ids.has(edge.from)) issues.push(`${path}.from: names an unknown node`)
    if (!ids.has(edge.to)) issues.push(`${path}.to: names an unknown node`)
    if (edge.from === edge.to) issues.push(`${path}: self dependencies are forbidden`)
    const key = `${edge.from}\u0000${edge.to}`
    if (edgeKeys.has(key)) issues.push(`${path}: duplicate dependency`)
    edgeKeys.add(key)
    if (edge.kind === 'conditional' && (edge.condition === undefined || edge.branchGroupId === undefined)) issues.push(`${path}: conditional dependencies require condition and branchGroupId`)
    if (edge.kind !== 'conditional' && (edge.condition !== undefined || edge.branchGroupId !== undefined)) issues.push(`${path}: only conditional dependencies carry condition or branchGroupId`)
  }
  const groupIds = new Set<string>()
  for (const [index, group] of (draft.branchGroups ?? []).entries()) {
    const path = `branchGroups[${String(index)}]`
    if (!normalized(group.id) || !safeId.test(group.id) || groupIds.has(group.id)) issues.push(`${path}.id: use a unique normalized safe id`)
    groupIds.add(group.id)
    if (!ids.has(group.to)) issues.push(`${path}.to: names an unknown node`)
  }
  return issues
}

const correctedSemanticPlan = (config: GraphModeConfig) => ({
  objective: 'Deliver the requested outcome',
  userInput: 'Original user request',
  nodes: [{
    id: 'implementation',
    title: 'Implement',
    objective: 'Produce the requested change',
    kind: 'implementation',
    roleId: config.roles.find(role => role.enabled && !role.controller)?.id ?? 'engineer',
    acceptanceCriteria: ['The requested behavior is verified'],
    workspace: { mode: 'isolated-copy', writeRoots: ['src'] },
    effectPolicy: 'idempotent',
  }],
})

const correctedDraftExample = (config: GraphModeConfig, draft: GraphRevisionDraft): string => {
  const revision = Number.isSafeInteger(draft.revision) && draft.revision > 0 ? draft.revision : 1
  return JSON.stringify({
    graphId: typeof draft.graphId === 'string' && draft.graphId.trim() === draft.graphId && draft.graphId.length > 0
      ? draft.graphId
      : 'feature-id',
    revision,
    ...(revision > 1 ? { parentRevision: revision - 1 } : {}),
    ...correctedSemanticPlan(config),
  })
}

const correctedControllerPlanExample = (config: GraphModeConfig): string => JSON.stringify(correctedSemanticPlan(config))

const resolveWorkspaceDraft = (workspace: GraphNodeWorkspaceDraft): GraphNodeWorkspacePolicy => {
  return {
    mode: workspace.mode,
    readRoots: workspace.readRoots ?? ['.'],
    writeRoots: workspace.writeRoots,
    cleanup: workspace.cleanup ?? (workspace.mode === 'shared' ? 'retain' : 'retain-on-failure'),
  }
}

const resolveGraphRevisionDraftWithCorrection = (
  draft: GraphRevisionDraft,
  config: GraphModeConfig,
  now: number,
  correction: string,
  environmentPolicy: GraphEnvironmentHostPolicy,
): GraphRevision => {
  validateGraphModeConfig(config)
  const admissionIssues = draftAdmissionIssues(draft, config, environmentPolicy)
  if (admissionIssues.length > 0) {
    throw new Error(`Graph draft rejected:\n${admissionIssues.map(issue => `- ${issue}`).join('\n')}\nCorrected minimal example: ${correction}`)
  }
  const graph: GraphRevision = {
    ...draft,
    createdAt: now,
    nodes: draft.nodes.map((node): GraphNode => {
      const { workspace, ...semanticNode } = node
      const resolvedNode = {
        ...semanticNode,
        outputSchema: resolvedOutputSchema(node, config.executionPolicy.maxOutputBytes),
        maxAttempts: node.kind === 'environment' ? 1 : node.maxAttempts ?? config.executionPolicy.maxAttemptsPerNode,
        weight: node.weight ?? 1,
        executionBudget: node.executionBudget ?? defaultGraphNodeExecutionBudget(config.executionPolicy),
        skippable: node.skippable ?? false,
      }
      if (node.kind === 'environment') {
        return {
          ...resolvedNode,
          workspace: { mode: 'shared', readRoots: ['.'], writeRoots: ['.'], cleanup: 'retain' },
        }
      }
      if (workspace === undefined) return resolvedNode
      return { ...resolvedNode, workspace: resolveWorkspaceDraft(workspace) }
    }),
    edges: draft.edges ?? [],
    branchGroups: draft.branchGroups ?? [],
    terminationPolicy: {
      ...config.executionPolicy,
      onExhausted: 'awaiting_user',
      ...draft.terminationPolicy,
    },
  }
  validateGraphRevision(graph, config)
  return graph
}

/**
 * Resolve a controller plan draft into the complete immutable revision stored in the session ledger.
 * @param draft semantic controller output with optional deployment-owned fields.
 * @param config frozen session configuration that owns execution defaults and ceilings.
 * @param now authoritative Host timestamp recorded for the accepted revision.
 * @param environmentPolicy deployment-authorized host effects available to environment nodes.
 * @returns complete validated graph revision detached from the input draft.
 * @throws Error when the draft or resolved revision violates Graph configuration.
 */
export function resolveGraphRevisionDraft(
  draft: GraphRevisionDraft,
  config: GraphModeConfig,
  now = Date.now(),
  environmentPolicy: GraphEnvironmentHostPolicy = DISABLED_ENVIRONMENT_POLICY,
): GraphRevision {
  return resolveGraphRevisionDraftWithCorrection(draft, config, now, correctedDraftExample(config, draft), environmentPolicy)
}

const HOST_OWNED_GRAPH_FIELDS = new Set([
  'graphId',
  'revision',
  'parentRevision',
  'parentRevisionNumber',
  'createdAt',
  'terminationPolicy',
  'changedNodeIds',
])

const isHostOwnedGraphField = (key: string): boolean => HOST_OWNED_GRAPH_FIELDS.has(key)
  || key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase() === 'graphid'

const allocateGraphId = (draft: GraphControllerPlanDraft, projection: GraphProjection): GraphId => {
  const objective = typeof draft.objective === 'string' ? draft.objective : ''
  const userInput = typeof draft.userInput === 'string' ? draft.userInput : ''
  const slug = objective.normalize('NFKD').toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 100)
    .replaceAll(/-+$/g, '')
  const digest = createHash('sha256').update(JSON.stringify([objective, userInput])).digest('hex').slice(0, 12)
  const base = `${slug.length > 0 ? slug : 'graph'}-${digest}`
  let candidate = base
  let duplicate = 2
  while (projection.graphs[candidate] !== undefined) {
    candidate = `${base}-${String(duplicate)}`
    duplicate += 1
  }
  return GraphId(candidate)
}

const allocateCampaignId = (plan: GraphCampaignPlanDraft, projection: GraphProjection): GraphCampaignId => {
  const slug = plan.objective.normalize('NFKD').toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 96)
    .replaceAll(/-+$/g, '')
  const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 12)
  const base = `${slug || 'campaign'}-${digest}`
  let candidate = base
  let duplicate = 2
  while (projection.campaigns[candidate] !== undefined) {
    candidate = `${base}-${String(duplicate)}`
    duplicate += 1
  }
  return GraphCampaignId(candidate)
}

const MUTATING_GRAPH_KINDS = new Set<GraphNode['kind']>(['environment', 'implementation', 'documentation', 'integration', 'specialist'])

const controllerWorkspaceIssues = (graph: GraphRevision): string[] => {
  const successors = new Map<GraphNodeId, GraphNodeId[]>()
  for (const edge of graph.edges) successors.set(edge.from, [...successors.get(edge.from) ?? [], edge.to])
  const reaches = (from: GraphNodeId, to: GraphNodeId, seen = new Set<GraphNodeId>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (successors.get(from) ?? []).some(next => reaches(next, to, seen))
  }
  const nodes = graph.nodes.filter(node => MUTATING_GRAPH_KINDS.has(node.kind))
  const missing = new Set<GraphNodeId>()
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
    const left = nodes[leftIndex] as GraphNode
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
      const right = nodes[rightIndex] as GraphNode
      if (reaches(left.id, right.id) || reaches(right.id, left.id)) continue
      if (left.workspace === undefined) missing.add(left.id)
      if (right.workspace === undefined) missing.add(right.id)
    }
  }
  return [...missing].map(id => `node ${JSON.stringify(id)}: concurrent mutating work requires an explicit workspace policy with precise relative writeRoots`)
}

const validateControllerWorkspaces = (graph: GraphRevision, correction: string): GraphRevision => {
  const issues = controllerWorkspaceIssues(graph)
  if (issues.length > 0) {
    throw new Error(`Graph draft rejected:\n${issues.map(issue => `- ${issue}`).join('\n')}\nCorrected minimal example: ${correction}`)
  }
  return graph
}

/**
 * Resolve a model-submitted semantic plan against the current session projection.
 * @param draft semantic tasks and dependencies; stale Host-owned fields are discarded.
 * @param intent whether the plan creates a graph or replaces the current graph revision.
 * @param projection authoritative session state used to assign graph and revision identity.
 * @param config frozen session configuration that owns execution defaults and ceilings.
 * @param now authoritative Host timestamp recorded for the accepted revision.
 * @param environmentPolicy deployment-authorized host effects available to environment nodes.
 * @returns complete validated graph revision ready for durable admission.
 * @throws Error when a revision has no current graph or the resolved plan violates Graph configuration.
 */
export function resolveGraphControllerPlanDraft(
  draft: GraphControllerPlanDraft,
  intent: 'new' | 'revise',
  projection: GraphProjection,
  config: GraphModeConfig,
  now = Date.now(),
  environmentPolicy: GraphEnvironmentHostPolicy = DISABLED_ENVIRONMENT_POLICY,
): GraphRevision {
  const semantic = Object.fromEntries(
    Object.entries(draft).filter(([key]) => !isHostOwnedGraphField(key)),
  ) as Omit<GraphRevisionDraft, 'graphId' | 'revision' | 'parentRevision' | 'createdAt' | 'terminationPolicy'>
  if (intent === 'new') {
    const complete = {
      ...semantic,
      graphId: allocateGraphId(draft, projection),
      revision: 1,
    }
    const correction = correctedControllerPlanExample(config)
    return validateControllerWorkspaces(resolveGraphRevisionDraftWithCorrection(
      complete, config, now, correction, environmentPolicy,
    ), correction)
  }
  const graphId = projection.currentGraphId
  const previous = graphId === undefined ? undefined : projection.graphs[graphId]?.at(-1)
  if (graphId === undefined || previous === undefined) {
    throw new Error('Graph draft rejected:\n- graph: revise requires a current graph; classify this input as new work')
  }
  const complete = {
    ...semantic,
    graphId,
    revision: previous.revision + 1,
    parentRevision: previous.revision,
  }
  const correction = correctedControllerPlanExample(config)
  return validateControllerWorkspaces(resolveGraphRevisionDraftWithCorrection(
    complete, config, now, correction, environmentPolicy,
  ), correction)
}

/** Controller tool request after model-schema decoding. */
export interface GraphSubmission {
  readonly intent: ControllerIntent
  readonly reason: string
  readonly graph?: GraphRevisionDraft
  readonly changedNodeIds?: readonly GraphNodeId[]
  readonly campaign?: GraphCampaignSubmissionDraft
  readonly lineage?: GraphRevisionLineageDraft
}

/** Controller-authored explanation used by the Host to create durable revision lineage. */
export interface GraphRevisionLineageDraft {
  readonly kind: GraphRevisionKind
  readonly title: string
  readonly trigger: {
    readonly source: GraphRevisionLineage['trigger']['source']
    readonly summary: string
    readonly runId?: string
    readonly nodeId?: string
    readonly errorCode?: string
    readonly evidence?: readonly string[]
  }
  readonly successCriteria?: readonly string[]
}

/** One controller-authored Batch definition in an initial plan or appended suffix. */
export interface GraphCampaignBatchDraft {
  readonly id: string
  readonly title: string
  readonly objective: string
  readonly dependsOn?: readonly string[]
}

/** Semantic campaign plan supplied with its first independent batch graph. */
export interface GraphCampaignPlanDraft {
  readonly objective: string
  readonly batches: readonly GraphCampaignBatchDraft[]
}

/** New ordered Batch suffix discovered after every registered Batch is accepted. */
export interface GraphCampaignPlanExtensionDraft {
  readonly batches: readonly GraphCampaignBatchDraft[]
}

/** Batch binding whose plan or planExtension is supplied only while admitting its first listed Batch. */
export interface GraphCampaignSubmissionDraft {
  readonly batchId: string
  readonly plan?: GraphCampaignPlanDraft
  readonly planExtension?: GraphCampaignPlanExtensionDraft
}

/** Stable human or controller operation over one durable graph run. */
export interface GraphControlRequest {
  readonly operationId: GraphControlOperationId
  readonly action: import('@deepseek-ai/dsh-graph').GraphControlRecord['action']
  readonly graphId: GraphId
  readonly runId: GraphRunId
  readonly expectedRevision: number
  readonly expectedGeneration: number
  readonly expectedAttemptId?: GraphAttemptId
  readonly reason: string
  readonly nodeId?: GraphNodeId
  readonly checkpointId?: GraphCheckpointId
  readonly targetRevision?: number
  readonly override?: GraphNodeExecutionOverride
  readonly output?: GraphNodeOutput
}

/** Host-authenticated identity and ingress retained with a graph control operation. */
export interface GraphControlAuthority {
  readonly actor: GraphControlActor
  readonly source: import('@deepseek-ai/dsh-graph').GraphControlRecord['source']
}

interface CapacityUse {
  global: number
  readonly roles: Map<string, number>
  readonly models: Map<string, { count: number; weight: number }>
}

interface AdmissionWaiter {
  readonly role: GraphRole
  readonly config: GraphModeConfig
  readonly weight: number
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  readonly abort: () => void
}

/** Fair admission controller for global, role, and exact-model limits. */
export class GraphAdmissionController {
  private readonly use: CapacityUse = { global: 0, roles: new Map(), models: new Map() }
  private readonly waiters: AdmissionWaiter[] = []

  /**
   * Wait until all configured limits admit a node.
   * @param role assigned role and its per-role cap.
   * @param config current scheduler settings.
   * @param weight node resource weight.
   * @param signal cancellation for this graph run.
   * @returns an idempotent permit release.
   */
  async acquire(role: GraphRole, config: GraphModeConfig, weight: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return await new Promise<() => void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal.reason instanceof Error ? signal.reason : new Error('graph admission canceled'))
        this.drain()
      }
      const waiter: AdmissionWaiter = { role, config, weight, signal, resolve, reject, abort }
      this.waiters.push(waiter)
      signal.addEventListener('abort', abort, { once: true })
      this.drain()
    })
  }

  private reserve(role: GraphRole, weight: number): () => void {
    const modelKey = this.modelKey(role)
    this.use.global++
    this.use.roles.set(role.id, (this.use.roles.get(role.id) ?? 0) + 1)
    const model = this.use.models.get(modelKey) ?? { count: 0, weight: 0 }
    this.use.models.set(modelKey, { count: model.count + 1, weight: model.weight + weight })
    let released = false
    return () => {
      if (released) return
      released = true
      this.use.global--
      this.use.roles.set(role.id, (this.use.roles.get(role.id) as number) - 1)
      const current = this.use.models.get(modelKey) as { count: number; weight: number }
      this.use.models.set(modelKey, { count: current.count - 1, weight: current.weight - weight })
      this.drain()
    }
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0] as AdmissionWaiter
      if (!this.canAdmit(waiter.role, waiter.config, waiter.weight)) return
      this.waiters.shift()
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(this.reserve(waiter.role, waiter.weight))
    }
  }

  private modelKey(role: GraphRole): string {
    return `${role.model.provider ?? ''}\u0000${role.model.model ?? ''}`
  }

  private canAdmit(role: GraphRole, config: GraphModeConfig, weight: number): boolean {
    const workerLimit = Math.min(
      config.limits.globalMaxParallel - config.limits.controllerReserve,
      graphActiveSubagentLimit(config),
    )
    if (this.use.global >= workerLimit || (this.use.roles.get(role.id) ?? 0) >= role.maxParallel) return false
    if (role.model.model === undefined) return true
    const limit = config.limits.models.find(item => item.model === role.model.model
      && (item.provider ?? '') === (role.model.provider ?? ''))
    if (limit === undefined) return true
    const used = this.use.models.get(this.modelKey(role)) ?? { count: 0, weight: 0 }
    return used.count < limit.maxParallel && (limit.maxWeight === undefined || used.weight + weight <= limit.maxWeight)
  }
}

const controllerPolicy = (
  projection: GraphProjection,
  environmentPolicy: GraphEnvironmentHostPolicy,
): string => {
  const controller = projection.config.roles.find(role => role.controller && role.enabled) as GraphRole
  const roles = projection.config.roles.filter(role => role.enabled && !role.controller).map(role => ({
    id: role.id,
    description: role.description,
    maxParallel: role.maxParallel,
  }))
  return `${controller.prompt}\n\nGraph Mode is active. You are the sole controller. For every HUMAN input, first classify it as new, revise, inspect, control, clarify, or direct. New work and revisions MUST call graph_submit exactly once; do not implement their nodes yourself. Submit the semantic plan only: never calculate or submit graph identifiers, revision numbers, parent revisions, timestamps, changed-node lists, termination policy, ordinary output schemas, ordinary node attempt/weight defaults, worker allocation ids, absolute workspace paths, or empty edge/branch-group lists. Graph Mode assigns a safe unused graph id for new work, binds a revision to the current graph, and derives immutable identity, lineage, and structural changes from session state. Create the smallest acyclic graph that preserves real dependencies. Assign only enabled roles, give every node measurable acceptance criteria and an explicit idempotent, reconcile, or manual effect policy. Never relax, reinterpret, or replace an explicit user requirement, locked baseline, or acceptance criterion; ask the user when it cannot be satisfied as written. Add a specialized versioned output schema only when conditions or downstream data require fields beyond the standard result. Combine conditional edges through named all, any, exactly-one, or activated branch groups. Use expansion or subgraph nodes only within the resolved termination policy. Before every revision, reconcile accepted evidence from earlier revisions with the current workspace. Preserve each still-valid accepted node's id, semantic definition, and incoming dependencies so Graph Mode can reuse it; change that node only when a new user requirement or recorded evidence invalidates its result. Never add a preserve, reconcile, or baseline-discovery task merely to rediscover accepted work. Plan only the missing delta and the verification needed to trust it. When one long objective naturally divides into ordered batches, submit the first batch as intent=new with campaign.plan and campaign.batchId, and set campaign.batchId exactly to campaign.plan.batches[0].id. That first batch graph contains only the first batch's nodes. A Campaign plan is an immutable prefix with audited suffix extensions. After [graph-batch-complete], start an already registered ready batch as another intent=new graph with campaign.batchId only and include only that batch's nodes. If accepted evidence reveals batches that are not registered, start the first new batch with campaign.batchId plus campaign.planExtension containing the complete newly discovered ordered suffix; omit campaign.plan. Graph Mode records the top-level reason and predecessor Run and Settlement evidence as the next plan revision. Never change, insert, reorder, or remove a registered batch. Revise only the active batch graph for repair, omit campaign from that revision, and consume predecessor settlement summaries from Campaign input instead of copying historical nodes. For broad software work, put architecture in a design node before implementation; Graph pauses after that design node and sends [graph-planning-checkpoint]. At that checkpoint, inspect actual architecture evidence, repository structure, toolchain prerequisites, each configured worker model, and its resolved node budget. Replace coarse implementation work with model-sized tasks when needed: each implementation node should represent roughly 10-30 minutes of focused work, own one cohesive module or behavior, have 2-4 independently verifiable acceptance criteria, declare real predecessor edges, and produce an independently verifiable artifact. Never hide environment mutation inside an implementation node. When a missing toolchain, host package, network fetch, or Docker operation is necessary, prefer project-local wrappers and existing services; add an environment node only for the remaining exact host commands, assign the environment role when available, set effectPolicy=manual, omit maxAttempts and workspace, and declare requiredCapabilities, the narrowest sandboxMode, exact ordered commands, descriptions, and documentary rollback commands. Environment commands require a human checkpoint before execution. A rollbackCommand is evidence only; executing it requires another approved environment node. Never put credential values, access tokens, passwords, or private keys in an environment command; refer only to Host-managed environment variables or credential references. Never create speculative environment mutations: use repository evidence or an earlier analysis/design checkpoint, and connect every dependent implementation after the environment node. Scope Docker commands to this project's named Compose project, containers, volumes, or labels; never use broad prune or unrelated deletion. Every implementation, documentation, integration, or specialist node that can run concurrently with another mutating node must declare a workspace policy with precise relative writeRoots; parallel roots must be disjoint. Inspect the repository before naming roots, and use its actual source-relative directory names rather than a path inferred from prose or an objective. Workspace roots are normalized source-relative paths: use "." for the whole workspace, never an empty string or an absolute path. Omit readRoots to inherit ["."] and omit cleanup to use the mode default. Feed accepted artifacts into a distinct integration node before review or final verification; artifact hash or source drift conflicts must return to you for a revised ownership plan, never be overwritten. For user-facing Web work or an explicit browser-test request, place a verification node after the integrated runnable build and assign the browser-tester role when available. Give it the exact target origin, critical flows, viewport and locale assumptions, and measurable DOM and visual assertions. Require page-snapshot interaction, screenshot evidence on an image-capable model route, and relevant console and failed-network inspection. Treat a reachable target supplied by the user as an existing test environment; do not add an environment node merely to restart it. If the target is unavailable, preserve that blocker instead of reporting a product failure. A stalled or non-retryable workspace checkpoint MUST revise the node's granularity, role, model, budget, or workspace ownership; never approve and redispatch the unchanged node. An environment approval checkpoint is different: report its exact commands and wait for human approval or rejection without revising or dispatching them. Ask the user only when the evidence leaves a material product choice. Never claim that an inspect or control classification performed a control action. Never continue an unchanged plan merely because the original graph exists. Inspection, control, clarification, and direct answers do not create a graph. A synthetic [graph-run-complete] message is evidence for your concise synthesis and does not require graph_submit; when it contains error JSON, preserve the exact code, node, and message in your explanation. Enabled environment policy: ${JSON.stringify(environmentPolicy)}. Enabled roles: ${JSON.stringify(roles)}. Current graph: ${projection.currentGraphId ?? 'none'}. Current campaign: ${projection.currentCampaignId === undefined ? 'none' : JSON.stringify(projection.campaigns[projection.currentCampaignId])}.`
}

const planningNodeDefinition = (node: GraphNode) => ({
  id: node.id,
  title: node.title,
  objective: node.objective,
  kind: node.kind,
  roleId: node.roleId,
  acceptanceCriteria: node.acceptanceCriteria,
  effectPolicy: node.effectPolicy,
  ...node.expansion === undefined ? {} : { expansion: node.expansion },
  ...node.subgraph === undefined ? {} : { subgraph: node.subgraph },
  ...node.environment === undefined ? {} : { environment: node.environment },
  ...node.workspace === undefined ? {} : { workspace: node.workspace },
})

const priorAcceptedPlanningEvidence = (
  projection: GraphProjection,
  graph: GraphRevision,
  current: GraphRun,
  pendingNodes: readonly GraphNode[],
) => {
  const priorRuns = Object.values(projection.runs)
    .filter(run => run.id !== current.id && run.graphId === graph.graphId && run.revision < graph.revision)
    .sort((left, right) => right.revision - left.revision || right.generation - left.generation || right.updatedAt - left.updatedAt)
  return pendingNodes.flatMap((currentNode) => {
    const acceptedRun = priorRuns.find((run) => {
      const state = run.nodes[currentNode.id]
      return state?.phase === 'succeeded' && state.output !== undefined
    })
    if (acceptedRun === undefined) return []
    const acceptedGraph = projection.graphs[graph.graphId]?.find(candidate => candidate.revision === acceptedRun.revision)
    const acceptedNode = acceptedGraph?.nodes.find(candidate => candidate.id === currentNode.id)
    const output = acceptedRun.nodes[currentNode.id]?.output
    if (acceptedGraph === undefined || acceptedNode === undefined || output === undefined) return []
    const acceptedIncomingEdges = acceptedGraph.edges.filter(edge => edge.to === currentNode.id)
    const acceptedBranchGroups = acceptedGraph.branchGroups.filter(group => group.to === currentNode.id)
    const currentIncomingEdges = graph.edges.filter(edge => edge.to === currentNode.id)
    const currentBranchGroups = graph.branchGroups.filter(group => group.to === currentNode.id)
    return [{
      nodeId: currentNode.id,
      acceptedRevision: acceptedRun.revision,
      acceptedRunId: acceptedRun.id,
      acceptedDefinition: planningNodeDefinition(acceptedNode),
      acceptedIncomingEdges,
      acceptedBranchGroups,
      currentDefinition: planningNodeDefinition(currentNode),
      definitionChanged: JSON.stringify(acceptedNode) !== JSON.stringify(currentNode),
      incomingDependenciesChanged: JSON.stringify(acceptedIncomingEdges) !== JSON.stringify(currentIncomingEdges)
        || JSON.stringify(acceptedBranchGroups) !== JSON.stringify(currentBranchGroups),
      output: { summary: output.summary, data: output.data, artifacts: output.artifacts },
    }]
  })
}

const conditionValue = (output: GraphNodeOutput | undefined, condition: GraphCondition): unknown => {
  let value: unknown = output?.data
  for (const part of condition.path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/**
 * Evaluate a deterministic graph condition against one predecessor output.
 * @param output published predecessor output, or absence when none exists.
 * @param condition structured path and comparison operation.
 * @returns whether the conditional dependency is active.
 */
export function evaluateGraphCondition(output: GraphNodeOutput | undefined, condition: GraphCondition): boolean {
  const value = conditionValue(output, condition)
  switch (condition.operator) {
    case 'exists': return value !== undefined
    case 'truthy': return Boolean(value)
    case 'equals': return Object.is(value, condition.value)
    case 'not-equals': return !Object.is(value, condition.value)
  }
}

/** Result of evaluating every conditional branch group targeting one node. */
export type GraphBranchDecision = 'active' | 'inactive' | 'ambiguous'

/**
 * Evaluate named branch groups from durable predecessor states.
 * @param graph immutable revision containing group definitions and members.
 * @param run current run snapshot whose predecessor outputs are authoritative.
 * @param target node whose incoming groups are evaluated.
 * @returns combined activation decision; every group must activate.
 */
export function evaluateGraphBranchGroups(
  graph: GraphRevision,
  run: GraphRun,
  target: GraphNodeId,
): GraphBranchDecision {
  for (const group of graph.branchGroups.filter(candidate => candidate.to === target)) {
    const members = graph.edges.filter(edge => edge.kind === 'conditional' && edge.branchGroupId === group.id)
    const considered = group.mode === 'activated'
      ? members.filter(edge => run.nodes[edge.from]?.phase === 'succeeded')
      : members
    const matches = considered.filter(edge => evaluateGraphCondition(
      run.nodes[edge.from]?.output,
      edge.condition as GraphCondition,
    )).length
    if (group.mode === 'exactly-one' && matches > 1) return 'ambiguous'
    const active = group.mode === 'all'
      ? matches === considered.length
      : group.mode === 'any'
        ? matches > 0
        : group.mode === 'exactly-one'
          ? matches === 1
          : considered.length > 0 && matches === considered.length
    if (!active) return 'inactive'
  }
  return 'active'
}

/**
 * Build the exact durable evidence behind one target's branch decision.
 * @param graph immutable Graph revision containing the branch groups.
 * @param run current durable run state containing predecessor outputs.
 * @param target node whose incoming conditional groups are evaluated.
 * @param evaluatedAt durable evaluation timestamp.
 * @returns branch decision and per-group evidence for the target node.
 */
export function evaluateGraphBranchEvidence(
  graph: GraphRevision,
  run: GraphRun,
  target: GraphNodeId,
  evaluatedAt = Date.now(),
): GraphBranchEvaluation {
  const groups = graph.branchGroups.filter(candidate => candidate.to === target).map((group) => {
    const allMembers = graph.edges.filter(edge => edge.kind === 'conditional' && edge.branchGroupId === group.id)
    const considered = group.mode === 'activated'
      ? allMembers.filter(edge => run.nodes[edge.from]?.phase === 'succeeded')
      : allMembers
    const members = considered.map((edge) => {
      const predecessor = run.nodes[edge.from] as GraphNodeRun
      return {
        from: edge.from,
        matched: evaluateGraphCondition(predecessor.output, edge.condition as GraphCondition),
        predecessorPhase: predecessor.phase,
      }
    })
    const matched = members.filter(member => member.matched).length
    const active = group.mode === 'all'
      ? matched === considered.length
      : group.mode === 'any'
        ? matched > 0
        : group.mode === 'exactly-one'
          ? matched === 1
          : considered.length > 0 && matched === considered.length
    return { id: group.id, mode: group.mode, matched, considered: considered.length, active, members }
  })
  const decision = groups.some(group => group.mode === 'exactly-one' && group.matched > 1)
    ? 'ambiguous'
    : groups.every(group => group.active) ? 'active' : 'inactive'
  return { evaluatedAt, decision, groups }
}

const directRevisionChanges = (previous: GraphRevision, next: GraphRevision, declared: readonly GraphNodeId[]): GraphNodeId[] => {
  const nextIds = new Set(next.nodes.map(node => node.id))
  const changed = new Set<GraphNodeId>(declared.filter(id => nextIds.has(id)))
  const priorNodes = new Map(previous.nodes.map(node => [node.id, node]))
  for (const node of next.nodes) {
    if (!isDeepStrictEqual(priorNodes.get(node.id), node)) changed.add(node.id)
    const priorIncoming = previous.edges.filter(edge => edge.to === node.id)
    const nextIncoming = next.edges.filter(edge => edge.to === node.id)
    if (!isDeepStrictEqual(priorIncoming, nextIncoming)) changed.add(node.id)
    const priorGroups = previous.branchGroups.filter(group => group.to === node.id)
    const nextGroups = next.branchGroups.filter(group => group.to === node.id)
    if (!isDeepStrictEqual(priorGroups, nextGroups)) changed.add(node.id)
  }
  if (!isDeepStrictEqual(previous.terminationPolicy, next.terminationPolicy)) {
    for (const node of next.nodes) changed.add(node.id)
  }
  const removed = new Set(previous.nodes.map(node => node.id).filter(id => !nextIds.has(id)))
  for (const edge of previous.edges) {
    if (removed.has(edge.from) && nextIds.has(edge.to)) changed.add(edge.to)
  }
  return [...changed]
}

const normalizedLineageText = (value: string, field: string): string => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized !== value || normalized.length > 4_000) {
    throw new Error(`revision lineage ${field} must be normalized and at most 4,000 characters`)
  }
  return normalized
}

const resolveRevisionLineage = (
  state: GraphProjection,
  submission: GraphSubmission,
  graph: GraphRevision,
  changedNodeIds: readonly GraphNodeId[],
  invalidatedNodeIds: readonly GraphNodeId[],
  previous: GraphRevision | undefined,
  previousRun: GraphRun | undefined,
  campaign: GraphCampaign | undefined,
  requestedAt: number,
): GraphRevisionLineage => {
  const checkpoint = previousRun === undefined ? undefined : Object.values(state.checkpoints)
    .filter(item => item.runId === previousRun.id)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  const control = previousRun === undefined ? undefined : Object.values(state.controls)
    .filter(item => item.runId === previousRun.id && ['modify-task', 'rollback', 'reject-checkpoint'].includes(item.action))
    .sort((left, right) => right.completedAt - left.completedAt)[0]
  const inferredSource: GraphRevisionLineage['trigger']['source'] = checkpoint?.kind === 'planning'
    ? 'planning_checkpoint'
    : checkpoint?.kind === 'repair' ? 'review_rejection'
      : control !== undefined ? 'human_control'
        : previousRun?.error !== undefined || ['failed', 'exhausted'].includes(previousRun?.phase ?? '')
          ? 'run_failure'
          : 'user'
  const inferredKind: GraphRevisionKind = submission.intent === 'new'
    ? 'new_task'
    : ['run_failure', 'review_rejection', 'recovery'].includes(inferredSource)
      ? 'execution_correction'
      : 'analysis_refactor'
  const kind = submission.lineage?.kind ?? inferredKind
  if ((submission.intent === 'new') !== (kind === 'new_task')) {
    throw new Error('new submissions require new_task lineage; revisions require analysis_refactor or execution_correction lineage')
  }
  const triggerSource = submission.lineage?.trigger.source ?? inferredSource
  const triggerRunId = submission.lineage?.trigger.runId === undefined
    ? previousRun?.id
    : GraphRunId(submission.lineage.trigger.runId)
  if (triggerRunId !== undefined && state.runs[triggerRunId] === undefined) {
    throw new Error(`revision lineage trigger names unknown run ${JSON.stringify(triggerRunId)}`)
  }
  const triggerNodeId = submission.lineage?.trigger.nodeId === undefined
    ? checkpoint?.nodeId
    : [...graph.nodes, ...(previous?.nodes ?? [])]
      .find(node => node.id === submission.lineage?.trigger.nodeId)?.id
  if (submission.lineage?.trigger.nodeId !== undefined && triggerNodeId === undefined) {
    throw new Error(`revision lineage trigger names unknown node ${JSON.stringify(submission.lineage.trigger.nodeId)}`)
  }
  const previousIds = new Set(previous?.nodes.map(node => node.id) ?? [])
  const nextIds = new Set(graph.nodes.map(node => node.id))
  const changed = new Set(changedNodeIds)
  const relationships: GraphRevisionLineage['relationships'][number][] = []
  if (previous !== undefined) {
    relationships.push({
      kind: kind === 'execution_correction' ? 'corrects' : 'refactors',
      graphId: previous.graphId,
      revision: previous.revision,
      reason: kind === 'execution_correction' ? 'Corrects the preceding execution revision.' : 'Refactors the preceding analyzed plan.',
    })
  }
  const batch = campaign?.batches.find(item => item.graphId === graph.graphId)
  for (const dependencyId of batch?.dependsOn ?? []) {
    const dependency = campaign?.batches.find(item => item.id === dependencyId)
    const execution = dependency?.executions.at(-1)
    if (execution === undefined) continue
    relationships.push({
      kind: 'depends_on', graphId: execution.graphId, revision: execution.revision,
      reason: `Depends on completed campaign batch ${dependency?.title ?? dependencyId}.`,
    })
  }
  const defaultEvidence = [checkpoint?.reason, previousRun?.error?.message, control?.reason]
    .filter((item): item is string => item !== undefined)
  const successCriteria = [...new Set(submission.lineage?.successCriteria
    ?? graph.nodes.flatMap(node => node.acceptanceCriteria))]
    .map((item, index) => normalizedLineageText(item, `successCriteria[${String(index)}]`))
  if (successCriteria.length === 0) throw new Error('revision lineage requires at least one success criterion')
  const triggerErrorCode = submission.lineage?.trigger.errorCode ?? previousRun?.error?.code
  return {
    version: 1,
    taskId: GraphTaskId(graph.graphId),
    kind,
    title: normalizedLineageText(submission.lineage?.title ?? graph.objective, 'title'),
    objective: graph.objective,
    reason: normalizedLineageText(submission.reason, 'reason'),
    creator: triggerSource === 'human_control' ? 'human_control' : triggerSource === 'recovery' ? 'recovery' : 'controller',
    createdAt: requestedAt,
    trigger: {
      source: triggerSource,
      summary: normalizedLineageText(submission.lineage?.trigger.summary ?? submission.reason, 'trigger.summary'),
      ...triggerRunId === undefined ? {} : { runId: triggerRunId },
      ...triggerNodeId === undefined ? {} : { nodeId: triggerNodeId },
      ...triggerErrorCode === undefined ? {} : { errorCode: triggerErrorCode },
      evidence: (submission.lineage?.trigger.evidence ?? defaultEvidence)
        .map((item, index) => normalizedLineageText(item, `trigger.evidence[${String(index)}]`)),
    },
    relationships,
    successCriteria,
    changes: {
      addedNodeIds: graph.nodes.filter(node => !previousIds.has(node.id)).map(node => node.id),
      changedNodeIds: graph.nodes.filter(node => previousIds.has(node.id) && changed.has(node.id)).map(node => node.id),
      removedNodeIds: previous?.nodes.filter(node => !nextIds.has(node.id)).map(node => node.id) ?? [],
      preservedNodeIds: graph.nodes.filter(node => previousIds.has(node.id) && !changed.has(node.id)).map(node => node.id),
      invalidatedNodeIds,
    },
  }
}

const outputOf = (value: unknown, node: GraphNode): GraphNodeOutput => {
  validateGraphNodeOutput(value, node.outputSchema)
  return value
}

interface GraphPauseRequest {
  readonly checkpoint: GraphCheckpoint
  readonly phase: 'paused' | 'awaiting_user' | 'exhausted'
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)

const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let current = value
  for (const part of path) {
    const record = objectRecord(current)
    if (record === undefined) return undefined
    current = record[part]
  }
  return current
}

const workspaceWriteRoots = (node: GraphNode, fallback: GraphWorkspaceMode): readonly string[] => {
  const mode = node.workspace?.mode ?? fallback
  if (mode !== 'shared') return []
  return node.workspace?.writeRoots ?? ['.']
}

const workspaceRootsOverlap = (left: string, right: string): boolean => (
  left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
)

const workspaceWritesConflict = (left: GraphNode, right: GraphNode, fallback: GraphWorkspaceMode): boolean => (
  workspaceWriteRoots(left, fallback).some(leftRoot => (
    workspaceWriteRoots(right, fallback).some(rightRoot => workspaceRootsOverlap(leftRoot, rightRoot))
  ))
)

const effectiveGraphRole = (
  role: GraphRole,
  override: GraphNodeExecutionOverride | undefined,
  agentOptions: Agent['options'],
): GraphRole => ({
  ...role,
  model: {
    ...role.model.provider === undefined && agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {},
    ...role.model.model === undefined && agentOptions.model !== undefined ? { model: agentOptions.model } : {},
    ...role.model.reasoningEffort === undefined && agentOptions.reasoningEffort !== undefined
      ? { reasoningEffort: agentOptions.reasoningEffort }
      : {},
    ...role.model,
    ...override?.model,
  },
})

const configuredModelLimit = (config: GraphModeConfig, role: GraphRole) => config.limits.models.find(limit => (
  limit.model === role.model.model && (limit.provider ?? '') === (role.model.provider ?? '')
))

const admittedModelParallelism = (config: GraphModeConfig, role: GraphRole, live?: GraphResourceSnapshot): number => {
  const configured = configuredModelLimit(config, role)
  return Math.min(
    role.maxParallel,
    config.limits.globalMaxParallel,
    configured?.maxParallel ?? config.limits.globalMaxParallel,
    live?.concurrencyLimit ?? config.limits.globalMaxParallel,
  )
}

const resolvedExecutionBudget = (
  budget: GraphNodeExecutionBudget,
  model: LlmResolvedModelInfo,
  live?: GraphResourceSnapshot,
): GraphNodeExecutionBudget => ({
  ...budget,
  maxOutputTokens: Math.min(
    budget.maxOutputTokens,
    model.defaultMaxTokens ?? budget.maxOutputTokens,
    live?.maxOutputTokens ?? budget.maxOutputTokens,
  ),
})

const executionModelProfile = (
  role: GraphRole,
  config: GraphModeConfig,
  model: LlmResolvedModelInfo,
  live?: GraphResourceSnapshot,
): GraphModelExecutionProfile => ({
  provider: model.provider,
  model: model.id,
  ...model.context?.contextWindow === undefined && live?.contextWindow === undefined
    ? {}
    : { contextWindow: Math.min(model.context?.contextWindow ?? Number.MAX_SAFE_INTEGER, live?.contextWindow ?? Number.MAX_SAFE_INTEGER) },
  ...model.defaultMaxTokens === undefined && live?.maxOutputTokens === undefined
    ? {}
    : { maxOutputTokens: Math.min(model.defaultMaxTokens ?? Number.MAX_SAFE_INTEGER, live?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER) },
  ...model.reasoning === undefined ? {} : { reasoningEfforts: model.reasoning.efforts.map(effort => String(effort.id)) },
  ...role.model.reasoningEffort === undefined ? {} : { selectedReasoningEffort: role.model.reasoningEffort },
  concurrencyLimit: admittedModelParallelism(config, role, live),
  ...configuredModelLimit(config, role)?.maxWeight === undefined && live?.weightLimit === undefined
    ? {}
    : { weightLimit: Math.min(configuredModelLimit(config, role)?.maxWeight ?? Number.MAX_VALUE, live?.weightLimit ?? Number.MAX_VALUE) },
  ...live?.memoryClass === undefined ? {} : { memoryClass: live.memoryClass },
  ...live?.availableDeviceBytes === undefined ? {} : { availableDeviceBytes: live.availableDeviceBytes },
})

function controllerFallbackModels(config: GraphModeConfig): readonly GraphControllerFallbackModel[] {
  const controller = config.roles.find(role => role.controller && role.enabled)
  return (config.controllerResilience?.fallbackModels ?? []).filter(route => (
    route.controller
    && (route.provider !== controller?.model.provider || route.model !== controller.model.model)
  ))
}

/** `ctx.graphMode`: owns graph configuration, controller submission, and background runs. */
export class GraphModeController extends Service {
  static inject = ['graphWorkers', 'llm', 'sessions', 'systemPrompt', 'tools']

  private readonly workerProvider: string
  private readonly workspaceMode: GraphWorkspaceMode
  private readonly resourceProvider: string | undefined
  private readonly coordinationHeartbeatMs: number
  private readonly schedulerProvider: string | undefined
  private readonly schedulerHeartbeatMs: number
  private readonly schedulerAuthorityFailures = new Map<GraphRunId, string>()
  private readonly externalOperationTimeoutMs: number
  private readonly recoveryScanIntervalMs: number
  private readonly environmentPolicy: GraphEnvironmentHostPolicy
  private readonly schedulerOwnerId = GraphSchedulerOwnerId(randomUUID())
  private templateSource: () => GraphTemplateSettings
  private readonly admission = new GraphAdmissionController()
  private readonly aborts = new Map<string, AbortController>()
  private readonly nodeAborts = new Map<string, AbortController>()
  private readonly workerRuns = new Map<string, GraphWorkerRun>()
  private readonly executions = new Map<string, Promise<void>>()
  private readonly activatingSubmissions = new Set<GraphSubmissionId>()
  private readonly recoveries = new Map<Agent, Promise<void>>()
  private readonly recoveryTimers = new Map<Agent, ReturnType<typeof setInterval>>()
  private readonly liveAgents = new Set<Agent>()
  private readonly pauseRequests = new Map<string, GraphCheckpoint>()
  private readonly toolDisposers = new Map<Agent, () => void>()
  private readonly controlLocks = new Map<string, Promise<void>>()
  private readonly controllerFallbacks = new WeakMap<Agent, { readonly turn: number; readonly index: number }>()
  private quiescence: Promise<void> | undefined
  private dependencyOwnsQuiescence = false

  /** Construct and install graph-mode controller surfaces. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphMode')
    this.workerProvider = config.workerProvider ?? 'local'
    this.workspaceMode = config.workspaceMode ?? 'shared'
    this.resourceProvider = config.resourceProvider
    this.coordinationHeartbeatMs = config.coordinationHeartbeatMs ?? 15_000
    this.schedulerProvider = config.schedulerProvider
    this.schedulerHeartbeatMs = config.schedulerHeartbeatMs ?? 5_000
    this.externalOperationTimeoutMs = config.externalOperationTimeoutMs ?? 60_000
    this.recoveryScanIntervalMs = config.recoveryScanIntervalMs ?? 15_000
    const capabilities = config.environmentCapabilities ?? ['network', 'host-package-install', 'docker']
    if (new Set(capabilities).size !== capabilities.length) {
      throw new Error('graph-mode environmentCapabilities must not contain duplicates')
    }
    this.environmentPolicy = {
      enabled: config.environmentEnabled ?? true,
      capabilities,
      dangerFullAccess: config.environmentDangerFullAccess ?? true,
    }
    const defaults = defaultGraphModeConfig()
    const templateDefaults = {
      roles: defaults.roles,
      limits: defaults.limits,
      executionPolicy: defaults.executionPolicy,
      controllerResilience: defaults.controllerResilience ?? defaultGraphControllerResiliencePolicy(),
    }
    this.templateSource = () => {
      const template = {
        roles: (config.roles?.get() as unknown as GraphTemplateSettings['roles'] | undefined) ?? templateDefaults.roles,
        limits: config.limits?.get() ?? templateDefaults.limits,
        executionPolicy: config.executionPolicy?.get() ?? templateDefaults.executionPolicy,
        controllerResilience: config.controllerResilience?.get() ?? templateDefaults.controllerResilience,
      }
      validateGraphModeConfig({ version: 2, active: false, ...template })
      return template
    }

    ctx.systemPrompt.section({
      name: 'graph:controller',
      order: 45,
      text: (context) => {
        if (context.agent === undefined) return ''
        const projection = this.state(context.agent)
        return projection.config.active ? controllerPolicy(projection, this.environmentPolicy) : ''
      },
    })
    ctx.systemPrompt.section({
      name: 'graph:capacity',
      order: 46,
      text: (context) => {
        if (context.agent === undefined) return ''
        const projection = this.state(context.agent)
        if (!projection.config.active) return ''
        const limit = graphActiveSubagentLimit(projection.config)
        return `Graph run-wide active subagent limit: ${String(limit)}. Split large objectives into dependency-ordered, model-sized Graph nodes. Every Graph Worker and all in-process descendants share this ceiling; never hide extra parallelism inside one node.`
      },
    })

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (context.agent === undefined) return assembled
      const projection = this.state(context.agent)
      if (!projection.config.active) return assembled
      const controller = projection.config.roles.find(role => role.controller && role.enabled) as GraphRole
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          ...controller.model.provider === undefined ? {} : { provider: controller.model.provider },
          ...controller.model.model === undefined ? {} : { model: controller.model.model },
        },
      }
    })

    ctx.on('agent/request', async ({ agent, turn }, next) => {
      const resolved = await next()
      const projection = this.state(agent)
      if (!projection.config.active) return resolved
      const controller = projection.config.roles.find(role => role.controller && role.enabled) as GraphRole
      const recovery = this.controllerFallbacks.get(agent)
      const fallback = recovery?.turn === turn
        ? controllerFallbackModels(projection.config)[recovery.index]
        : undefined
      if (recovery !== undefined && recovery.turn !== turn) this.controllerFallbacks.delete(agent)
      const selection = fallback ?? controller.model
      return {
        ...resolved,
        ...selection.provider === undefined ? {} : { provider: selection.provider },
        ...selection.model === undefined ? {} : { model: selection.model },
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      }
    })

    ctx.on('agent/request-error', async ({ agent, turn, failure, signal }, next) => {
      const downstream = await next()
      if (downstream?.kind === 'retry' || signal.aborted) return downstream
      const projection = this.state(agent)
      const policy = projection.config.controllerResilience
      if (!projection.config.active || policy?.enabled !== true
        || !policy.retryableFailureCodes.includes(failure.code)) return downstream
      const routes = controllerFallbackModels(projection.config)
      const current = this.controllerFallbacks.get(agent)
      const index = current?.turn === turn ? current.index + 1 : 0
      if (index >= routes.length || index >= policy.maxFallbackAttemptsPerTurn) return downstream
      const route = routes[index] as GraphControllerFallbackModel
      this.controllerFallbacks.set(agent, { turn, index })
      ctx.logger.warn(
        'dsh-graph-mode: controller request failed with %s; retrying turn %d through %s/%s',
        failure.code,
        turn,
        route.provider,
        route.model,
      )
      return { kind: 'retry' }
    })

    ctx.on('compaction/policy', async (agent, _trigger, next): Promise<CompactionRequestPolicy> => {
      const downstream = await next()
      const graphAgent = agent as Agent
      const projection = this.state(graphAgent)
      const resilience = projection.config.controllerResilience
      if (!projection.config.active || resilience?.compaction.enabled !== true) return downstream
      const controller = projection.config.roles.find(role => role.controller && role.enabled) as GraphRole
      const fallback = resilience.fallbackModels.find(route => route.compaction)
      const selected = fallback ?? (
        controller.model.provider !== undefined && controller.model.model !== undefined
          ? { provider: controller.model.provider, model: controller.model.model }
          : downstream.summarizationTarget
      )
      const reasoningEffort = fallback?.reasoningEffort ?? resilience.compaction.reasoningEffort
      const { retainTokens: _retainedTokens, ...retained } = downstream
      return {
        ...retained,
        thresholdRatio: resilience.compaction.thresholdRatio,
        retainRatio: resilience.compaction.retainRatio,
        maxTokens: resilience.compaction.maxTokens,
        summarizationTarget: {
          provider: selected.provider,
          model: selected.model,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
        },
      }
    })

    ctx.inject(['commands'], commandCtx => commandCtx.commands.register({
      name: 'graph',
      description: 'Enter or leave graph multi-agent mode',
      input: { hint: '[off|message]' },
      handler: async ({ agent, rawInput }) => {
        const input = rawInput.trim()
        const projection = this.state(agent)
        if (input.startsWith('control ')) {
          let control: unknown
          try {
            control = JSON.parse(input.slice('control '.length))
          } catch {
            return { kind: 'error', text: 'Graph control request must be valid JSON.' }
          }
          try {
            const record = await this.control(agent, control as GraphControlRequest, {
              actor: { kind: 'human', id: agent.id },
              source: 'command',
            })
            return { kind: 'success', text: `Graph control ${record.action} completed (${record.id}).` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        }
        if (input.startsWith('config ')) {
          let next: unknown
          try {
            next = JSON.parse(input.slice('config '.length))
          } catch {
            return { kind: 'error', text: 'Graph settings must be valid JSON.' }
          }
          try {
            this.setConfig(agent, next as GraphModeConfig)
            return { kind: 'success', text: 'Graph settings saved.' }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        }
        const active = input !== 'off'
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const hasSessionConfig = agent.session.snapshotEvents().some(event => event.type === 'graph/change' && event.data.kind === 'graph/config')
        const sessionConfig = hasSessionConfig
          ? projection.config
          : {
            version: 2 as const,
            active: false,
            roles: this.templateSource().roles,
            limits: this.templateSource().limits,
            executionPolicy: this.templateSource().executionPolicy,
            controllerResilience: this.templateSource().controllerResilience,
          }
        this.setConfig(agent, { ...sessionConfig, active })
        if (active && input !== '') {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
        }
        return { kind: 'success', text: active ? 'Graph mode on. Every new input is routed through the controller.' : 'Graph mode off.' }
      },
    }))

    ctx.on('agent/created', ({ agent }) => {
      this.liveAgents.add(agent)
      this.installRecoveryWatch(agent)
      if (!this.state(agent).config.active) return
      this.syncSubmitTool(agent, true)
      void this.recover(agent).catch((error: unknown) => {
        this.ctx.logger.error('dsh-graph-mode: recovery failed for agent %s: %o', agent.id, error)
      })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.liveAgents.delete(agent)
      this.clearRecoveryWatch(agent)
      this.syncSubmitTool(agent, false)
    })

    const installDependencyQuiescence = (dependency: 'graphCoordination' | 'graphResources' | 'graphScheduler' | 'graphArtifacts'): void => {
      ctx.inject([dependency], (scope) => {
        this.dependencyOwnsQuiescence = true
        scope.effect(() => async () => { await this.quiesce() }, `dsh-graph-mode: quiesce before ${dependency}`)
      })
    }
    installDependencyQuiescence('graphCoordination')
    installDependencyQuiescence('graphResources')
    installDependencyQuiescence('graphScheduler')
    installDependencyQuiescence('graphArtifacts')

    ctx.effect(() => async () => {
      for (const dispose of this.toolDisposers.values()) dispose()
      this.toolDisposers.clear()
      for (const timer of this.recoveryTimers.values()) clearInterval(timer)
      this.recoveryTimers.clear()
      this.liveAgents.clear()
      if (!this.dependencyOwnsQuiescence) await this.quiesce()
    }, 'dsh-graph-mode: quiesce background runs')
  }

  private async quiesce(): Promise<void> {
    if (this.quiescence !== undefined) {
      await this.quiescence
      return
    }
    this.quiescence = (async () => {
      const executions = [...this.executions.values()]
      for (const controller of this.aborts.values()) controller.abort(new Error('graph-mode plugin disposed'))
      await Promise.allSettled(executions)
      this.aborts.clear()
      this.executions.clear()
    })()
    await this.quiescence
  }

  private syncSubmitTool(agent: Agent, active: boolean): void {
    const existing = this.toolDisposers.get(agent)
    if (!active) {
      existing?.()
      this.toolDisposers.delete(agent)
      return
    }
    if (existing !== undefined) return
    const dispose = agent.ctx.tools.register(defineTool({
      name: 'graph_submit',
      description: 'Submit the controller classification for the current human input. New and revised work include one semantic graph plan; Graph Mode resolves graph identity, revision lineage, changed nodes, timestamps, standard output schemas, ordinary node scheduling defaults, empty edge/group lists, and termination limits from current session state.',
      parameters: {
        intent: { type: 'string', required: true, enum: ['new', 'revise', 'inspect', 'control', 'clarify', 'direct'] },
        reason: { type: 'string', required: true, description: 'Concise rationale shown in the audit trail.' },
        lineage: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional explicit revision classification and trigger evidence. The Host validates and completes relationships and structural changes.',
          properties: {
            kind: { type: 'string', required: true, enum: ['new_task', 'analysis_refactor', 'execution_correction'] },
            title: { type: 'string', required: true },
            trigger: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true, enum: ['user', 'planning_checkpoint', 'run_failure', 'review_rejection', 'human_control', 'recovery'] },
                summary: { type: 'string', required: true },
                runId: { type: 'string' },
                nodeId: { type: 'string' },
                errorCode: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
              },
            },
            successCriteria: { type: 'array', items: { type: 'string' } },
          },
        },
        graph: {
          ...graphRevisionToolSchema,
          description: 'Semantic graph plan for new or revised work. Supply tasks, real dependencies, role assignments, acceptance criteria, and effect policies. Graph Mode owns graph identity, revision lineage, and policy fields.',
        },
        campaign: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional independent-batch campaign binding. Include plan for the first registered batch, batchId only for an existing ready batch, or planExtension when accepted evidence discovers a new ordered suffix. Existing batches are immutable.',
          properties: {
            batchId: {
              type: 'string',
              description: 'Exactly the first batch in plan or planExtension, or an existing ready batch id when both are omitted.',
              required: true,
            },
            plan: {
              type: 'object',
              additionalProperties: false,
              description: 'Immutable ordered campaign plan supplied only while starting its first listed batch.',
              properties: {
                objective: { type: 'string', required: true },
                batches: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      objective: { type: 'string', required: true },
                      dependsOn: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
            planExtension: {
              type: 'object',
              additionalProperties: false,
              description: 'Ordered Batch suffix appended after all currently registered batches are accepted. The Host records the top-level reason and predecessor Run/Settlement evidence as the next plan revision.',
              properties: {
                batches: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      objective: { type: 'string', required: true },
                      dependsOn: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', const: true, required: true },
            intent: { type: 'string', required: true },
            graphId: { type: 'string' },
            runId: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.runId === undefined
            ? `Controller classification accepted: ${value.intent}.`
            : `Graph ${value.graphId as string} accepted; graph run ${value.runId} started. This graph run is not a JobRuntime job; wait for the [graph-run-complete] message and do not pass its id to job_output.`,
        }],
      },
      execute: async (args, exec) => {
        const caller = exec.agent as Agent
        const submission = {
          intent: args.intent,
          reason: args.reason,
          ...args.graph === undefined ? {} : { graph: args.graph as unknown as GraphControllerPlanDraft },
          ...args.campaign === undefined ? {} : { campaign: args.campaign as unknown as GraphCampaignSubmissionDraft },
          ...args.lineage === undefined ? {} : { lineage: args.lineage as unknown as GraphRevisionLineageDraft },
        }
        if (submission.intent !== 'new' && submission.intent !== 'revise') {
          return await this.submit(caller, { intent: submission.intent, reason: submission.reason }, exec.signal)
        }
        const projection = this.state(caller)
        const graph = submission.graph === undefined
          ? undefined
          : resolveGraphControllerPlanDraft(
            submission.graph,
            submission.intent,
            projection,
            projection.config,
            Date.now(),
            this.environmentPolicy,
          )
        return await this.submit(caller, {
          intent: submission.intent,
          reason: submission.reason,
          ...graph === undefined ? {} : { graph },
          ...submission.campaign === undefined ? {} : { campaign: submission.campaign },
          ...submission.lineage === undefined ? {} : { lineage: submission.lineage },
        }, exec.signal)
      },
    }))
    this.toolDisposers.set(agent, dispose)
  }

  /**
   * Return replayed state for one live agent.
   * @param agent session owner whose graph events are folded.
   * @returns current graph-mode projection.
   */
  state(agent: Agent): GraphProjection {
    return this.ctx.get('sessionProjections')?.stateOf(agent.session, 'graph')
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      ?? foldGraph(agent.session.snapshotEvents())
  }

  private clearRecoveryWatch(agent: Agent): void {
    const timer = this.recoveryTimers.get(agent)
    if (timer !== undefined) clearInterval(timer)
    this.recoveryTimers.delete(agent)
  }

  private installRecoveryWatch(agent: Agent): void {
    this.clearRecoveryWatch(agent)
    const inspect = (): void => {
      try {
        if (!this.liveAgents.has(agent)) return
        const projection = this.state(agent)
        const pendingSubmission = Object.values(projection.submissions).some(item => item.outcome === 'pending')
        const orphanRun = Object.values(projection.runs).some(run => (
          ['queued', 'running'].includes(run.phase) && !this.executions.has(run.id)
        ))
        if (!pendingSubmission && !orphanRun) return
        void this.recover(agent).catch((error: unknown) => {
          this.ctx.logger.warn('dsh-graph-mode: recovery scan failed for agent %s: %o', agent.id, error)
        })
      } catch (error) {
        this.ctx.logger.error('dsh-graph-mode: recovery scan could not read agent %s: %o', agent.id, error)
      }
    }
    const timer = setInterval(inspect, this.recoveryScanIntervalMs)
    timer.unref()
    this.recoveryTimers.set(agent, timer)
  }

  private trackExecution(runId: GraphRunId, execution: Promise<void>): Promise<void> {
    const tracked = execution.catch((error: unknown) => {
      this.ctx.logger.error('dsh-graph-mode: execution failed for run %s: %o', runId, error)
    }).finally(() => {
      if (this.executions.get(runId) !== tracked) return
      this.aborts.delete(runId)
      this.executions.delete(runId)
    })
    this.executions.set(runId, tracked)
    return tracked
  }

  private externalOperationSignal(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.externalOperationTimeoutMs)
    return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  }

  private async waitForExternal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(errorMessage(signal.reason))
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        operation.catch(() => {
          // The provider owns the abandoned operation; the abort reason is authoritative here.
        })
        reject(signal.reason instanceof Error ? signal.reason : new Error(errorMessage(signal.reason)))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      operation.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error instanceof Error ? error : new Error(errorMessage(error)))
        },
      )
    })
  }

  private async flushBeforeExternal(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.ctx.sessions.flush(agent.session)
    signal.throwIfAborted()
  }

  private async flushCleanupIntent(agent: Agent, context: string): Promise<boolean> {
    try {
      await this.flushBeforeExternal(agent, this.externalOperationSignal())
      return true
    } catch (error) {
      this.ctx.logger.warn('dsh-graph-mode: durability flush failed before cleanup for %s: %o', context, error)
      return false
    }
  }

  private async acquireSchedulerLease(agent: Agent, run: GraphRun, signal: AbortSignal): Promise<GraphSchedulerDecision | undefined> {
    if (this.schedulerProvider === undefined) return undefined
    const scheduler = this.ctx.get('graphScheduler')
    if (scheduler === undefined) throw new Error(`Graph scheduler Provider ${this.schedulerProvider} is configured but the Service Definition is unavailable`)
    await this.flushBeforeExternal(agent, signal)
    return await this.waitForExternal(scheduler.acquire(this.schedulerProvider, {
      protocolVersion: 1,
      sessionId: agent.id,
      runId: run.id,
      generationId: run.generationId,
      ownerId: this.schedulerOwnerId,
      minimumOwnerEpoch: run.ownerEpoch,
      requestedAt: Date.now(),
    }, signal), signal)
  }

  private schedulerLeaseRequest(lease: GraphSchedulerLease): GraphSchedulerLeaseRequest {
    return {
      protocolVersion: 1,
      providerId: lease.providerId,
      leaseId: lease.id,
      runId: lease.runId,
      generationId: lease.generationId,
      ownerId: lease.ownerId,
      ownerEpoch: lease.ownerEpoch,
      fencingToken: lease.fencingToken,
      at: Date.now(),
    }
  }

  private async releaseSchedulerLease(agent: Agent, lease: GraphSchedulerLease, context: string): Promise<void> {
    const scheduler = this.ctx.get('graphScheduler')
    if (scheduler === undefined) {
      this.ctx.logger.warn('dsh-graph-mode: graph scheduler disappeared before releasing the lease for %s', context)
      return
    }
    let flushFailure: unknown
    try {
      await this.flushBeforeExternal(agent, this.externalOperationSignal())
    } catch (error) {
      flushFailure = error
      this.ctx.logger.warn('dsh-graph-mode: durability flush failed before scheduler lease release for %s: %o', context, error)
    }
    try {
      const signal = this.externalOperationSignal()
      await this.waitForExternal(scheduler.release(this.schedulerLeaseRequest(lease), signal), signal)
    } catch (error) {
      this.ctx.logger.warn('dsh-graph-mode: scheduler lease release failed for %s: %o', context, error)
      return
    }
    if (flushFailure !== undefined) {
      this.ctx.logger.warn('dsh-graph-mode: scheduler lease for %s was released without a completed durability flush', context)
    }
  }

  private async ownRun(
    agent: Agent,
    run: GraphRun,
    signal: AbortSignal,
  ): Promise<{ readonly run: GraphRun; readonly lease?: GraphSchedulerLease }> {
    const ownership = await this.acquireSchedulerLease(agent, run, signal)
    if (ownership?.status === 'busy') {
      throw new Error(`Graph run ${run.id} is owned by another scheduler until ${new Date(ownership.retryAt).toISOString()}: ${ownership.evidence}`)
    }
    const lease = ownership?.lease
    return {
      run: lease === undefined ? run : { ...run, ownerEpoch: lease.ownerEpoch },
      ...lease === undefined ? {} : { lease },
    }
  }

  private async driveOwned(
    agent: Agent,
    graph: GraphRevision,
    run: GraphRun,
    config: GraphModeConfig,
    signal: AbortSignal,
    lease?: GraphSchedulerLease,
    ancestry?: readonly GraphId[],
    runtimeInput?: Readonly<Record<string, unknown>>,
    notify = true,
  ): Promise<void> {
    if (lease === undefined) {
      await this.drive(agent, graph, run, config, signal, ancestry, runtimeInput, notify)
      return
    }
    const scheduler = this.ctx.get('graphScheduler')
    if (scheduler === undefined) throw new Error('graph scheduler disappeared while a run lease was active')
    const heartbeatStop = new AbortController()
    const heartbeatFailure = new AbortController()
    let live = lease
    const heartbeat = (async (): Promise<void> => {
      let lastFailureDetail = 'heartbeat deadline elapsed before renewal'
      while (!heartbeatStop.signal.aborted) {
        const remaining = live.expiresAt - Date.now()
        if (remaining <= 0) {
          const failure = new GraphSchedulerAuthorityError(`scheduler lease expired; ${lastFailureDetail}`.slice(0, 2_000))
          this.schedulerAuthorityFailures.set(run.id, failure.message)
          heartbeatFailure.abort(failure)
          return
        }
        const untilRenewal = Math.max(100, Math.floor(remaining / 3))
        if (!await waitForHeartbeat(Math.min(this.schedulerHeartbeatMs, untilRenewal), heartbeatStop.signal)) return
        try {
          const operationSignal = this.externalOperationSignal(heartbeatStop.signal)
          live = await this.waitForExternal(scheduler.heartbeat(this.schedulerLeaseRequest(live), operationSignal), operationSignal)
          lastFailureDetail = 'heartbeat deadline elapsed before renewal'
        } catch (error) {
          if (heartbeatStop.signal.reason !== undefined) return
          lastFailureDetail = `last heartbeat failure: ${errorMessage(error)}`.slice(0, 1_900)
          if (error instanceof GraphSchedulerAuthorityError) {
            this.schedulerAuthorityFailures.set(run.id, error.message.slice(0, 2_000))
            heartbeatFailure.abort(error)
            return
          }
          this.ctx.logger.warn(
            'dsh-graph-mode: scheduler heartbeat failed for run %s; retrying before lease expiry %s: %o',
            run.id,
            new Date(live.expiresAt).toISOString(),
            error,
          )
        }
      }
    })().catch((error: unknown) => {
      if (!heartbeatStop.signal.aborted) {
        this.schedulerAuthorityFailures.set(run.id, errorMessage(error).slice(0, 2_000))
        heartbeatFailure.abort(error)
      }
    })
    try {
      await this.drive(
        agent, graph, run, config, AbortSignal.any([signal, heartbeatFailure.signal]),
        ancestry, runtimeInput, notify, heartbeatFailure.signal,
      )
    } finally {
      heartbeatStop.abort()
      await heartbeat
      await this.releaseSchedulerLease(agent, live, `run ${run.id}`)
    }
  }

  /** Start or resume one retryable external settlement under its stable identity. */
  private beginSettlement(
    agent: Agent,
    base: Omit<GraphSettlementRecord, 'version' | 'attempt' | 'outcome' | 'requestedAt' | 'completedAt' | 'evidence' | 'error'>,
  ): GraphSettlementRecord | undefined {
    const previous = this.state(agent).settlements[base.id]?.at(-1)
    if (previous?.outcome === 'confirmed') return undefined
    if (previous?.outcome === 'pending') return previous
    const pending: GraphSettlementRecord = {
      version: 2,
      ...base,
      attempt: (previous?.attempt ?? 0) + 1,
      outcome: 'pending',
      requestedAt: Date.now(),
    }
    agent.session.append('graph/settlement', pending)
    return pending
  }

  private async resumePendingSubmission(agent: Agent, pending: GraphRevisionSubmissionRecord): Promise<void> {
    if (this.activatingSubmissions.has(pending.id)) return
    this.activatingSubmissions.add(pending.id)
    try {
      const current = this.state(agent).submissions[pending.id]
      if (current?.outcome !== 'pending' || this.state(agent).runs[pending.run.id] !== undefined
        || this.executions.has(pending.run.id)) return
      if (agent.session.header.cwd === undefined) throw new Error('Graph execution requires a session working directory')
      const ownership = await this.ownRun(agent, pending.run, this.externalOperationSignal())
      let handedOff = false
      try {
        const coordination = this.ctx.get('graphCoordination')
        if (coordination !== undefined) {
          await coordination.prepare(
            pending.graph,
            pending.run.configSnapshot.roles,
            agent.session.header.cwd,
            this.externalOperationSignal(),
          )
        }
        agent.session.append('graph/change', {
          kind: 'graph/revision', version: 2, graph: pending.graph, current: true,
        })
        if (pending.intent === 'revise') {
          for (const checkpoint of Object.values(this.state(agent).checkpoints)) {
            if (checkpoint.graphId !== pending.graph.graphId
              || checkpoint.revision !== pending.graph.revision - 1
              || checkpoint.status !== 'pending') continue
            agent.session.append('graph/checkpoint', {
              ...checkpoint,
              status: 'resolved',
              resolvedAt: Date.now(),
              replacementRevision: pending.graph.revision,
            })
          }
        }
        const run = ownership.run
        agent.session.append('graph/run', run)
        for (const node of pending.graph.nodes) {
          const nodeRun = run.nodes[node.id] as GraphNodeRun
          if (nodeRun.reusedFrom === undefined) this.appendOperation(agent, run, node, 'planned')
        }
        if (pending.campaign !== undefined) agent.session.append('graph/campaign', pending.campaign)
        agent.session.append('graph/submission', { ...pending, outcome: 'accepted', completedAt: Date.now() })
        await this.flushBeforeExternal(agent, this.externalOperationSignal())
        const controller = new AbortController()
        this.aborts.set(run.id, controller)
        const execution = this.driveOwned(
          agent,
          pending.graph,
          run,
          run.configSnapshot,
          controller.signal,
          ownership.lease,
        )
        void this.trackExecution(run.id, execution)
        handedOff = true
      } finally {
        if (!handedOff && ownership.lease !== undefined) {
          await this.releaseSchedulerLease(agent, ownership.lease, `pending submission ${pending.id}`)
        }
      }
    } finally {
      this.activatingSubmissions.delete(pending.id)
    }
  }

  /**
   * Reconcile and resume durable nonterminal work after an Agent is restored.
   * @param agent restored session owner whose nonterminal runs are recovered.
   * @param requestedRunId optional exact run selected for manual reconciliation.
   */
  async recover(agent: Agent, requestedRunId?: GraphRunId): Promise<void> {
    const previous = this.recoveries.get(agent) ?? Promise.resolve()
    const current = previous.catch(() => {
      // A later recovery request is independent and must still inspect durable state.
    }).then(async () => { await this.recoverDurable(agent, requestedRunId) })
    this.recoveries.set(agent, current)
    try {
      await current
    } finally {
      if (this.recoveries.get(agent) === current) this.recoveries.delete(agent)
    }
  }

  /** Resolve one coherent external execution identity instead of mixing references from several generations. */
  private recoverySource(projection: GraphProjection, run: GraphRun, nodeRun: GraphNodeRun): GraphRecoverySource {
    const journal = (projection.operations[nodeRun.workId] ?? [])
      .filter(item => item.runId === run.id && item.nodeId === nodeRun.nodeId)
    const current = journal.filter(item => item.generationId === run.generationId)
    if (current.some(item => item.externalReferences.length > 0)
      || !current.some(item => item.stage === 'reconciled')) {
      return { run, transitions: current, inherited: false }
    }
    const candidate = [...journal]
      .reverse()
      .find(item => item.generationId !== run.generationId && item.externalReferences.length > 0)
    if (candidate === undefined) return { run, transitions: current, inherited: false }
    const transitions = journal.filter(item => item.generationId === candidate.generationId)
    return {
      run: { ...run, generationId: candidate.generationId, ownerEpoch: candidate.ownerEpoch },
      transitions,
      inherited: true,
    }
  }

  /** Recognize an expired continuation of Graph's claim without accepting a replaced or stale identity. */
  private recoverableExpiredClaim(
    observation: GraphCoordinationObservation,
    claim: GraphExternalReference | undefined,
    lease: GraphExternalReference | undefined,
  ): boolean {
    const current = observation.claim
    if (observation.status !== 'unknown' || current === undefined || claim === undefined
      || lease?.fencingToken === undefined || current.expiresAt > Date.now()) return false
    return current.claimId === claim.id && current.fencingToken >= lease.fencingToken
      && (current.fencingToken > lease.fencingToken || current.leaseId === lease.id)
  }

  /** Recheck a recovery-created checkpoint before the background scanner starts another generation. */
  private async automaticallyRecoverableCheckpoint(
    agent: Agent,
    projection: GraphProjection,
    run: GraphRun,
    graph: GraphRevision,
    coordination: GraphCoordination | undefined,
  ): Promise<boolean> {
    if (run.phase !== 'awaiting_user' || coordination === undefined || agent.session.header.cwd === undefined) return false
    let found = false
    for (const node of graph.nodes) {
      const nodeRun = run.nodes[node.id]
      if (nodeRun === undefined || terminalNodePhase(nodeRun.phase)) continue
      const source = this.recoverySource(projection, run, nodeRun)
      if (!source.inherited || node.effectPolicy !== 'idempotent') return false
      found = true
      const references = source.transitions.flatMap(item => item.externalReferences)
      const claim = [...references].reverse().find(item => item.provider === 'graph-coordination')
      const lease = [...references].reverse().find(item => item.provider === 'graph-coordination-lease')
      const result = await coordination.reconcile({
        protocolVersion: 3,
        workId: nodeRun.workId,
        activationId: activationIdOf(nodeRun.workId, source.run.generationId),
        cwd: agent.session.header.cwd,
        callerId: agent.id,
        ...claim === undefined ? {} : { claimId: claim.id },
        ...lease === undefined ? {} : { leaseId: lease.id, fencingToken: lease.fencingToken },
      }, this.externalOperationSignal())
      if (result.status !== 'absent' && result.status !== 'confirmed-running'
        && !this.recoverableExpiredClaim(result.observation, claim, lease)) return false
    }
    return found
  }

  private async recoverDurable(agent: Agent, requestedRunId?: GraphRunId): Promise<void> {
    const initialProjection = this.state(agent)
    for (const pending of Object.values(initialProjection.submissions)
      .filter(item => item.outcome === 'pending')
      .sort((left, right) => left.requestedAt - right.requestedAt)) {
      try {
        await this.resumePendingSubmission(agent, pending)
      } catch (error) {
        this.ctx.logger.warn('dsh-graph-mode: pending submission %s remains recoverable: %o', pending.id, error)
      }
    }
    const projection = this.state(agent)
    const coordination = this.ctx.get('graphCoordination')
    for (const prior of Object.values(projection.runs)) {
      const targeted = requestedRunId === prior.id
      if ((requestedRunId !== undefined && !targeted) || this.executions.has(prior.id)) continue
      const graph = projection.graphs[prior.graphId]?.find(item => item.revision === prior.revision)
      if (graph === undefined) throw new Error(`cannot recover graph run ${prior.id}: revision is missing`)
      const automaticCheckpoint = !targeted
        && await this.automaticallyRecoverableCheckpoint(agent, projection, prior, graph, coordination)
      const recoverablePhase = ['queued', 'running'].includes(prior.phase)
        || automaticCheckpoint
        || (targeted && ['paused', 'awaiting_user'].includes(prior.phase))
      if (!recoverablePhase) continue
      const generation = prior.generation + 1
      const generationId = generationIdOf(agent, graph, generation)
      const ownership = await this.acquireSchedulerLease(agent, {
        ...prior,
        generation,
        generationId,
        ownerEpoch: prior.ownerEpoch + 1,
      }, this.externalOperationSignal())
      if (ownership?.status === 'busy') {
        this.ctx.logger.info('dsh-graph-mode: run %s remains owned elsewhere until %s', prior.id, new Date(ownership.retryAt).toISOString())
        continue
      }
      const schedulerLease = ownership?.lease
      const ownerEpoch = schedulerLease?.ownerEpoch ?? prior.ownerEpoch + 1
      try {
        const nodes: Record<string, GraphNodeRun> = {}
        const decisions = new Map<GraphNodeId, string>()
        const authorityFailure = this.schedulerAuthorityFailures.get(prior.id)
        for (const node of graph.nodes) {
          const previous = prior.nodes[node.id] as GraphNodeRun
          if (terminalNodePhase(previous.phase)) {
            nodes[node.id] = previous
            continue
          }
          const source = this.recoverySource(projection, prior, previous)
          const references = source.transitions.flatMap(item => item.externalReferences)
          const claim = [...references].reverse().find(reference => reference.provider === 'graph-coordination')
          const lease = [...references].reverse().find(reference => reference.provider === 'graph-coordination-lease')
          const resource = [...references].reverse().find(reference => reference.kind === 'model')
          const worker = [...references].reverse().find(reference => reference.kind === 'worker')
          const workspace = [...references].reverse().find(reference => reference.kind === 'workspace')
          if (previous.output !== undefined) {
            try {
              const priorSettlements = Object.values(projection.settlements).flat().filter(item => item.workId === previous.workId)
              if (resource !== undefined && !priorSettlements.some(item => item.kind === 'resource-release' && item.outcome === 'confirmed')) {
                const resources = this.ctx.get('graphResources')
                if (resources === undefined || resource.fencingToken === undefined) throw new Error('staged output has an unrecoverable model reservation')
                const settlementId = settlementIdOf(previous.workId, prior.generationId, source.inherited
                  ? `resource-release:${source.run.generationId}:${resource.id}`
                  : `resource-release:${resource.id}`)
                const settlementBase = this.beginSettlement(agent, {
                  id: settlementId,
                  operationId: operationIdOf(previous.workId, prior.generationId), workId: previous.workId,
                  runId: prior.id, generationId: prior.generationId, ownerEpoch: prior.ownerEpoch,
                  kind: 'resource-release' as const, externalReference: resource,
                })
                if (settlementBase === undefined) throw new Error('resource settlement became confirmed during recovery')
                await this.flushBeforeExternal(agent, this.externalOperationSignal())
                await resources.report({
                  reservationId: resource.id as GraphResourceReservation['id'], providerId: resource.provider,
                  workId: previous.workId, ownerEpoch: source.run.ownerEpoch, fencingToken: resource.fencingToken,
                  outcome: 'completed', at: Date.now(), evidence: 'recovered staged Graph output',
                }, this.externalOperationSignal())
                agent.session.append('graph/settlement', { ...settlementBase, outcome: 'confirmed', completedAt: Date.now(), evidence: 'recovered staged Graph output' })
              }
              if (claim !== undefined && !priorSettlements.some(item => item.kind === 'coordination' && item.outcome === 'confirmed')) {
                if (coordination === undefined || lease?.fencingToken === undefined || agent.session.header.cwd === undefined) {
                  throw new Error('staged output has an unrecoverable coordination claim')
                }
                const roleId = prior.overrides[node.id]?.roleId ?? node.roleId
                const role = prior.configSnapshot.roles.find(candidate => candidate.id === roleId) as GraphRole
                const settlementId = settlementIdOf(previous.workId, prior.generationId, source.inherited
                  ? `coordination:${source.run.generationId}:${claim.id}`
                  : `coordination:${claim.id}`)
                const settlementBase = this.beginSettlement(agent, {
                  id: settlementId,
                  operationId: operationIdOf(previous.workId, prior.generationId), workId: previous.workId,
                  runId: prior.id, generationId: prior.generationId, ownerEpoch: prior.ownerEpoch,
                  kind: 'coordination' as const, externalReference: claim,
                })
                if (settlementBase === undefined) throw new Error('coordination settlement became confirmed during recovery')
                await this.flushBeforeExternal(agent, this.externalOperationSignal())
                const currentLease = await this.latestCoordinationLease(coordination, {
                  protocolVersion: 3,
                  workId: previous.workId,
                  activationId: activationIdOf(previous.workId, source.run.generationId),
                  cwd: agent.session.header.cwd,
                  callerId: agent.id,
                }, { claimId: claim.id, leaseId: lease.id, fencingToken: lease.fencingToken }, this.externalOperationSignal())
                await coordination.settle({
                  protocolVersion: 3, graph, node, role, runId: prior.id, cwd: agent.session.header.cwd,
                  workId: previous.workId,
                  activationId: activationIdOf(previous.workId, source.run.generationId),
                  ownerEpoch: source.run.ownerEpoch,
                  operationId: operationIdOf(previous.workId, source.run.generationId), callerId: agent.id,
                  claimId: currentLease.claimId, leaseId: currentLease.leaseId, fencingToken: currentLease.fencingToken,
                  settlementId, outcome: 'succeeded',
                  evidence: previous.output.coordinationSummary ?? previous.output.summary,
                }, this.externalOperationSignal())
                agent.session.append('graph/settlement', { ...settlementBase, outcome: 'confirmed', completedAt: Date.now(), evidence: previous.output.coordinationSummary ?? previous.output.summary })
              }
              nodes[node.id] = { ...previous, phase: 'succeeded' }
              decisions.set(node.id, 'staged output settlements recovered')
            } catch (error) {
              nodes[node.id] = { ...previous, phase: 'awaiting_user' }
              decisions.set(node.id, `staged output settlement unknown: ${errorMessage(error)}`)
            }
            continue
          }
          const settledAttempts = previous.attempts
            .filter(attempt => attempt.finishedAt !== undefined)
            .map((attempt, index) => ({ ...attempt, number: index + 1 }))
          const interruptedAttempts = previous.attempts.length - settledAttempts.length
          const undispatched = worker === undefined
          let recoverable = node.effectPolicy === 'idempotent'
            || (node.effectPolicy === 'reconcile' && undispatched)
          const cleanupEvidence: string[] = []
          if (worker !== undefined && workspace !== undefined) {
            const settlementId = settlementIdOf(previous.workId, prior.generationId, source.inherited
              ? `worker-reconcile:${source.run.generationId}:${worker.id}:${workspace.id}`
              : `worker-reconcile:${worker.id}:${workspace.id}`)
            const settlement = this.beginSettlement(agent, {
              id: settlementId,
              operationId: operationIdOf(previous.workId, prior.generationId),
              workId: previous.workId,
              runId: prior.id,
              generationId: prior.generationId,
              ownerEpoch: prior.ownerEpoch,
              kind: 'compensation',
              externalReference: workspace,
            })
            if (settlement !== undefined) {
              await this.flushBeforeExternal(agent, this.externalOperationSignal())
              try {
                const disposition = await this.ctx.graphWorkers.reconcile(worker.provider, {
                  protocolVersion: 1,
                  workId: previous.workId,
                  operationId: operationIdOf(previous.workId, source.run.generationId),
                  runId: prior.id,
                  generationId: source.run.generationId,
                  ownerEpoch: source.run.ownerEpoch,
                  workerId: GraphWorkerId(worker.id),
                  workspaceId: GraphWorkspaceAllocationId(workspace.id),
                  workspaceMode: node.workspace?.mode ?? this.workspaceMode,
                  cleanup: node.workspace?.cleanup ?? (this.workspaceMode === 'shared' ? 'retain' : 'retain-on-failure'),
                  safeToDelete: node.effectPolicy === 'idempotent',
                }, this.externalOperationSignal())
                agent.session.append('graph/settlement', {
                  ...settlement,
                  outcome: 'confirmed',
                  completedAt: Date.now(),
                  evidence: `${disposition.status}: ${disposition.evidence}`,
                })
                cleanupEvidence.push(`Worker workspace ${disposition.status}`)
                if (disposition.status === 'quarantined') recoverable = false
              } catch (error) {
                agent.session.append('graph/settlement', {
                  ...settlement,
                  outcome: 'failed',
                  completedAt: Date.now(),
                  error: { code: 'GRAPH_WORKER_RECONCILE_FAILED', message: errorMessage(error) },
                })
                cleanupEvidence.push(`Worker workspace reconciliation failed: ${errorMessage(error)}`)
                recoverable = false
              }
            }
          }
          if (resource !== undefined) {
            const priorSettlements = Object.values(this.state(agent).settlements).flat().filter(item => item.workId === previous.workId)
            if (!priorSettlements.some(item => item.kind === 'resource-release' && item.externalReference?.id === resource.id && item.outcome === 'confirmed')) {
              const resources = this.ctx.get('graphResources')
              const settlementId = settlementIdOf(previous.workId, prior.generationId, source.inherited
                ? `resource-release:${source.run.generationId}:${resource.id}`
                : `resource-release:${resource.id}`)
              const settlement = this.beginSettlement(agent, {
                id: settlementId,
                operationId: operationIdOf(previous.workId, prior.generationId),
                workId: previous.workId,
                runId: prior.id,
                generationId: prior.generationId,
                ownerEpoch: prior.ownerEpoch,
                kind: 'resource-release',
                externalReference: resource,
              })
              if (settlement !== undefined) {
                await this.flushBeforeExternal(agent, this.externalOperationSignal())
                try {
                  if (resources === undefined || resource.fencingToken === undefined) throw new Error('orphan model reservation has no available Provider')
                  const disposition = await resources.reconcile({
                    protocolVersion: 1,
                    reservationId: resource.id as GraphResourceReservation['id'],
                    providerId: resource.provider,
                    workId: previous.workId,
                    ownerEpoch: source.run.ownerEpoch,
                    fencingToken: resource.fencingToken,
                    at: Date.now(),
                    evidence: 'recovery found a reservation without a staged node output',
                  }, this.externalOperationSignal())
                  if (disposition.status === 'conflict') throw new Error(disposition.evidence)
                  agent.session.append('graph/settlement', {
                    ...settlement,
                    outcome: 'confirmed',
                    completedAt: Date.now(),
                    evidence: `${disposition.status}: ${disposition.evidence}`,
                  })
                  cleanupEvidence.push(`model reservation ${disposition.status}`)
                } catch (error) {
                  agent.session.append('graph/settlement', {
                    ...settlement,
                    outcome: 'failed',
                    completedAt: Date.now(),
                    error: { code: 'GRAPH_RESOURCE_RECONCILE_FAILED', message: errorMessage(error) },
                  })
                  cleanupEvidence.push(`model reservation cleanup failed: ${errorMessage(error)}`)
                  recoverable = false
                }
              }
            }
          }
          let decision = coordination === undefined ? 'no coordination provider; applying node effect policy' : 'coordination reconciliation not attempted'
          if (coordination !== undefined) {
            try {
              const result = await coordination.reconcile({
                protocolVersion: 3,
                workId: previous.workId,
                activationId: activationIdOf(previous.workId, source.run.generationId),
                cwd: agent.session.header.cwd ?? '',
                callerId: agent.id,
                ...claim === undefined ? {} : { claimId: claim.id },
                ...lease === undefined ? {} : { leaseId: lease.id, fencingToken: lease.fencingToken },
              }, this.externalOperationSignal())
              decision = `${result.status}: ${result.evidence}`
              if (result.status === 'confirmed-running'
                || this.recoverableExpiredClaim(result.observation, claim, lease)) {
                const cancellation = await this.settleRecoveredCoordinationCancellation(
                  agent,
                  source.run,
                  node.id,
                  'recovery superseded the prior execution generation',
                  prior,
                )
                cleanupEvidence.push(`coordination orphan cancellation ${cancellation}`)
                recoverable = recoverable && cancellation === 'confirmed'
              } else {
                recoverable = recoverable && result.status === 'absent'
              }
            } catch (error) {
              decision = `unknown: ${errorMessage(error)}`
              recoverable = false
            }
          }
          if (cleanupEvidence.length > 0) decision = `${decision}; ${cleanupEvidence.join('; ')}`
          if (interruptedAttempts > 0) {
            decision = `${decision}; ${String(interruptedAttempts)} unfinished attempt(s) remain in the superseded generation audit and do not consume the node attempt budget`
          }
          if (authorityFailure !== undefined) decision = `scheduler authority lost: ${authorityFailure}; ${decision}`
          const attemptBudgetExhausted = settledAttempts.length >= node.maxAttempts
          const phase = attemptBudgetExhausted
            ? graph.terminationPolicy.onExhausted === 'awaiting_user' ? 'awaiting_user' : 'exhausted'
            : recoverable ? 'pending' : 'awaiting_user'
          nodes[node.id] = { ...previous, attempts: settledAttempts, phase }
          if (attemptBudgetExhausted) decision = `${decision}; attempt budget exhausted during recovery`
          decisions.set(node.id, decision)
        }
        const now = Date.now()
        const awaitingUser = Object.values(nodes).some(node => node.phase === 'awaiting_user')
        const { terminal: _terminal, error: _error, ...recoverableRun } = prior
        const run: GraphRun = {
          ...recoverableRun,
          generation,
          generationId,
          ownerEpoch,
          phase: awaitingUser ? 'awaiting_user' : 'queued',
          updatedAt: now,
          nodes,
        }
        agent.session.append('graph/run', run)
        for (const node of graph.nodes) {
          const decision = decisions.get(node.id)
          if (decision !== undefined) {
            this.appendOperation(agent, run, node, 'reconciled', undefined, { detail: decision })
            if (run.nodes[node.id]?.phase === 'succeeded' && prior.nodes[node.id]?.phase !== 'succeeded') {
              this.appendOperation(agent, run, node, 'terminal', undefined, { terminalOutcome: 'succeeded', detail: decision })
            }
          }
        }
        for (const node of graph.nodes) {
          if (run.nodes[node.id]?.phase !== 'awaiting_user') continue
          const currentProjection = this.state(agent)
          const existing = Object.values(currentProjection.checkpoints).find(item => (
            item.runId === run.id && item.nodeId === node.id && item.status === 'pending'
          ))
          if (existing !== undefined) continue
          const decision = decisions.get(node.id) ?? 'Recovery could not prove that the node is safe to continue.'
          const checkpoint: GraphCheckpoint = {
            id: GraphCheckpointId(stableId('checkpoint', [run.id, run.generationId, node.id, 'recovery'])),
            graphId: run.graphId,
            revision: run.revision,
            runId: run.id,
            nodeId: node.id,
            kind: 'awaiting_user',
            status: 'pending',
            createdAt: Date.now(),
            iteration: Object.values(currentProjection.checkpoints).filter(item => item.runId === run.id).length + 1,
            reason: `Recovery paused node ${node.id}: ${decision}`,
            issues: [{
              id: `recovery-${node.id}-${String(run.generation)}`,
              severity: 'blocking',
              summary: decision,
              evidence: [`run ${run.id}`, `generation ${run.generationId}`],
              ownerNodeIds: [node.id],
            }],
          }
          validateGraphCheckpoint(checkpoint, currentProjection)
          agent.session.append('graph/checkpoint', checkpoint)
        }
        this.schedulerAuthorityFailures.delete(prior.id)
        if (run.phase === 'awaiting_user') {
          if (schedulerLease !== undefined) {
            const scheduler = this.ctx.get('graphScheduler')
            if (scheduler !== undefined) {
              await this.flushBeforeExternal(agent, this.externalOperationSignal())
              await scheduler.release(this.schedulerLeaseRequest(schedulerLease), this.externalOperationSignal())
            }
          }
          continue
        }
        const controller = new AbortController()
        this.aborts.set(run.id, controller)
        const execution = this.driveOwned(agent, graph, run, run.configSnapshot, controller.signal, schedulerLease)
        void this.trackExecution(run.id, execution)
      } catch (error) {
        if (schedulerLease !== undefined) {
          const scheduler = this.ctx.get('graphScheduler')
          if (scheduler !== undefined) {
            try {
              await this.flushBeforeExternal(agent, this.externalOperationSignal())
              await scheduler.release(this.schedulerLeaseRequest(schedulerLease), this.externalOperationSignal())
            } catch (releaseError) {
              this.ctx.logger.warn('dsh-graph-mode: failed to release recovery lease for run %s: %o', prior.id, releaseError)
            }
          }
        }
        throw error
      }
    }
  }

  private async restartGeneration(
    agent: Agent,
    requestedRun: GraphRun,
    nodeId: GraphNodeId,
    options: {
      readonly override?: GraphNodeExecutionOverride
      readonly targetPhase?: 'skipped' | 'canceled'
      readonly suppliedOutput?: GraphNodeOutput
      readonly suppliedByControlId?: GraphControlOperationId
    } = {},
  ): Promise<GraphRun> {
    const active = this.executions.get(requestedRun.id)
    if (active !== undefined) {
      this.aborts.get(requestedRun.id)?.abort(new Error('graph generation superseded by a control operation'))
      await active
    }
    const projection = this.state(agent)
    const prior = projection.runs[requestedRun.id] ?? requestedRun
    const graph = projection.graphs[prior.graphId]?.find(item => item.revision === prior.revision)
      ?? failControl(`run ${prior.id} has no immutable graph revision`)
    if (!graph.nodes.some(node => node.id === nodeId)) failControl(`node ${nodeId} is absent from run ${prior.id}`)
    if (options.targetPhase === 'skipped' && !graph.nodes.find(node => node.id === nodeId)?.skippable) {
      failControl(`node ${nodeId} is not skippable`)
    }
    if (options.suppliedOutput !== undefined && options.suppliedByControlId === undefined) {
      failControl('supplied output requires control provenance')
    }
    const restart = new Set(downstreamInvalidation(graph, [nodeId]))
    for (const state of Object.values(prior.nodes)) {
      if (!['succeeded', 'skipped'].includes(state.phase)) restart.add(state.nodeId)
    }
    await this.settleRecoveredCoordinationCancellations(
      agent,
      prior,
      restart,
      `graph generation superseded by control at node ${nodeId}`,
    )
    const generation = prior.generation + 1
    const { terminal: _terminal, error: _error, ...base } = prior
    const nodes: Record<string, GraphNodeRun> = {}
    for (const node of graph.nodes) {
      const previous = prior.nodes[node.id] as GraphNodeRun
      if (!restart.has(node.id)) {
        const { invalidatedBy: _invalidatedBy, ...reused } = previous
        nodes[node.id] = {
          ...reused,
          reusedFrom: { runId: prior.id, generationId: prior.generationId, nodeId: node.id },
        }
      } else if (node.id === nodeId && options.suppliedOutput !== undefined) {
        nodes[node.id] = {
          workId: previous.workId,
          nodeId: node.id,
          phase: 'succeeded' as const,
          attempts: [],
          output: options.suppliedOutput,
          suppliedByControlId: options.suppliedByControlId as GraphControlOperationId,
          invalidatedBy: [nodeId],
        }
      } else {
        nodes[node.id] = {
          workId: previous.workId,
          nodeId: node.id,
          phase: node.id === nodeId && options.targetPhase !== undefined ? options.targetPhase : 'pending',
          attempts: [],
          invalidatedBy: [nodeId],
        }
      }
    }
    const now = Date.now()
    let run: GraphRun = {
      ...base,
      generation,
      generationId: generationIdOf(agent, graph, generation),
      ownerEpoch: prior.ownerEpoch + 1,
      phase: 'queued',
      updatedAt: now,
      nodes,
      overrides: {
        ...prior.overrides,
        ...options.override === undefined ? {} : { [nodeId]: options.override },
      },
    }
    const ownership = await this.ownRun(agent, run, this.externalOperationSignal())
    run = ownership.run
    let handedOff = false
    try {
      agent.session.append('graph/run', run)
      for (const node of graph.nodes) {
        if (!restart.has(node.id)) continue
        this.appendOperation(agent, run, node, 'reconciled', undefined, { detail: `control operation started generation ${String(generation)}` })
        if (node.id === nodeId && options.suppliedOutput !== undefined) {
          const outputHash = createHash('sha256').update(JSON.stringify(options.suppliedOutput)).digest('hex')
          this.appendOperation(agent, run, node, 'output-staged', undefined, { outputHash, detail: `output supplied by control ${String(options.suppliedByControlId)}` })
          this.appendOperation(agent, run, node, 'terminal', undefined, { terminalOutcome: 'succeeded' })
        } else if (node.id === nodeId && options.targetPhase !== undefined) {
          this.appendOperation(agent, run, node, 'terminal', undefined, { terminalOutcome: options.targetPhase })
        }
      }
      const controller = new AbortController()
      this.aborts.set(run.id, controller)
      const execution = this.driveOwned(agent, graph, run, run.configSnapshot, controller.signal, ownership.lease)
      void this.trackExecution(run.id, execution)
      handedOff = true
      return run
    } finally {
      if (!handedOff && ownership.lease !== undefined) {
        await this.releaseSchedulerLease(agent, ownership.lease, `controlled generation ${run.generationId}`)
      }
    }
  }

  /** Resume unfinished nodes after a controller checkpoint without re-running accepted predecessors. */
  private async resumePausedGeneration(agent: Agent, requestedRun: GraphRun, reason: string): Promise<GraphRun> {
    const active = this.executions.get(requestedRun.id)
    if (active !== undefined) await active
    const projection = this.state(agent)
    const prior = projection.runs[requestedRun.id] ?? requestedRun
    const graph = projection.graphs[prior.graphId]?.find(item => item.revision === prior.revision)
      ?? failControl(`run ${prior.id} has no immutable graph revision`)
    if (!['paused', 'awaiting_user'].includes(prior.phase)) failControl(`run ${prior.id} is not waiting at a checkpoint`)
    const generation = prior.generation + 1
    const { terminal: _terminal, error: _error, ...base } = prior
    const resumed = new Set<GraphNodeId>()
    const nodes: Record<string, GraphNodeRun> = {}
    for (const node of graph.nodes) {
      const previous = prior.nodes[node.id] as GraphNodeRun
      if (['succeeded', 'skipped'].includes(previous.phase)) {
        const { invalidatedBy: _invalidatedBy, ...reused } = previous
        nodes[node.id] = {
          ...reused,
          reusedFrom: { runId: prior.id, generationId: prior.generationId, nodeId: node.id },
        }
        continue
      }
      resumed.add(node.id)
      nodes[node.id] = { ...previous, phase: 'pending' }
    }
    await this.settleRecoveredCoordinationCancellations(
      agent,
      prior,
      resumed,
      `graph generation resumed after checkpoint: ${reason}`,
    )
    let run: GraphRun = {
      ...base,
      generation,
      generationId: generationIdOf(agent, graph, generation),
      ownerEpoch: prior.ownerEpoch + 1,
      phase: 'queued',
      updatedAt: Date.now(),
      nodes,
    }
    const ownership = await this.ownRun(agent, run, this.externalOperationSignal())
    run = ownership.run
    let handedOff = false
    try {
      agent.session.append('graph/run', run)
      for (const node of graph.nodes) {
        if (resumed.has(node.id)) this.appendOperation(agent, run, node, 'reconciled', undefined, { detail: reason })
      }
      const controller = new AbortController()
      this.aborts.set(run.id, controller)
      const execution = this.driveOwned(agent, graph, run, run.configSnapshot, controller.signal, ownership.lease)
      void this.trackExecution(run.id, execution)
      handedOff = true
      return run
    } finally {
      if (!handedOff && ownership.lease !== undefined) {
        await this.releaseSchedulerLease(agent, ownership.lease, `resumed generation ${run.generationId}`)
      }
    }
  }

  /**
   * Validate and durably replace one session's graph-mode settings.
   * @param agent session owner receiving the configuration event.
   * @param config complete replacement configuration.
   */
  setConfig(agent: Agent, config: GraphModeConfig): void {
    validateGraphModeConfig(config)
    agent.session.append('graph/change', { kind: 'graph/config', version: 2, config })
    if (config.active) {
      this.liveAgents.add(agent)
      if (!this.recoveryTimers.has(agent)) this.installRecoveryWatch(agent)
    }
    this.syncSubmitTool(agent, config.active)
  }

  private async requestCoordinationCancellation(
    agent: Agent,
    run: GraphRun,
    nodeId: GraphNodeId,
    reason: string,
    recordRun: GraphRun = run,
  ): Promise<'confirmed' | 'failed' | 'unavailable'> {
    const coordination = this.ctx.get('graphCoordination')
    const cwd = agent.session.header.cwd
    const nodeRun = run.nodes[nodeId]
    if (coordination === undefined || cwd === undefined || nodeRun === undefined) return 'unavailable'
    const projection = this.state(agent)
    const graph = projection.graphs[run.graphId]?.find(item => item.revision === run.revision)
    const node = graph?.nodes.find(item => item.id === nodeId)
    if (graph === undefined || node === undefined) return 'unavailable'
    const transitions = projection.operations[nodeRun.workId]?.filter(item => item.runId === run.id
      && item.generationId === run.generationId) ?? []
    const references = transitions.flatMap(item => item.externalReferences)
    const claim = [...references].reverse().find(item => item.provider === 'graph-coordination')
    const lease = [...references].reverse().find(item => item.provider === 'graph-coordination-lease')
    if (claim === undefined || lease === undefined || lease.fencingToken === undefined) return 'unavailable'
    const override = run.overrides[nodeId]
    const roleId = override?.roleId ?? node.roleId
    const configuredRole = run.configSnapshot.roles.find(item => item.id === roleId)
    if (configuredRole === undefined) return 'unavailable'
    const role: GraphRole = { ...configuredRole, model: { ...configuredRole.model, ...override?.model } }
    const settlementId = settlementIdOf(
      nodeRun.workId,
      recordRun.generationId,
      recordRun.generationId === run.generationId ? 'cancellation' : `cancellation:${run.generationId}`,
    )
    const settlementBase = this.beginSettlement(agent, {
      id: settlementId,
      operationId: operationIdOf(nodeRun.workId, recordRun.generationId),
      workId: nodeRun.workId,
      runId: run.id,
      generationId: recordRun.generationId,
      ownerEpoch: recordRun.ownerEpoch,
      kind: 'cancellation' as const,
      externalReference: claim,
    })
    if (settlementBase === undefined) return 'confirmed'
    await this.flushBeforeExternal(agent, this.externalOperationSignal())
    try {
      const currentLease = await this.latestCoordinationLease(coordination, {
        protocolVersion: 3,
        workId: nodeRun.workId,
        activationId: activationIdOf(nodeRun.workId, run.generationId),
        cwd,
        callerId: agent.id,
      }, { claimId: claim.id, leaseId: lease.id, fencingToken: lease.fencingToken }, this.externalOperationSignal())
      await coordination.cancel({
        protocolVersion: 3,
        graph,
        node,
        role,
        runId: run.id,
        cwd,
        workId: nodeRun.workId,
        activationId: activationIdOf(nodeRun.workId, run.generationId),
        ownerEpoch: run.ownerEpoch,
        operationId: operationIdOf(nodeRun.workId, run.generationId),
        callerId: agent.id,
        claimId: currentLease.claimId,
        leaseId: currentLease.leaseId,
        fencingToken: currentLease.fencingToken,
        progressSequence: (nodeRun.attempts.at(-1)?.number ?? 1) * 2 + 1,
        reason,
      }, this.externalOperationSignal())
      agent.session.append('graph/settlement', {
        ...settlementBase,
        outcome: 'confirmed',
        completedAt: Date.now(),
        evidence: `coordination cancellation requested: ${reason}`,
      })
      return 'confirmed'
    } catch (error) {
      agent.session.append('graph/settlement', {
        ...settlementBase,
        outcome: 'failed',
        completedAt: Date.now(),
        error: { code: 'GRAPH_COORDINATION_CANCEL_FAILED', message: errorMessage(error) },
      })
      this.ctx.logger.warn('dsh-graph-mode: coordination cancellation failed for node %s: %o', nodeId, error)
      return 'failed'
    }
  }

  /** Terminally settle a recovered orphan claim only after Worker reconciliation has stopped its prior generation. */
  private async settleRecoveredCoordinationCancellation(
    agent: Agent,
    run: GraphRun,
    nodeId: GraphNodeId,
    reason: string,
    recordRun: GraphRun = run,
  ): Promise<'confirmed' | 'failed' | 'unavailable'> {
    const coordination = this.ctx.get('graphCoordination')
    const cwd = agent.session.header.cwd
    const nodeRun = run.nodes[nodeId]
    if (coordination === undefined || cwd === undefined || nodeRun === undefined) return 'unavailable'
    const projection = this.state(agent)
    const graph = projection.graphs[run.graphId]?.find(item => item.revision === run.revision)
    const node = graph?.nodes.find(item => item.id === nodeId)
    if (graph === undefined || node === undefined) return 'unavailable'
    const references = (projection.operations[nodeRun.workId] ?? [])
      .filter(item => item.runId === run.id && item.generationId === run.generationId)
      .flatMap(item => item.externalReferences)
    const claim = [...references].reverse().find(item => item.provider === 'graph-coordination')
    const lease = [...references].reverse().find(item => item.provider === 'graph-coordination-lease')
    if (claim === undefined || lease === undefined || lease.fencingToken === undefined) return 'unavailable'
    const override = run.overrides[nodeId]
    const roleId = override?.roleId ?? node.roleId
    const configuredRole = run.configSnapshot.roles.find(item => item.id === roleId)
    if (configuredRole === undefined) return 'unavailable'
    const role: GraphRole = { ...configuredRole, model: { ...configuredRole.model, ...override?.model } }
    const settlementId = settlementIdOf(
      nodeRun.workId,
      recordRun.generationId,
      recordRun.generationId === run.generationId
        ? `coordination:${claim.id}`
        : `coordination:${run.generationId}:${claim.id}`,
    )
    if (projection.settlements[settlementId]?.at(-1)?.outcome === 'confirmed') return 'confirmed'
    const coordinationRequest = {
      protocolVersion: 3 as const,
      graph,
      node,
      role,
      runId: run.id,
      cwd,
      workId: nodeRun.workId,
      activationId: activationIdOf(nodeRun.workId, run.generationId),
      ownerEpoch: run.ownerEpoch,
      operationId: operationIdOf(nodeRun.workId, run.generationId),
      callerId: agent.id,
    }
    let currentLease: Pick<GraphCoordinationClaim, 'claimId' | 'leaseId' | 'fencingToken' | 'expiresAt'>
    try {
      currentLease = await this.latestCoordinationLease(coordination, {
        protocolVersion: 3,
        workId: nodeRun.workId,
        activationId: coordinationRequest.activationId,
        cwd,
        callerId: agent.id,
      }, { claimId: claim.id, leaseId: lease.id, fencingToken: lease.fencingToken }, this.externalOperationSignal())
      if (currentLease.expiresAt <= Date.now()) {
        await this.flushBeforeExternal(agent, this.externalOperationSignal())
        const reclaimed = await coordination.claim(coordinationRequest, this.externalOperationSignal())
        if (reclaimed.claimId !== claim.id || reclaimed.fencingToken < currentLease.fencingToken
          || (reclaimed.fencingToken === currentLease.fencingToken && reclaimed.leaseId !== currentLease.leaseId)) {
          throw new Error(`coordination reclaim replaced or regressed claim ${claim.id}`)
        }
        if (reclaimed.terminal !== undefined) {
          if (reclaimed.terminal.outcome !== 'canceled') {
            throw new Error(`coordination reclaim found terminal outcome ${reclaimed.terminal.outcome}`)
          }
          const terminalSettlement = this.beginSettlement(agent, {
            id: settlementId,
            operationId: operationIdOf(nodeRun.workId, recordRun.generationId),
            workId: nodeRun.workId,
            runId: run.id,
            generationId: recordRun.generationId,
            ownerEpoch: recordRun.ownerEpoch,
            kind: 'coordination' as const,
            externalReference: claim,
          })
          if (terminalSettlement !== undefined) {
            agent.session.append('graph/settlement', {
              ...terminalSettlement,
              outcome: 'confirmed',
              completedAt: Date.now(),
              evidence: reclaimed.terminal.evidence,
            })
          }
          return 'confirmed'
        }
        if (reclaimed.expiresAt <= Date.now()) throw new Error(`coordination reclaim for ${claim.id} returned an expired lease`)
        currentLease = reclaimed
      } else {
        const requested = await this.requestCoordinationCancellation(agent, run, nodeId, reason, recordRun)
        if (requested !== 'confirmed') return requested
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-graph-mode: recovered coordination claim could not be reclaimed for node %s: %o', nodeId, error)
      return 'failed'
    }
    const settlementBase = this.beginSettlement(agent, {
      id: settlementId,
      operationId: operationIdOf(nodeRun.workId, recordRun.generationId),
      workId: nodeRun.workId,
      runId: run.id,
      generationId: recordRun.generationId,
      ownerEpoch: recordRun.ownerEpoch,
      kind: 'coordination' as const,
      externalReference: claim,
    })
    if (settlementBase === undefined) return 'confirmed'
    await this.flushBeforeExternal(agent, this.externalOperationSignal())
    const evidence = `dsh graph node ${node.id} canceled during recovery: ${reason}`
    try {
      await coordination.settle({
        ...coordinationRequest,
        claimId: currentLease.claimId,
        leaseId: currentLease.leaseId,
        fencingToken: currentLease.fencingToken,
        settlementId,
        outcome: 'canceled',
        evidence,
      }, this.externalOperationSignal())
      agent.session.append('graph/settlement', {
        ...settlementBase,
        outcome: 'confirmed',
        completedAt: Date.now(),
        evidence,
      })
      return 'confirmed'
    } catch (error) {
      agent.session.append('graph/settlement', {
        ...settlementBase,
        outcome: 'failed',
        completedAt: Date.now(),
        error: { code: 'GRAPH_COORDINATION_WRITEBACK_FAILED', message: errorMessage(error) },
      })
      this.ctx.logger.warn('dsh-graph-mode: recovered coordination settlement failed for node %s: %o', nodeId, error)
      return 'failed'
    }
  }

  /** Settle every still-open coordination claim owned by nodes leaving an execution generation. */
  private async settleRecoveredCoordinationCancellations(
    agent: Agent,
    run: GraphRun,
    nodeIds: Iterable<GraphNodeId>,
    reason: string,
  ): Promise<void> {
    for (const nodeId of new Set(nodeIds)) {
      await this.settleRecoveredCoordinationCancellation(agent, run, nodeId, reason)
    }
  }

  /**
   * Execute one idempotent human or controller operation over a durable run.
   * @param agent session owner receiving the addressed operation.
   * @param request stable operation id, action, target, and reason.
   * @param authority host-authenticated principal and ingress.
   * @returns durable accepted control record, or its existing duplicate.
   */
  async control(
    agent: Agent,
    request: GraphControlRequest,
    authority: GraphControlAuthority = { actor: { kind: 'system', id: 'graph-mode' }, source: 'host-api' },
  ): Promise<import('@deepseek-ai/dsh-graph').GraphControlRecord> {
    const lockId = agent.session.id
    const previous = this.controlLocks.get(lockId) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => { release = resolve })
    this.controlLocks.set(lockId, current)
    await previous
    try {
      return await this.applyControl(agent, request, authority)
    } finally {
      release()
      if (this.controlLocks.get(lockId) === current) this.controlLocks.delete(lockId)
    }
  }

  private async applyControl(
    agent: Agent,
    request: GraphControlRequest,
    authority: GraphControlAuthority,
  ): Promise<import('@deepseek-ai/dsh-graph').GraphControlRecord> {
    if (!request.reason.trim()) failControl('graph control reason must be non-empty')
    if (!authority.actor.id.trim()) failControl('graph control actor id must be non-empty')
    const initial = this.state(agent)
    const duplicate = initial.controls[request.operationId]
    if (duplicate !== undefined) {
      if (recordedControlFingerprint(duplicate) !== controlFingerprint(request, authority)) {
        failControl(`graph control operation id ${request.operationId} was reused with different input`)
      }
      return duplicate
    }
    const run = initial.runs[request.runId] ?? failControl(`unknown graph run ${request.runId}`)
    if (request.graphId !== run.graphId) failControl(`graph control expected graph ${request.graphId}, but run ${run.id} belongs to ${run.graphId}`)
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== run.revision) {
      failControl(`stale graph control revision: expected ${String(request.expectedRevision)}, current ${String(run.revision)}`)
    }
    if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration !== run.generation) {
      failControl(`stale graph control generation: expected ${String(request.expectedGeneration)}, current ${String(run.generation)}`)
    }
    if (request.expectedAttemptId !== undefined) {
      const nodeId = request.nodeId ?? failControl('expectedAttemptId requires nodeId')
      const latestAttempt = run.nodes[nodeId]?.attempts.at(-1)
      if (latestAttempt?.id !== request.expectedAttemptId) {
        failControl(`stale graph control attempt for node ${nodeId}: expected ${request.expectedAttemptId}, current ${latestAttempt?.id ?? 'none'}`)
      }
    }
    const graph = initial.graphs[run.graphId]?.find(item => item.revision === run.revision)
      ?? failControl(`run ${run.id} has no immutable graph revision`)
    const requestedAt = Date.now()
    let resultingGeneration: number | undefined
    let resultingRevision: number | undefined
    let controllerFollowup: string | undefined
    let result: import('@deepseek-ai/dsh-graph').GraphControlRecord['result'] = { outcome: 'applied' }
    let impact: import('@deepseek-ai/dsh-graph').GraphControlRecord['impact'] = { invalidatedNodeIds: [], reusedNodeIds: [] }
    switch (request.action) {
      case 'pause-run':
      case 'modify-task': {
        const modification = request.action === 'modify-task'
        const terminal = ['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)
        if (!modification && terminal) {
          result = { outcome: 'no-op', detail: `run ${run.id} is already terminal with phase ${run.phase}` }
          break
        }
        if (!modification && ['paused', 'awaiting_user'].includes(run.phase)) {
          result = { outcome: 'no-op', detail: `run ${run.id} is already ${run.phase}` }
          break
        }
        const node = modification
          ? graph.nodes.find(candidate => candidate.id === request.nodeId)
            ?? failControl(`modify-task requires a node from run ${run.id}`)
          : graph.nodes.find(candidate => !terminalNodePhase((run.nodes[candidate.id] as GraphNodeRun).phase))
            ?? graph.nodes[0]
            ?? failControl(`run ${run.id} has no node for a pause checkpoint`)
        const checkpoint: GraphCheckpoint = {
          id: GraphCheckpointId(stableId('checkpoint', [run.id, run.generation, request.operationId])),
          graphId: run.graphId,
          revision: run.revision,
          runId: run.id,
          nodeId: node.id,
          kind: 'awaiting_user',
          status: 'pending',
          createdAt: Date.now(),
          iteration: Object.values(initial.checkpoints).filter(item => item.runId === run.id).length + 1,
          reason: request.reason,
          issues: [{
            id: modification ? `modify-${node.id}` : 'human-pause',
            severity: 'blocking',
            summary: request.reason,
            evidence: [`control operation ${request.operationId}`],
            ownerNodeIds: [node.id],
          }],
        }
        validateGraphCheckpoint(checkpoint, initial)
        agent.session.append('graph/checkpoint', checkpoint)
        if (!terminal) {
          const execution = this.executions.get(run.id)
          if (execution !== undefined) {
            this.pauseRequests.set(run.id, checkpoint)
            if (modification) {
              const nodeKey = `${run.id}\u0000${node.id}`
              const controller = this.nodeAborts.get(nodeKey)
              if (controller !== undefined) {
                const worker = this.workerRuns.get(nodeKey)
                const coordinationCancellation = this.requestCoordinationCancellation(
                  agent,
                  run,
                  node.id,
                  request.reason,
                )
                await this.flushBeforeExternal(agent, this.externalOperationSignal())
                controller.abort(new GraphNodeCancellation(node.id, request.reason))
                await Promise.allSettled([
                  coordinationCancellation,
                  ...worker === undefined ? [] : [worker.cancel(request.reason, this.externalOperationSignal())],
                ])
              }
            }
            await execution
            const drained = this.state(agent).runs[run.id] ?? run
            await this.settleRecoveredCoordinationCancellations(
              agent,
              drained,
              Object.values(drained.nodes)
                .filter(state => !['succeeded', 'skipped'].includes(state.phase))
                .map(state => state.nodeId),
              request.reason,
            )
          } else {
            const now = Date.now()
            const nodes = Object.fromEntries(Object.entries(run.nodes).map(([id, state]) => [
              id,
              ['succeeded', 'skipped'].includes(state.phase) ? state : { ...state, phase: 'awaiting_user' as const },
            ]))
            appendRunUpdate(agent, run, { ...run, phase: 'awaiting_user', updatedAt: now, nodes })
          }
        }
        if (modification) {
          controllerFollowup = `[graph-modification-request]\ngraph=${graph.graphId} revision=${String(graph.revision)} run=${run.id} generation=${String(run.generation)}\nnode=${node.id} checkpoint=${checkpoint.id}\n${request.reason}\nCreate the next immutable graph revision with intent=revise. Preserve unaffected accepted evidence and invalidate the changed node plus its complete successor closure.`
        }
        break
      }
      case 'cancel-run': {
        const execution = this.executions.get(run.id)
        if (execution !== undefined) {
          const activeNodes = Object.values(run.nodes).filter(node => node.phase === 'running')
          const workers = [...this.workerRuns.entries()].filter(([key]) => key.startsWith(`${run.id}\u0000`))
          const coordinationCancellations = activeNodes.map(node => (
            this.requestCoordinationCancellation(agent, run, node.nodeId, request.reason)
          ))
          await this.flushBeforeExternal(agent, this.externalOperationSignal())
          this.aborts.get(run.id)?.abort(new Error(request.reason))
          await Promise.allSettled([
            ...coordinationCancellations,
            ...workers.map(([, worker]) => worker.cancel(request.reason, this.externalOperationSignal())),
          ])
          await execution
          const drained = this.state(agent).runs[run.id] ?? run
          await this.settleRecoveredCoordinationCancellations(
            agent,
            drained,
            Object.values(drained.nodes).map(node => node.nodeId),
            request.reason,
          )
        } else if (!['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)) {
          await this.settleRecoveredCoordinationCancellations(
            agent,
            run,
            Object.values(run.nodes).map(node => node.nodeId),
            request.reason,
          )
          const now = Date.now()
          const nodes = Object.fromEntries(Object.entries(run.nodes).map(([id, state]) => [id, terminalNodePhase(state.phase) ? state : { ...state, phase: 'canceled' as const }]))
          appendRunUpdate(agent, run, { ...run, phase: 'canceled', updatedAt: now, nodes, terminal: { outcome: 'canceled', rule: 'human-cancel-run', acceptedAt: now } })
        } else {
          result = { outcome: 'no-op', detail: `run ${run.id} is already terminal with phase ${run.phase}` }
        }
        break
      }
      case 'cancel-node': {
        const nodeId = request.nodeId ?? failControl('cancel-node requires nodeId')
        const controller = this.nodeAborts.get(`${run.id}\u0000${nodeId}`)
        if (controller !== undefined) {
          const worker = this.workerRuns.get(`${run.id}\u0000${nodeId}`)
          const coordinationCancellation = this.requestCoordinationCancellation(agent, run, nodeId, request.reason)
          await this.flushBeforeExternal(agent, this.externalOperationSignal())
          controller.abort(new GraphNodeCancellation(nodeId, request.reason))
          await Promise.allSettled([
            coordinationCancellation,
            ...worker === undefined ? [] : [worker.cancel(request.reason, this.externalOperationSignal())],
          ])
          await this.executions.get(run.id)
          await this.settleRecoveredCoordinationCancellations(
            agent,
            this.state(agent).runs[run.id] ?? run,
            [nodeId],
            request.reason,
          )
        } else {
          const restarted = await this.restartGeneration(agent, run, nodeId, { targetPhase: 'canceled' })
          resultingGeneration = restarted.generation
          impact = controlImpact(restarted)
        }
        break
      }
      case 'skip-node': {
        const nodeId = request.nodeId ?? failControl('skip-node requires nodeId')
        const restarted = await this.restartGeneration(agent, run, nodeId, { targetPhase: 'skipped' })
        resultingGeneration = restarted.generation
        impact = controlImpact(restarted)
        break
      }
      case 'retry-node':
      case 'resume-from-node': {
        const nodeId = request.nodeId ?? failControl(`${request.action} requires nodeId`)
        const restarted = await this.restartGeneration(agent, run, nodeId)
        resultingGeneration = restarted.generation
        impact = controlImpact(restarted)
        break
      }
      case 'override-node': {
        const nodeId = request.nodeId ?? failControl('override-node requires nodeId')
        const override = request.override ?? failControl('override-node requires an override')
        const restarted = await this.restartGeneration(agent, run, nodeId, { override })
        resultingGeneration = restarted.generation
        impact = controlImpact(restarted)
        break
      }
      case 'supply-output': {
        const nodeId = request.nodeId ?? failControl('supply-output requires nodeId')
        const output = request.output ?? failControl('supply-output requires output')
        const node = graph.nodes.find(candidate => candidate.id === nodeId)
          ?? failControl(`node ${nodeId} is absent from run ${run.id}`)
        const nodeRun = run.nodes[nodeId] as GraphNodeRun
        if (['pending', 'ready', 'running', 'succeeded', 'skipped'].includes(nodeRun.phase)) {
          failControl(`node ${nodeId} cannot accept supplied output while ${nodeRun.phase}`)
        }
        validateGraphNodeOutput(output, node.outputSchema)
        const restarted = await this.restartGeneration(agent, run, nodeId, {
          suppliedOutput: output,
          suppliedByControlId: request.operationId,
        })
        resultingGeneration = restarted.generation
        impact = controlImpact(restarted)
        break
      }
      case 'rollback': {
        const targetRevision = request.targetRevision ?? failControl('rollback requires targetRevision')
        const target = initial.graphs[run.graphId]?.find(item => item.revision === targetRevision)
          ?? failControl(`rollback target revision ${String(targetRevision)} is unavailable`)
        const current = initial.graphs[run.graphId]?.at(-1) as GraphRevision
        if (target.revision === current.revision) failControl('rollback target must precede the current revision')
        const replacement: GraphRevision = {
          ...target,
          revision: current.revision + 1,
          parentRevision: current.revision,
          createdAt: Date.now(),
          userInput: request.reason,
        }
        await this.submit(agent, {
          intent: 'revise',
          reason: request.reason,
          graph: replacement,
          changedNodeIds: replacement.nodes.map(node => node.id),
        })
        resultingRevision = replacement.revision
        const replacementRun = Object.values(this.state(agent).runs).find(candidate => (
          candidate.graphId === replacement.graphId && candidate.revision === replacement.revision
        ))
        if (replacementRun !== undefined) impact = controlImpact(replacementRun)
        break
      }
      case 'approve-checkpoint': {
        const checkpointId = request.checkpointId ?? failControl('approve-checkpoint requires checkpointId')
        const checkpoint = initial.checkpoints[checkpointId] ?? failControl(`unknown checkpoint ${checkpointId}`)
        if (checkpoint.runId !== run.id || checkpoint.graphId !== run.graphId
          || checkpoint.revision !== run.revision) {
          failControl(`checkpoint ${checkpointId} does not belong to the addressed run generation`)
        }
        if (checkpoint.status !== 'pending') failControl(`checkpoint ${checkpointId} is already ${checkpoint.status}`)
        if (taskModificationCheckpoint(checkpoint)) {
          failControl('task modification checkpoint approval requires a replacement revision')
        }
        if (checkpoint.proposal !== undefined) {
          const proposal = checkpoint.proposal
          const replacement: GraphRevision = {
            ...graph,
            revision: graph.revision + 1,
            parentRevision: graph.revision,
            createdAt: Date.now(),
            userInput: request.reason,
            nodes: [...graph.nodes, ...proposal.nodes],
            edges: [...graph.edges, ...proposal.edges],
            branchGroups: [...graph.branchGroups, ...proposal.branchGroups],
          }
          await this.submit(agent, { intent: 'revise', reason: request.reason, graph: replacement, changedNodeIds: proposal.changedNodeIds })
          resultingRevision = replacement.revision
          const replacementRun = Object.values(this.state(agent).runs).find(candidate => (
            candidate.graphId === replacement.graphId && candidate.revision === replacement.revision
          ))
          if (replacementRun !== undefined) impact = controlImpact(replacementRun)
        } else {
          if (checkpoint.kind === 'repair') failControl('repair checkpoint approval requires a replacement revision')
          agent.session.append('graph/checkpoint', {
            ...checkpoint,
            status: 'resolved',
            resolvedAt: Date.now(),
            ...checkpoint.kind === 'environment' ? { authorizedGeneration: run.generation + 1 } : {},
          })
          const resumed = await this.resumePausedGeneration(agent, run, request.reason)
          resultingGeneration = resumed.generation
          impact = controlImpact(resumed)
        }
        break
      }
      case 'reject-checkpoint': {
        const checkpointId = request.checkpointId ?? failControl('reject-checkpoint requires checkpointId')
        const checkpoint = initial.checkpoints[checkpointId] ?? failControl(`unknown checkpoint ${checkpointId}`)
        if (checkpoint.runId !== run.id || checkpoint.graphId !== run.graphId || checkpoint.revision !== run.revision) failControl(`checkpoint ${checkpointId} does not belong to the addressed run generation`)
        if (checkpoint.status !== 'pending') failControl(`checkpoint ${checkpointId} is already ${checkpoint.status}`)
        agent.session.append('graph/checkpoint', { ...checkpoint, status: 'canceled', resolvedAt: Date.now() })
        const execution = this.executions.get(run.id)
        if (execution !== undefined) {
          this.aborts.get(run.id)?.abort(new Error(request.reason))
          await execution
          const drained = this.state(agent).runs[run.id] ?? run
          await this.settleRecoveredCoordinationCancellations(
            agent,
            drained,
            Object.values(drained.nodes).map(node => node.nodeId),
            request.reason,
          )
        } else if (!['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase)) {
          await this.settleRecoveredCoordinationCancellations(
            agent,
            run,
            Object.values(run.nodes).map(node => node.nodeId),
            request.reason,
          )
          const now = Date.now()
          const nodes = Object.fromEntries(Object.entries(run.nodes).map(([id, state]) => [
            id,
            terminalNodePhase(state.phase) ? state : { ...state, phase: 'canceled' as const },
          ]))
          appendRunUpdate(agent, run, {
            ...run,
            phase: 'canceled',
            updatedAt: now,
            nodes,
            terminal: { outcome: 'canceled', rule: 'checkpoint-rejected', acceptedAt: now },
          })
        }
        break
      }
      case 'reconcile-run': {
        if (!['queued', 'running', 'paused', 'awaiting_user'].includes(run.phase)) {
          failControl(`run ${run.id} has no nonterminal execution to reconcile`)
        }
        if (this.executions.has(run.id)) {
          result = { outcome: 'no-op', detail: `run ${run.id} already has a live local executor` }
          break
        }
        await this.recover(agent, run.id)
        const reconciled = this.state(agent).runs[run.id] as GraphRun
        if (reconciled.generation === run.generation) {
          result = { outcome: 'no-op', detail: `run ${run.id} has no recoverable nonterminal operation` }
        } else {
          resultingGeneration = reconciled.generation
          impact = controlImpact(reconciled)
          result = { outcome: 'applied', detail: `reconciled run ${run.id} into generation ${String(reconciled.generation)}` }
        }
        break
      }
      default: {
        const unsupported: never = request.action
        failControl(`unsupported graph control action ${String(unsupported)}`)
      }
    }
    const completedAt = Date.now()
    const record: import('@deepseek-ai/dsh-graph').GraphControlRecord = {
      version: 2,
      id: request.operationId,
      action: request.action,
      graphId: graph.graphId,
      runId: run.id,
      expectedRevision: request.expectedRevision,
      expectedGeneration: request.expectedGeneration,
      ...request.expectedAttemptId === undefined ? {} : { expectedAttemptId: request.expectedAttemptId },
      ...request.nodeId === undefined ? {} : { nodeId: request.nodeId },
      ...request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId },
      ...request.targetRevision === undefined ? {} : { targetRevision: request.targetRevision },
      ...request.override === undefined ? {} : { override: request.override },
      ...request.output === undefined ? {} : { suppliedOutput: request.output },
      actor: authority.actor,
      source: authority.source,
      requestedAt,
      completedAt,
      reason: request.reason,
      result,
      impact,
      ...resultingGeneration === undefined ? {} : { resultingGeneration },
      ...resultingRevision === undefined ? {} : { resultingRevision },
    }
    agent.session.append('graph/control', record)
    if (controllerFollowup !== undefined) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: controllerFollowup }],
        source: { kind: 'graph-mode' },
      }))
    }
    return record
  }

  private resolveCampaignSubmission(
    projection: GraphProjection,
    graph: GraphRevision,
    run: GraphRun,
    binding?: GraphCampaignSubmissionDraft,
    reason?: string,
  ): GraphCampaign | undefined {
    let campaign: GraphCampaign | undefined
    if (binding?.plan !== undefined && binding.planExtension !== undefined) {
      throw new Error('campaign submission cannot carry both plan and planExtension')
    }
    if (binding?.plan !== undefined) {
      if (graph.revision !== 1) throw new Error('a campaign plan must be submitted with its first batch graph')
      if (!binding.plan.objective.trim() || binding.plan.batches.length === 0) throw new Error('campaign plan requires an objective and at least one batch')
      const ids = new Set<string>()
      const batches = binding.plan.batches.map((batch, index) => {
        if (!batch.id.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(batch.id) || ids.has(batch.id)
          || !batch.title.trim() || !batch.objective.trim()) throw new Error(`campaign batch at index ${String(index)} is invalid`)
        const dependsOn = [...batch.dependsOn ?? []]
        if (dependsOn.some(id => !ids.has(id)) || new Set(dependsOn).size !== dependsOn.length) {
          throw new Error(`campaign batch ${batch.id} dependencies must name unique earlier batches`)
        }
        ids.add(batch.id)
        return {
          id: GraphCampaignBatchId(batch.id),
          ordinal: index + 1,
          title: batch.title,
          objective: batch.objective,
          dependsOn: dependsOn.map(GraphCampaignBatchId),
          status: 'planned' as const,
          executions: [],
        }
      })
      const now = Date.now()
      campaign = {
        version: 1,
        id: allocateCampaignId(binding.plan, projection),
        objective: binding.plan.objective,
        createdAt: now,
        updatedAt: now,
        phase: 'planned',
        batches,
        planRevision: 1,
        planExtensions: [],
      }
      const firstBatchId = batches[0]?.id
      if (binding.batchId !== firstBatchId) {
        throw new Error(
          `campaign.batchId ${JSON.stringify(binding.batchId)} must equal campaign.plan.batches[0].id ${JSON.stringify(firstBatchId)} when creating a campaign; `
          + 'to start a later batch after [graph-batch-complete], omit campaign.plan and submit only campaign.batchId',
        )
      }
    } else if (binding?.planExtension !== undefined) {
      campaign = projection.currentCampaignId === undefined ? undefined : projection.campaigns[projection.currentCampaignId]
      if (campaign === undefined) throw new Error('campaign planExtension requires an active campaign')
      if (campaign.phase !== 'succeeded' || campaign.activeBatchId !== undefined
        || campaign.batches.some(batch => !['approved', 'approved_with_findings'].includes(batch.status))) {
        throw new Error('campaign planExtension requires every registered batch to be accepted and no active batch')
      }
      if (binding.planExtension.batches.length === 0) throw new Error('campaign planExtension requires at least one batch')
      const existingBatchCount = campaign.batches.length
      const ids = new Set<string>(campaign.batches.map(batch => batch.id))
      const appended = binding.planExtension.batches.map((batch, index) => {
        if (!batch.id.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(batch.id) || ids.has(batch.id)
          || !batch.title.trim() || !batch.objective.trim()) throw new Error(`campaign planExtension batch at index ${String(index)} is invalid`)
        const dependsOn = [...batch.dependsOn ?? []]
        if (dependsOn.some(id => !ids.has(id)) || new Set(dependsOn).size !== dependsOn.length) {
          throw new Error(`campaign planExtension batch ${batch.id} dependencies must name unique earlier batches`)
        }
        ids.add(batch.id)
        return {
          id: GraphCampaignBatchId(batch.id),
          ordinal: existingBatchCount + index + 1,
          title: batch.title,
          objective: batch.objective,
          dependsOn: dependsOn.map(GraphCampaignBatchId),
          status: 'planned' as const,
          executions: [],
        }
      })
      const firstBatchId = appended[0]?.id
      if (binding.batchId !== firstBatchId) {
        throw new Error(
          `campaign.batchId ${JSON.stringify(binding.batchId)} must equal campaign.planExtension.batches[0].id ${JSON.stringify(firstBatchId)} when extending a campaign`,
        )
      }
      const sourceBatch = campaign.batches.findLast(batch => ['approved', 'approved_with_findings'].includes(batch.status))
      const sourceExecution = sourceBatch?.executions.findLast(execution => execution.status === 'succeeded')
      const now = Date.now()
      campaign = {
        ...campaign,
        updatedAt: now,
        phase: 'planned',
        batches: [...campaign.batches, ...appended],
        planRevision: (campaign.planRevision ?? 1) + 1,
        planExtensions: [...(campaign.planExtensions ?? []), {
          revision: (campaign.planRevision ?? 1) + 1,
          createdAt: now,
          reason: reason?.trim() || 'Append newly discovered campaign batches.',
          addedBatchIds: appended.map(batch => batch.id),
          ...sourceBatch === undefined ? {} : { sourceBatchId: sourceBatch.id },
          ...sourceExecution === undefined ? {} : { sourceRunId: sourceExecution.runId },
          settlementIds: [...sourceExecution?.settlementIds ?? []],
        }],
      }
    } else if (binding !== undefined) {
      campaign = projection.currentCampaignId === undefined ? undefined : projection.campaigns[projection.currentCampaignId]
      if (campaign === undefined) throw new Error('campaign batch binding requires an active campaign or an initial campaign plan')
    } else {
      campaign = Object.values(projection.campaigns).find(candidate => (
        candidate.batches.some(batch => batch.graphId === graph.graphId)
      ))
    }
    if (campaign === undefined) return undefined
    const batchId = binding?.batchId ?? campaign.batches.find(batch => batch.graphId === graph.graphId)?.id
    const batch = campaign.batches.find(candidate => candidate.id === batchId)
    if (batch === undefined) throw new Error(`campaign does not contain batch ${String(batchId)}`)
    if (batch.graphId !== undefined && batch.graphId !== graph.graphId) throw new Error(`campaign batch ${batch.id} already owns graph ${batch.graphId}`)
    if (batch.dependsOn.some((id) => {
      const dependency = campaign.batches.find(candidate => candidate.id === id)
      return dependency === undefined || !['approved', 'approved_with_findings'].includes(dependency.status)
    })) throw new Error(`campaign batch ${batch.id} has unfinished dependencies`)
    if (graph.revision === 1 && batch.executions.length > 0) throw new Error(`campaign batch ${batch.id} already has a graph execution`)
    const execution = {
      graphId: graph.graphId,
      revision: graph.revision,
      runId: run.id,
      status: 'running' as const,
      startedAt: run.createdAt,
      settlementIds: [],
    }
    return {
      ...campaign,
      updatedAt: Date.now(),
      phase: 'running',
      activeBatchId: batch.id,
      batches: campaign.batches.map(candidate => candidate.id === batch.id
        ? { ...candidate, graphId: graph.graphId, status: 'running', executions: [...candidate.executions, execution] }
        : candidate),
    }
  }

  private settleCampaignRun(
    agent: Agent,
    run: GraphRun,
  ): { readonly campaign: GraphCampaign; readonly batchId: GraphCampaignBatchId; readonly nextBatchId?: GraphCampaignBatchId } | undefined {
    const projection = this.state(agent)
    const campaign = Object.values(projection.campaigns).find(candidate => candidate.batches.some(batch => (
      batch.executions.some(execution => execution.runId === run.id)
    )))
    if (campaign === undefined) return undefined
    const batch = campaign.batches.find(candidate => candidate.executions.some(execution => execution.runId === run.id))
    if (batch === undefined) return undefined
    const hasFindings = Object.values(run.nodes).some((node) => {
      const data = node.output?.data
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
      const issues = (data as { readonly issues?: unknown }).issues
      return Array.isArray(issues) && issues.length > 0
    })
    const status: GraphCampaign['batches'][number]['status'] = run.phase === 'succeeded'
      ? hasFindings ? 'approved_with_findings' : 'approved'
      : run.phase === 'paused' || run.phase === 'awaiting_user' ? 'needs_user'
        : run.phase === 'canceled' ? 'blocked' : 'rejected'
    const executionStatus: GraphCampaign['batches'][number]['executions'][number]['status'] = run.phase === 'paused' || run.phase === 'awaiting_user'
      ? 'awaiting_user' as const
      : run.phase === 'running' || run.phase === 'queued'
        ? 'failed' as const
        : run.phase
    const settlements = Object.values(projection.settlements)
      .map(records => records.at(-1))
      .filter(record => record?.runId === run.id && record.outcome === 'confirmed')
      .map(record => (record as GraphSettlementRecord).id)
    const summary = Object.values(run.nodes).flatMap(node => node.output?.summary ?? []).join(' | ').slice(0, 2_000)
    const completedAt = run.terminal?.acceptedAt ?? run.updatedAt
    const batches = campaign.batches.map(candidate => candidate.id !== batch.id
      ? candidate
      : {
        ...candidate,
        status,
        executions: candidate.executions.map(execution => execution.runId !== run.id
          ? execution
          : {
            ...execution,
            status: executionStatus,
            completedAt,
            settlementIds: settlements,
            ...summary ? { summary } : {},
          }),
      })
    const next = ['approved', 'approved_with_findings'].includes(status)
      ? batches.find(candidate => candidate.status === 'planned' && candidate.dependsOn.every((id) => {
        const dependency = batches.find(item => item.id === id)
        return dependency !== undefined && ['approved', 'approved_with_findings'].includes(dependency.status)
      }))
      : undefined
    const allApproved = batches.every(candidate => ['approved', 'approved_with_findings'].includes(candidate.status))
    const { activeBatchId: _activeBatchId, ...campaignWithoutActiveBatch } = campaign
    const nextCampaign: GraphCampaign = {
      ...campaignWithoutActiveBatch,
      updatedAt: completedAt,
      phase: allApproved
        ? 'succeeded'
        : status === 'needs_user'
          ? 'awaiting_user'
          : ['approved', 'approved_with_findings'].includes(status) ? 'running' : 'failed',
      batches,
      ...next === undefined ? {} : { activeBatchId: next.id },
    }
    agent.session.append('graph/campaign', nextCampaign)
    return { campaign: nextCampaign, batchId: batch.id, ...next === undefined ? {} : { nextBatchId: next.id } }
  }

  /**
   * Accept one controller decision and start background work when needed.
   * @param agent controller agent and durable session owner.
   * @param submission classified input plus an optional complete graph revision.
   * @param signal cancellation for validation and external preparation.
   * @returns accepted classification and identities for any started graph run.
   */
  async submit(
    agent: Agent,
    submission: GraphSubmission,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ accepted: true; intent: ControllerIntent; graphId?: string; runId?: string }> {
    const state = this.state(agent)
    if (!state.config.active) throw new Error('graph_submit is available only while graph mode is active')
    if (!submission.reason.trim()) throw new Error('controller reason must be non-empty')
    if (submission.intent !== 'new' && submission.intent !== 'revise') {
      if (submission.graph !== undefined || submission.changedNodeIds !== undefined || submission.campaign !== undefined || submission.lineage !== undefined) throw new Error(`${submission.intent} classification cannot carry a graph`)
      return { accepted: true, intent: submission.intent }
    }
    const draft = submission.graph
    if (draft === undefined) throw new Error(`${submission.intent} classification requires a graph revision`)
    const graph = resolveGraphRevisionDraft(draft, state.config, Date.now(), this.environmentPolicy)
    if (submission.intent === 'revise' && submission.campaign !== undefined) {
      throw new Error('campaign binding is inherited by revisions; omit campaign when revising a batch graph')
    }
    let changed: GraphNodeId[]
    let previousRun: GraphRun | undefined
    let previousRevision: GraphRevision | undefined
    if (submission.intent === 'new') {
      if (graph.revision !== 1 || state.graphs[graph.graphId] !== undefined) throw new Error('new work requires revision one of a new graph id')
      changed = graph.nodes.map(node => node.id)
    } else {
      if (state.currentGraphId === undefined || graph.graphId !== state.currentGraphId) throw new Error('revision must target the current graph')
      const previous = state.graphs[graph.graphId]?.at(-1)
      if (previous === undefined || graph.revision !== previous.revision + 1) throw new Error('revision must immediately follow the current graph revision')
      previousRevision = previous
      changed = directRevisionChanges(previous, graph, submission.changedNodeIds ?? [])
      if (changed.length === 0) throw new Error('revision must change at least one node or incoming dependency')
      previousRun = Object.values(state.runs)
        .filter(run => run.graphId === graph.graphId && run.revision === previous.revision)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (previousRun !== undefined) {
        const execution = this.executions.get(previousRun.id)
        if (execution !== undefined) {
          const controller = this.aborts.get(previousRun.id) as AbortController
          controller.abort(new Error('graph revision superseded the active run'))
          await execution
          previousRun = Object.values(this.state(agent).runs)
            .filter(run => run.graphId === graph.graphId && run.revision === previous.revision)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        }
        if (previousRun !== undefined) {
          await this.settleRecoveredCoordinationCancellations(
            agent,
            previousRun,
            downstreamInvalidation(graph, changed),
            `graph revision ${String(graph.revision)} superseded revision ${String(previousRun.revision)}`,
          )
        }
      }
    }
    if (agent.session.header.cwd === undefined) throw new Error('Graph execution requires a session working directory')
    const affected = downstreamInvalidation(graph, changed)
    const initial = this.initialRun(agent, graph, affected, previousRun, state.config)
    // Waiting for the predecessor to become quiescent may append its terminal
    // Campaign state. The replacement must retain that accepted execution,
    // not the projection captured before cancellation began.
    const admissionProjection = this.state(agent)
    const campaign = this.resolveCampaignSubmission(admissionProjection, graph, initial, submission.campaign, submission.reason)
    const requestedAt = Date.now()
    const lineage = resolveRevisionLineage(
      admissionProjection, submission, graph, changed, affected, previousRevision, previousRun, campaign, requestedAt,
    )
    const pendingSubmission: GraphRevisionSubmissionRecord = {
      version: 1,
      id: GraphSubmissionId(randomUUID()),
      intent: submission.intent,
      graph,
      run: initial,
      changedNodeIds: changed,
      outcome: 'pending',
      requestedAt,
      ...campaign === undefined ? {} : { campaign },
      lineage,
    }
    this.activatingSubmissions.add(pendingSubmission.id)
    try {
      agent.session.append('graph/submission', pendingSubmission)
      await this.flushBeforeExternal(agent, signal)
    } catch (error) {
      this.activatingSubmissions.delete(pendingSubmission.id)
      throw error
    }

    const coordination = this.ctx.get('graphCoordination')
    let ownership: { readonly run: GraphRun; readonly lease?: GraphSchedulerLease } | undefined
    try {
      ownership = await this.ownRun(agent, initial, this.externalOperationSignal(signal))
      if (coordination !== undefined) {
        await coordination.prepare(graph, state.config.roles, agent.session.header.cwd, this.externalOperationSignal(signal))
      }
    } catch (error) {
      try {
        agent.session.append('graph/submission', {
          ...pendingSubmission,
          outcome: 'failed',
          completedAt: Date.now(),
          error: { code: 'GRAPH_SUBMISSION_ACTIVATION_FAILED', message: errorMessage(error) },
        })
        await this.flushBeforeExternal(agent, signal)
      } finally {
        if (ownership?.lease !== undefined) {
          await this.releaseSchedulerLease(agent, ownership.lease, `failed submission ${pendingSubmission.id}`)
        }
        this.activatingSubmissions.delete(pendingSubmission.id)
      }
      throw error
    }
    let handedOff = false
    try {
      agent.session.append('graph/change', { kind: 'graph/revision', version: 2, graph, current: true })
      if (submission.intent === 'revise') {
        // External preparation may overlap a control operation. Resolve only
        // checkpoints that are still pending at this synchronous commit point.
        for (const checkpoint of Object.values(this.state(agent).checkpoints)) {
          if (checkpoint.graphId !== graph.graphId || checkpoint.revision !== graph.revision - 1 || checkpoint.status !== 'pending') continue
          agent.session.append('graph/checkpoint', {
            ...checkpoint,
            status: 'resolved',
            resolvedAt: Date.now(),
            replacementRevision: graph.revision,
          })
        }
      }
      const run = ownership.run
      agent.session.append('graph/run', run)
      for (const node of graph.nodes) {
        const state = run.nodes[node.id] as GraphNodeRun
        if (state.reusedFrom === undefined) this.appendOperation(agent, run, node, 'planned')
      }
      if (campaign !== undefined) agent.session.append('graph/campaign', campaign)
      agent.session.append('graph/submission', {
        ...pendingSubmission,
        outcome: 'accepted',
        completedAt: Date.now(),
      })
      await this.flushBeforeExternal(agent, signal)
      const controller = new AbortController()
      this.aborts.set(run.id, controller)
      const execution = this.driveOwned(agent, graph, run, state.config, controller.signal, ownership.lease)
      void this.trackExecution(run.id, execution)
      handedOff = true
      return { accepted: true, intent: submission.intent, graphId: graph.graphId, runId: run.id }
    } finally {
      this.activatingSubmissions.delete(pendingSubmission.id)
      if (!handedOff && ownership.lease !== undefined) {
        await this.releaseSchedulerLease(agent, ownership.lease, `submission ${pendingSubmission.id}`)
      }
    }
  }

  private initialRun(
    agent: Agent,
    graph: GraphRevision,
    affected: readonly GraphNodeId[],
    previous: GraphRun | undefined,
    config: GraphModeConfig,
  ): GraphRun {
    const affectedSet = new Set(affected)
    const nodes: Record<string, GraphNodeRun> = {}
    for (const node of graph.nodes) {
      const prior = previous?.nodes[node.id]
      nodes[node.id] = previous !== undefined && !affectedSet.has(node.id) && prior?.phase === 'succeeded' && prior.output !== undefined
        ? {
          workId: workIdOf(agent, graph, node), nodeId: node.id, phase: 'succeeded', attempts: [], output: prior.output,
          reusedFrom: { runId: previous.id, generationId: previous.generationId, nodeId: node.id },
        }
        : { workId: workIdOf(agent, graph, node), nodeId: node.id, phase: 'pending', attempts: [], ...affectedSet.has(node.id) ? { invalidatedBy: affected } : {} }
    }
    const now = Date.now()
    return {
      id: GraphRunId(randomUUID()),
      graphId: graph.graphId,
      revision: graph.revision,
      generation: 1,
      generationId: generationIdOf(agent, graph, 1),
      ownerEpoch: 1,
      configSnapshot: config,
      overrides: {},
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      nodes,
    }
  }

  private appendOperation(
    agent: Agent,
    run: GraphRun,
    node: GraphNode,
    stage: GraphOperationStage,
    expectedPrevious?: GraphOperationStage,
    options: {
      readonly references?: readonly GraphExternalReference[]
      readonly outputHash?: string
      readonly terminalOutcome?: 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'exhausted' | 'uncertain'
      readonly detail?: string
    } = {},
  ): void {
    const nodeRun = run.nodes[node.id] as GraphNodeRun
    const previous = expectedPrevious ?? this.state(agent).operations[nodeRun.workId]?.at(-1)?.stage
    agent.session.append('graph/operation', {
      version: 1,
      eventId: GraphOperationEventId(randomUUID()),
      operationId: operationIdOf(nodeRun.workId, run.generationId),
      workId: nodeRun.workId,
      runId: run.id,
      generationId: run.generationId,
      graphId: run.graphId,
      revision: run.revision,
      nodeId: node.id,
      ownerEpoch: run.ownerEpoch,
      stage,
      ...previous === undefined ? {} : { expectedPrevious: previous },
      at: Date.now(),
      externalReferences: options.references ?? [],
      ...options.outputHash === undefined ? {} : { outputHash: options.outputHash },
      ...options.terminalOutcome === undefined ? {} : { terminalOutcome: options.terminalOutcome },
      ...options.detail === undefined ? {} : { detail: options.detail },
    })
  }

  private environmentAuthorization(
    agent: Agent,
    run: GraphRun,
    node: GraphNode,
  ): GraphCheckpoint | undefined {
    return Object.values(this.state(agent).checkpoints).find(checkpoint => (
      checkpoint.kind === 'environment'
      && checkpoint.graphId === run.graphId
      && checkpoint.revision === run.revision
      && checkpoint.runId === run.id
      && checkpoint.nodeId === node.id
      && checkpoint.status === 'resolved'
      && checkpoint.authorizedGeneration === run.generation
    ))
  }

  private environmentApprovalCheckpoint(
    agent: Agent,
    graph: GraphRevision,
    run: GraphRun,
    node: GraphNode,
  ): GraphCheckpoint {
    const environment = node.environment as GraphEnvironmentPlan
    const projection = this.state(agent)
    const iteration = Object.values(projection.checkpoints).filter(item => item.graphId === graph.graphId).length + 1
    const plan = graphEnvironmentApprovalText(environment)
    const checkpoint: GraphCheckpoint = {
      id: GraphCheckpointId(stableId('checkpoint', [run.id, run.generationId, node.id, 'environment'])),
      graphId: graph.graphId,
      revision: graph.revision,
      runId: run.id,
      nodeId: node.id,
      kind: 'environment',
      status: 'pending',
      createdAt: Date.now(),
      iteration,
      reason: `Environment node ${node.id} requires human approval. Approve only these exact commands; rollback commands are documentary and require a separate approved node to execute.\n${plan}`,
    }
    validateGraphCheckpoint(checkpoint, projection)
    return checkpoint
  }

  private async executeEnvironmentNode(
    agent: Agent,
    node: GraphNode,
    signal: AbortSignal,
    readRun: () => GraphRun,
    read: () => GraphNodeRun | undefined,
    update: (id: GraphNodeId, state: GraphNodeRun) => void,
    assertAuthority: () => void,
  ): Promise<void> {
    const environment = node.environment as GraphEnvironmentPlan
    const run = readRun()
    const nodeRun = read() as GraphNodeRun
    const startedAt = Date.now()
    const attempt: GraphAttempt = {
      id: GraphAttemptId(randomUUID()),
      number: nodeRun.attempts.length + 1,
      startedAt,
    }
    const references: GraphExternalReference[] = environment.operations.map(operation => ({
      kind: 'environment',
      provider: 'shell',
      id: stableId('environment-operation', [nodeRun.workId, run.generationId, operation.id]),
    }))
    this.appendOperation(agent, run, node, 'admitted', undefined, {
      detail: `environment approval authorized generation ${String(run.generation)}`,
    })
    update(node.id, { ...nodeRun, phase: 'running', attempts: [...nodeRun.attempts, attempt] })
    this.appendOperation(agent, readRun(), node, 'started', undefined, { references })
    try {
      const shell = this.ctx.get('shell')
      if (shell === undefined) {
        throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_SHELL_MISSING', node.id, new Error('approved environment execution requires the shell service'))
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_WORKSPACE_MISSING', node.id, new Error('approved environment execution requires a session workspace'))
      }
      const results: GraphJsonValue[] = []
      for (const [index, operation] of environment.operations.entries()) {
        signal.throwIfAborted()
        const externalReference = references[index] as GraphExternalReference
        const settlement = this.beginSettlement(agent, {
          id: settlementIdOf(nodeRun.workId, run.generationId, `environment:${operation.id}`),
          operationId: operationIdOf(nodeRun.workId, run.generationId),
          workId: nodeRun.workId,
          runId: run.id,
          generationId: run.generationId,
          ownerEpoch: run.ownerEpoch,
          kind: 'environment',
          externalReference,
        })
        if (settlement === undefined) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_SETTLEMENT_CONFLICT', node.id, new Error(`environment operation ${operation.id} already has a confirmed settlement`))
        }
        this.appendOperation(agent, readRun(), node, 'settlement-pending', undefined, {
          references: [externalReference],
          detail: `environment operation ${operation.id} approved and pending`,
        })
        await this.flushBeforeExternal(agent, signal)
        let result: Awaited<ReturnType<Awaited<ReturnType<typeof shell.execute>>['result']>>
        try {
          result = await (await shell.execute(shell.resolve({
            command: operation.command,
            workdir: cwd,
            timeoutMs: node.executionBudget.maxWallTimeMs,
            stdoutMaxBytes: node.outputSchema.maxBytes,
            signal,
            sandboxPolicy: {
              mode: environment.sandboxMode,
              workspaceRoot: cwd,
              sessionId: agent.session.id,
            },
          }))).result()
        } catch (error) {
          assertAuthority()
          agent.session.append('graph/settlement', {
            ...settlement,
            outcome: 'failed',
            completedAt: Date.now(),
            error: { code: 'GRAPH_ENVIRONMENT_EXECUTION_FAILED', message: errorMessage(error) },
          })
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_EXECUTION_FAILED', node.id, error)
        }
        assertAuthority()
        const stdoutBytes = Buffer.byteLength(result.stdout.text, 'utf8')
        const stderrBytes = Buffer.byteLength(result.stderr.text, 'utf8')
        const evidence = `operation ${operation.id} settled: exit=${String(result.exitCode)}, signal=${result.signal ?? 'none'}, timedOut=${String(result.timedOut)}, aborted=${String(result.aborted)}, stdoutBytes=${String(stdoutBytes)}, stderrBytes=${String(stderrBytes)}`
        agent.session.append('graph/settlement', {
          ...settlement,
          outcome: 'confirmed',
          completedAt: Date.now(),
          evidence,
        })
        this.appendOperation(agent, readRun(), node, 'progress', undefined, {
          references: [externalReference],
          detail: evidence,
        })
        results.push({
          id: operation.id,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated: result.stdout.truncated,
          stderrTruncated: result.stderr.truncated,
          sandboxMode: result.sandbox?.mode ?? environment.sandboxMode,
          sandboxDenied: result.sandbox?.denied ?? false,
          sandboxRunnerFailed: result.sandbox?.runnerFailed ?? false,
        })
        if (result.sandbox?.runnerFailed === true) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_SANDBOX_FAILED', node.id, new Error(`environment operation ${operation.id} sandbox runner failed`))
        }
        if (result.sandbox?.denied === true) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_SANDBOX_DENIED', node.id, new Error(`environment operation ${operation.id} was denied by ${environment.sandboxMode}`))
        }
        if (result.timedOut) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_COMMAND_TIMEOUT', node.id, new Error(`environment operation ${operation.id} timed out`))
        }
        if (result.aborted) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_COMMAND_ABORTED', node.id, new Error(`environment operation ${operation.id} was aborted`))
        }
        if (result.exitCode !== 0) {
          throw new GraphRunExecutionError('GRAPH_ENVIRONMENT_COMMAND_FAILED', node.id, new Error(`environment operation ${operation.id} exited with code ${String(result.exitCode)}`))
        }
      }
      const output: GraphNodeOutput = {
        summary: `Executed ${String(environment.operations.length)} approved environment operations.`,
        data: {
          sandboxMode: environment.sandboxMode,
          requiredCapabilities: environment.requiredCapabilities,
          operations: results,
        },
        artifacts: [],
      }
      validateGraphNodeOutput(output, node.outputSchema)
      this.appendOperation(agent, readRun(), node, 'output-staged', undefined, { outputHash: outputHashOf(output) })
      const finished = read() as GraphNodeRun
      update(node.id, {
        ...finished,
        phase: 'succeeded',
        attempts: finished.attempts.map(item => item.id === attempt.id ? { ...item, finishedAt: Date.now() } : item),
        output,
      })
      this.appendOperation(agent, readRun(), node, 'terminal', undefined, { terminalOutcome: 'succeeded' })
    } catch (error) {
      assertAuthority()
      const canceled = signal.aborted
      const detail = {
        code: canceled ? 'GRAPH_NODE_CANCELED'
          : error instanceof GraphRunExecutionError ? error.code : 'GRAPH_ENVIRONMENT_EXECUTION_FAILED',
        message: errorMessage(canceled ? signal.reason : error),
      }
      const failed = read() as GraphNodeRun
      update(node.id, {
        ...failed,
        phase: canceled ? 'canceled' : 'failed',
        attempts: failed.attempts.map(item => item.id === attempt.id
          ? { ...item, finishedAt: Date.now(), error: detail }
          : item),
      })
      const head = this.state(agent).operations[nodeRun.workId]?.at(-1)
      if (head?.stage !== 'terminal') {
        this.appendOperation(agent, readRun(), node, 'terminal', undefined, {
          terminalOutcome: canceled ? 'canceled' : 'failed',
          detail: detail.message,
        })
      }
    }
  }

  private checkpointForOutput(
    agent: Agent,
    graph: GraphRevision,
    run: GraphRun,
    node: GraphNode,
    output: GraphNodeOutput,
  ): GraphPauseRequest | undefined {
    const data = objectRecord(output.data)
    const projection = this.state(agent)
    const prior = Object.values(projection.checkpoints).filter(item => item.graphId === graph.graphId)
    const iteration = prior.length + 1
    if (node.kind === 'expansion') {
      const expansionCount = prior.filter(item => item.kind === 'expansion').length
      if (expansionCount >= graph.terminationPolicy.maxDynamicExpansions) {
        const checkpoint: GraphCheckpoint = {
          id: GraphCheckpointId(stableId('checkpoint', [run.id, node.id, iteration])),
          graphId: graph.graphId,
          revision: graph.revision,
          runId: run.id,
          nodeId: node.id,
          kind: 'awaiting_user',
          status: 'pending',
          createdAt: Date.now(),
          iteration,
          reason: `Expansion node ${node.id} reached maxDynamicExpansions.`,
          issues: [{ id: `expansion-limit-${node.id}`, severity: 'blocking', summary: 'Dynamic expansion budget exhausted.', evidence: [], ownerNodeIds: [node.id] }],
        }
        validateGraphCheckpoint(checkpoint, projection)
        return { checkpoint, phase: graph.terminationPolicy.onExhausted === 'awaiting_user' ? 'awaiting_user' : 'exhausted' }
      }
      const rawProposal = objectRecord(data?.['proposal'])
      if (rawProposal === undefined) throw new Error('expansion node output.data.proposal must be an object')
      let mapKeys: readonly (string | number)[] | undefined
      if (node.expansion?.mode === 'map') {
        const items = valueAt(output.data, node.expansion.itemPath as readonly string[])
        if (!Array.isArray(items)) throw new Error('map expansion itemPath must resolve to an array')
        mapKeys = items.map((item) => {
          const key = valueAt(item, node.expansion?.itemKeyPath as readonly string[])
          if (typeof key !== 'string' && typeof key !== 'number') throw new Error('map expansion item keys must be strings or numbers')
          return key
        })
      }
      const proposal = { ...rawProposal, ...mapKeys === undefined ? {} : { mapKeys } } as unknown as GraphExpansionProposal
      const checkpoint: GraphCheckpoint = {
        id: GraphCheckpointId(stableId('checkpoint', [run.id, node.id, iteration])),
        graphId: graph.graphId,
        revision: graph.revision,
        runId: run.id,
        nodeId: node.id,
        kind: 'expansion',
        status: 'pending',
        createdAt: Date.now(),
        iteration,
        reason: `Expansion node ${node.id} proposed an immutable replacement revision.`,
        proposal,
      }
      validateGraphCheckpoint(checkpoint, projection)
      return {
        checkpoint,
        phase: 'paused',
      }
    }
    if (node.kind === 'design'
      && graph.edges.some(edge => edge.from === node.id)
      && !prior.some(item => item.graphId === graph.graphId && item.revision === graph.revision
        && item.nodeId === node.id && item.kind === 'planning')) {
      const checkpoint: GraphCheckpoint = {
        id: GraphCheckpointId(stableId('checkpoint', [run.id, node.id, iteration, 'planning'])),
        graphId: graph.graphId,
        revision: graph.revision,
        runId: run.id,
        nodeId: node.id,
        kind: 'planning',
        status: 'pending',
        createdAt: Date.now(),
        iteration,
        reason: `Architecture node ${node.id} completed. The controller must reconcile its evidence, repository structure, worker-model capability, and resource limits before implementation proceeds.`,
      }
      validateGraphCheckpoint(checkpoint, projection)
      return { checkpoint, phase: 'paused' }
    }
    if (node.kind !== 'review' && node.kind !== 'verification') return undefined
    const decision = data?.['decision']
    if (!['approved', 'rejected', 'needs-user'].includes(decision as string)) {
      throw new Error(`${node.kind} node output.data.decision must be approved, rejected, or needs-user`)
    }
    if (decision === 'approved') return undefined
    const issues = data?.['issues'] as readonly GraphReviewIssue[] | undefined
    const issueIds = Array.isArray(issues) ? issues.map(issue => objectRecord(issue)?.['id']).filter(id => typeof id === 'string').sort() : []
    const repairCheckpoints = prior.filter(item => item.kind === 'repair' || item.kind === 'awaiting_user')
    const equivalent = repairCheckpoints.slice(-graph.terminationPolicy.noProgressLimit)
      .every(item => JSON.stringify((item.issues ?? []).map(issue => issue.id).sort()) === JSON.stringify(issueIds))
      && repairCheckpoints.length >= graph.terminationPolicy.noProgressLimit
    const awaiting = decision === 'needs-user' || repairCheckpoints.length >= graph.terminationPolicy.maxRepairRevisions || equivalent
    const checkpoint: GraphCheckpoint = {
      id: GraphCheckpointId(stableId('checkpoint', [run.id, node.id, iteration])),
      graphId: graph.graphId,
      revision: graph.revision,
      runId: run.id,
      nodeId: node.id,
      kind: awaiting ? 'awaiting_user' : 'repair',
      status: 'pending',
      createdAt: Date.now(),
      iteration,
      reason: awaiting
        ? `Review node ${node.id} requires human adjudication or reached a repair termination rule.`
        : `Review node ${node.id} rejected the current implementation and requested a repair revision.`,
      issues: issues ?? [],
    }
    validateGraphCheckpoint(checkpoint, projection)
    return { checkpoint, phase: awaiting ? 'awaiting_user' : 'paused' }
  }

  private async drive(
    agent: Agent,
    graph: GraphRevision,
    initial: GraphRun,
    config: GraphModeConfig,
    signal: AbortSignal,
    ancestry: readonly GraphId[] = [graph.graphId],
    runtimeInput?: Readonly<Record<string, unknown>>,
    notify = true,
    authoritySignal?: AbortSignal,
  ): Promise<void> {
    let current: GraphRun = initial
    const wallClock = AbortSignal.timeout(graph.terminationPolicy.maxWallTimeMs)
    const executionSignal = AbortSignal.any([signal, wallClock])
    const active = new Map<GraphNodeId, Promise<void>>()
    let pauseRequest: GraphPauseRequest | undefined
    let acceptingNodeUpdates = true
    const assertAuthority = (): void => { authoritySignal?.throwIfAborted() }
    const publish = (next: GraphRun): void => {
      assertAuthority()
      current = appendRunUpdate(agent, current, next)
    }
    const updateNode = (id: GraphNodeId, replacement: GraphNodeRun): void => {
      // A stopped scheduler execution may still receive a queued Worker-monitor callback.
      // Terminal, paused, or authority-lost state is immutable after this closes.
      /* v8 ignore next -- active-task draining owns the observable path; this contains callbacks already queued outside that task. */
      if (!acceptingNodeUpdates) return
      publish({ ...current, phase: 'running', updatedAt: Date.now(), nodes: { ...current.nodes, [id]: replacement } })
    }
    const drainActive = async (reason: unknown): Promise<void> => {
      for (const id of active.keys()) this.nodeAborts.get(`${current.id}\u0000${id}`)?.abort(reason)
      await Promise.allSettled([...active.values()])
    }
    try {
      publish({ ...current, phase: 'running', updatedAt: Date.now() })
      while (true) {
        executionSignal.throwIfAborted()
        const externalPause = this.pauseRequests.get(current.id)
        if (externalPause !== undefined) {
          this.pauseRequests.delete(current.id)
          pauseRequest = { checkpoint: externalPause, phase: 'awaiting_user' }
        }
        if (pauseRequest !== undefined) {
          const requested = pauseRequest
          await drainActive(new Error(`graph run paused at checkpoint ${requested.checkpoint.id}`))
          acceptingNodeUpdates = false
          if (requested.phase === 'paused') {
            publish({ ...current, phase: 'paused', updatedAt: Date.now() })
          } else {
            const nodes = Object.fromEntries(Object.entries(current.nodes).map(([id, state]) => [
              id,
              terminalNodePhase(state.phase) ? state : { ...state, phase: requested.phase === 'awaiting_user' ? 'awaiting_user' as const : 'exhausted' as const },
            ]))
            const now = Date.now()
            publish(requested.phase === 'awaiting_user'
              ? { ...current, phase: 'awaiting_user', updatedAt: now, nodes }
              : { ...current, phase: 'exhausted', updatedAt: now, nodes, terminal: { outcome: 'exhausted', rule: 'dynamic-or-repair-policy-exhausted', acceptedAt: now } })
          }
          break
        }
        for (const node of graph.nodes) {
          const state = current.nodes[node.id] as GraphNodeRun
          if (state.phase !== 'pending') continue
          const incoming = graph.edges.filter(edge => edge.to === node.id)
          const predecessors = incoming.map(edge => current.nodes[edge.from])
          if (predecessors.some(predecessor => ['pending', 'ready', 'running', 'awaiting_user'].includes((predecessor as GraphNodeRun).phase))) continue
          const failedDependency = incoming.some((edge, index) => {
            const predecessor = predecessors[index] as GraphNodeRun
            return predecessor.phase !== 'succeeded'
              && !(predecessor.phase === 'skipped' && edge.kind === 'control')
              && edge.kind !== 'conditional'
          })
          if (failedDependency || incoming.some((_edge, index) => predecessors[index]?.phase === 'failed')) {
            updateNode(node.id, { ...state, phase: 'canceled' })
            continue
          }
          const branchEvaluation = evaluateGraphBranchEvidence(graph, current, node.id)
          if (branchEvaluation.decision === 'ambiguous') {
            updateNode(node.id, { ...state, phase: 'blocked', branchEvaluation })
            continue
          }
          if (branchEvaluation.decision === 'inactive') {
            updateNode(node.id, { ...state, phase: 'skipped', branchEvaluation })
            continue
          }
          updateNode(node.id, { ...state, phase: 'ready', branchEvaluation })
        }

        const readyNodes = graph.nodes.filter(node => current.nodes[node.id]?.phase === 'ready' && !active.has(node.id))
        const gate = readyNodes.find(node => ['environment', 'expansion', 'review', 'verification'].includes(node.kind))
        for (const node of gate === undefined ? readyNodes : [gate]) {
          const conflicts = [...active.keys()].some((activeId) => {
            const activeNode = graph.nodes.find(item => item.id === activeId)
            return activeNode !== undefined && workspaceWritesConflict(node, activeNode, this.workspaceMode)
          })
          if (conflicts) continue
          const nodeController = new AbortController()
          const nodeKey = `${current.id}\u0000${node.id}`
          this.nodeAborts.set(nodeKey, nodeController)
          const nodeSignal = AbortSignal.any([executionSignal, nodeController.signal])
          const task = this.executeNode(
            agent,
            graph,
            node,
            config,
            nodeSignal,
            () => current,
            () => current.nodes[node.id],
            updateNode,
            (request) => {
              assertAuthority()
              pauseRequest = request
              agent.session.append('graph/checkpoint', request.checkpoint)
            },
            ancestry,
            runtimeInput,
            assertAuthority,
          )
            .finally(() => {
              active.delete(node.id)
              this.nodeAborts.delete(nodeKey)
            })
          active.set(node.id, task)
        }

        if (active.size > 0) {
          await Promise.race(active.values())
          continue
        }
        const phases = Object.values(current.nodes).map(node => node.phase)
        const phase = phases.every(nodePhase => ['succeeded', 'skipped'].includes(nodePhase))
          ? 'succeeded'
          : phases.includes('exhausted') ? 'exhausted' : 'failed'
        /* v8 ignore next -- failed convergence always contains a terminal node attempt error. */
        const error = phase === 'failed'
          ? terminalRunError(current) ?? { code: 'GRAPH_RUN_INCOMPLETE', message: 'graph run ended without completing every required node' }
          : undefined
        const acceptedAt = Date.now()
        acceptingNodeUpdates = false
        publish({
          ...current,
          phase,
          updatedAt: acceptedAt,
          terminal: { outcome: phase, rule: phase === 'succeeded' ? 'all-required-nodes-settled' : phase === 'exhausted' ? 'execution-policy-exhausted' : 'required-node-failed', acceptedAt },
          ...error === undefined ? {} : { error },
        })
        break
      }
    } catch (error) {
      if (authoritySignal?.aborted) {
        await drainActive(authoritySignal.reason)
        acceptingNodeUpdates = false
        this.ctx.logger.warn('dsh-graph-mode: scheduler authority lost for run %s; durable state was left nonterminal for fenced recovery: %o', current.id, authoritySignal.reason)
        return
      }
      const phase = wallClock.aborted && !signal.aborted ? 'exhausted' : signal.aborted ? 'canceled' : 'failed'
      const detail: GraphRunError = error instanceof GraphRunExecutionError
        ? { code: error.code, message: error.message, nodeId: error.nodeId }
        : {
          /* v8 ignore next -- non-aborted execution failures are normalized to GraphRunExecutionError before this catch. */
          code: phase === 'exhausted' ? 'GRAPH_RUN_WALL_TIME_EXHAUSTED' : signal.aborted ? 'GRAPH_RUN_CANCELED' : 'GRAPH_RUN_FAILED',
          message: errorMessage(error),
        }
      await drainActive(error)
      acceptingNodeUpdates = false
      const nodes = Object.fromEntries(Object.entries(current.nodes).map(([id, node]) => [
        id,
        terminalNodePhase(node.phase) ? node : { ...node, phase: phase === 'exhausted' ? 'exhausted' as const : 'canceled' as const },
      ]))
      const acceptedAt = Date.now()
      publish({ ...current, phase, updatedAt: acceptedAt, nodes, error: detail, terminal: { outcome: phase, rule: phase === 'exhausted' ? 'max-wall-time' : phase === 'canceled' ? 'run-aborted' : 'scheduler-failure', acceptedAt } })
      this.ctx.logger.warn('dsh-graph-mode: run %s ended with %s: %o', current.id, phase, error)
    }
    if (!notify) return
    const campaignResult = this.settleCampaignRun(agent, current)
    if (current.phase === 'paused' || current.phase === 'awaiting_user') {
      const checkpoint = pauseRequest?.checkpoint
      let planningContext: string | undefined
      if (checkpoint?.kind === 'planning') {
        const pendingNodes = graph.nodes.filter((node) => {
          const state = current.nodes[node.id]
          return state !== undefined && !['succeeded', 'skipped'].includes(state.phase)
        })
        const pendingWork = await Promise.all(pendingNodes.map(async (node) => {
          const state = current.nodes[node.id] as GraphNodeRun
          const override = current.overrides[node.id]
          const roleId = override?.roleId ?? node.roleId
          const configuredRole = current.configSnapshot.roles.find(item => item.id === roleId)
          let modelProfile: GraphModelExecutionProfile | undefined
          let effectiveBudget = override?.executionBudget ?? node.executionBudget
          let modelProfileError: string | undefined
          if (node.kind === 'environment') {
            modelProfileError = undefined
          } else if (configuredRole === undefined) {
            modelProfileError = `role ${roleId} is not configured`
          } else {
            const role = effectiveGraphRole(configuredRole, override, agent.options)
            if (role.model.provider === undefined || role.model.model === undefined) {
              modelProfileError = 'exact provider and model are unresolved'
            } else {
              try {
                const route = { provider: role.model.provider, model: role.model.model }
                const model = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
                const resources = this.resourceProvider === undefined ? undefined : this.ctx.get('graphResources')
                const live = resources === undefined || this.resourceProvider === undefined
                  ? undefined
                  : await resources.observe(this.resourceProvider, route, signal)
                modelProfile = executionModelProfile(role, current.configSnapshot, model, live)
                effectiveBudget = resolvedExecutionBudget(effectiveBudget, model, live)
              } catch (error) {
                modelProfileError = errorMessage(error)
              }
            }
          }
          return {
            nodeId: node.id,
            kind: node.kind,
            objective: node.objective,
            acceptanceCriteria: node.acceptanceCriteria,
            role: configuredRole?.label ?? roleId,
            model: { ...configuredRole?.model, ...override?.model },
            ...modelProfile === undefined ? {} : { modelProfile },
            ...modelProfileError === undefined ? {} : { modelProfileError },
            workerProvider: override?.workerProvider ?? configuredRole?.workerProvider ?? this.workerProvider,
            executionBudget: effectiveBudget,
            workspace: node.workspace ?? { mode: this.workspaceMode },
            ...node.environment === undefined ? {} : { environment: node.environment },
            latestHealth: state.attempts.at(-1)?.health,
            latestCheckpoint: state.attempts.at(-1)?.checkpoints?.at(-1),
            latestError: state.attempts.at(-1)?.error,
          }
        }))
        planningContext = JSON.stringify({
          completedEvidence: graph.nodes.flatMap((node) => {
            const output = current.nodes[node.id]?.output
            return output === undefined ? [] : [{ nodeId: node.id, kind: node.kind, summary: output.summary, data: output.data }]
          }),
          priorAcceptedEvidence: priorAcceptedPlanningEvidence(this.state(agent), graph, current, pendingNodes),
          pendingWork,
        }).slice(0, graph.terminationPolicy.maxOutputBytes)
      }
      const taskModification = checkpoint !== undefined && taskModificationCheckpoint(checkpoint)
      if (!taskModification) {
        const guidance = checkpoint?.kind === 'environment'
          ? 'Present the exact environment capabilities, sandbox mode, commands, and rollback commands to the user. Wait for the existing checkpoint to be approved or rejected; do not call graph_submit, revise the graph, execute a command, or claim approval.'
          : 'Treat priorAcceptedEvidence as completed work. Preserve its still-valid node ids, semantic definitions, and incoming dependencies so Graph Mode can reuse them. Do not create preserve or baseline-discovery nodes for accepted work. Reconcile the remaining evidence with worker capability and actual repository paths, then submit intent=revise with only missing model-sized tasks or corrected workspace ownership; do not approve unchanged stalled or non-retryable work.'
        agent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: `[graph-planning-checkpoint]\ngraph=${graph.graphId} revision=${graph.revision} run=${current.id} phase=${current.phase}\ncheckpoint=${checkpoint?.id ?? 'unknown'} kind=${checkpoint?.kind ?? 'unknown'}\n${checkpoint?.reason ?? 'Graph execution requires a controller or user decision.'}${planningContext === undefined ? '' : `\nplanningContext=${planningContext}`}\n${guidance}`,
          }],
          source: { kind: 'graph-mode' },
        }))
      }
    } else if (current.phase !== 'canceled') {
      const summaries = graph.nodes.flatMap((node) => {
        const state = current.nodes[node.id]
        return state?.output === undefined ? [] : [`${node.title}: ${state.output.summary}`]
      })
      const errors = current.error === undefined ? [] : [`error=${JSON.stringify(current.error)}`]
      const completionHeader = campaignResult === undefined
        ? '[graph-run-complete]'
        : '[graph-batch-complete]'
      const campaignLines = campaignResult === undefined
        ? []
        : [
          `campaign=${campaignResult.campaign.id} batch=${campaignResult.batchId}`,
          `nextBatch=${campaignResult.nextBatchId ?? 'none'}`,
          campaignResult.nextBatchId === undefined
            ? 'Do not copy historical batch nodes into a revision.'
            : `Create a new graph with intent=new and campaign.batchId=${campaignResult.nextBatchId}; include only that batch's nodes and consume predecessor evidence from the campaign record.`,
        ]
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: [completionHeader, `graph=${graph.graphId} revision=${graph.revision} run=${current.id} phase=${current.phase}`, ...campaignLines, ...errors, ...summaries].join('\n'),
        }],
        source: { kind: 'graph-mode' },
      }))
    }
  }

  private async keepCoordinationLease(
    request: GraphCoordinationHeartbeat,
    claim: GraphCoordinationClaim,
    signal: AbortSignal,
    initialEvidence: string,
    onLease: (claim: GraphCoordinationClaim) => void,
    onProgress: (detail: string) => void,
  ): Promise<void> {
    const coordination = this.ctx.get('graphCoordination')
    if (coordination === undefined) return
    let liveClaim = claim
    const initialSignal = this.externalOperationSignal(signal)
    let cursor = (await this.waitForExternal(coordination.publishProgress({
      ...request,
      claimId: liveClaim.claimId,
      leaseId: liveClaim.leaseId,
      fencingToken: liveClaim.fencingToken,
      evidence: initialEvidence,
    }, initialSignal), initialSignal)).cursor
    signal.throwIfAborted()
    onProgress(initialEvidence)
    while (!signal.aborted) {
      const untilRenewal = Math.max(100, Math.floor((liveClaim.expiresAt - Date.now()) / 3))
      if (!await waitForHeartbeat(Math.min(this.coordinationHeartbeatMs, untilRenewal), signal)) return
      const operationSignal = this.externalOperationSignal(signal)
      const heartbeat = await this.waitForExternal(coordination.heartbeat({
        ...request,
        claimId: liveClaim.claimId,
        leaseId: liveClaim.leaseId,
        fencingToken: liveClaim.fencingToken,
      }, operationSignal), operationSignal)
      if (heartbeat.fencingToken < liveClaim.fencingToken
        || (heartbeat.fencingToken === liveClaim.fencingToken && heartbeat.leaseId !== liveClaim.leaseId)) {
        throw new Error('coordination heartbeat returned a stale or conflicting lease identity')
      }
      if (heartbeat.cancelRequested) throw new Error('coordination provider requested worker cancellation')
      liveClaim = { ...liveClaim, leaseId: heartbeat.leaseId, expiresAt: heartbeat.expiresAt, fencingToken: heartbeat.fencingToken }
      onLease(liveClaim)
      signal.throwIfAborted()
      const watchTimeout = AbortSignal.timeout(Math.max(
        100,
        Math.min(this.coordinationHeartbeatMs, Math.floor((liveClaim.expiresAt - Date.now()) / 6)),
      ))
      const watchSignal = AbortSignal.any([signal, watchTimeout])
      let observation: GraphCoordinationObservation
      try {
        observation = await this.waitForExternal(coordination.watch({
          protocolVersion: 3,
          workId: request.workId,
          activationId: request.activationId,
          cwd: request.cwd,
          callerId: request.callerId,
          afterCursor: cursor,
        }, watchSignal), watchSignal)
        signal.throwIfAborted()
      } catch (error) {
        if (watchTimeout.aborted) continue
        throw error
      }
      cursor = observation.cursor
      const events = observation.events.filter(event => ['progress', 'cancel-requested', 'terminal'].includes(event.kind)).slice(-8)
      if (events.length > 0 || observation.compacted) {
        const detail = JSON.stringify({ status: observation.status, cursor: observation.cursor, compacted: observation.compacted, events })
        onProgress(detail.length <= 2_000 ? detail : `${detail.slice(0, 1_999)}…`)
      }
      if (observation.status === 'cancel-requested') throw new Error('coordination provider requested worker cancellation')
      if (observation.status === 'terminal') throw new Error('coordination provider accepted a terminal result while the worker was active')
    }
  }

  private async latestCoordinationLease(
    coordination: GraphCoordination,
    request: GraphCoordinationObserveRequest,
    expected: Pick<GraphCoordinationClaim, 'claimId' | 'leaseId' | 'fencingToken'>,
    signal: AbortSignal,
  ): Promise<Pick<GraphCoordinationClaim, 'claimId' | 'leaseId' | 'fencingToken' | 'expiresAt'>> {
    const observed = await this.waitForExternal(coordination.observe(request, signal), signal)
    const current = observed.claim
    if (current === undefined) return { ...expected, expiresAt: 0 }
    if (current.claimId !== expected.claimId) {
      throw new Error(`coordination observation replaced claim ${expected.claimId} with ${current.claimId}`)
    }
    if (current.fencingToken < expected.fencingToken
      || (current.fencingToken === expected.fencingToken && current.leaseId !== expected.leaseId)) {
      throw new Error(`coordination observation returned a stale or conflicting lease for claim ${expected.claimId}`)
    }
    return current
  }

  private async executeSubgraphNode(
    agent: Agent,
    graph: GraphRevision,
    node: GraphNode,
    config: GraphModeConfig,
    signal: AbortSignal,
    ancestry: readonly GraphId[],
    readRun: () => GraphRun,
    read: () => GraphNodeRun | undefined,
    update: (id: GraphNodeId, state: GraphNodeRun) => void,
    requestPause: (request: GraphPauseRequest) => void,
    assertAuthority: () => void,
  ): Promise<void> {
    const spec = node.subgraph as NonNullable<GraphNode['subgraph']>
    if (ancestry.includes(spec.graphId)) throw new Error(`subgraph ancestry cycle through ${spec.graphId}`)
    if (ancestry.length >= graph.terminationPolicy.maxSubgraphDepth) throw new Error('subgraph depth exceeds the resolved termination policy')
    const child = this.state(agent).graphs[spec.graphId]?.find(item => item.revision === spec.revision)
    if (child === undefined) throw new Error(`subgraph ${spec.graphId} revision ${String(spec.revision)} is unavailable`)
    const predecessorOutputs = Object.fromEntries(
      graph.edges.filter(edge => edge.to === node.id).map(edge => [edge.from, readRun().nodes[edge.from]?.output]),
    )
    const sourceInput = { predecessors: predecessorOutputs, graph: { id: graph.graphId, revision: graph.revision }, node: node.id }
    const runtimeInput = Object.fromEntries(Object.entries(spec.input).map(([key, path]) => [key, valueAt(sourceInput, path)]))
    const parentRun = readRun()
    const before = read() as GraphNodeRun
    const attemptNumber = before.attempts.length + 1
    const attempt = { id: GraphAttemptId(randomUUID()), number: attemptNumber, startedAt: Date.now() }
    assertAuthority()
    this.appendOperation(agent, parentRun, node, 'admitted')
    update(node.id, { ...before, phase: 'running', attempts: [...before.attempts, attempt] })
    const childOwnership = await this.ownRun(
      agent,
      this.initialRun(agent, child, child.nodes.map(item => item.id), undefined, config),
      signal,
    )
    const childRun = childOwnership.run
    assertAuthority()
    agent.session.append('graph/run', childRun)
    for (const childNode of child.nodes) {
      assertAuthority()
      this.appendOperation(agent, childRun, childNode, 'planned')
    }
    const running = read() as GraphNodeRun
    update(node.id, {
      ...running,
      attempts: running.attempts.map(item => item.id === attempt.id ? { ...item, childRunId: childRun.id } : item),
    })
    assertAuthority()
    this.appendOperation(agent, readRun(), node, 'started', undefined, {
      references: [{ kind: 'worker', provider: 'graph-subgraph', id: childRun.id }],
    })
    const controller = new AbortController()
    const childSignal = AbortSignal.any([signal, controller.signal])
    this.aborts.set(childRun.id, controller)
    const execution = this.driveOwned(
      agent,
      child,
      childRun,
      config,
      childSignal,
      childOwnership.lease,
      [...ancestry, child.graphId],
      runtimeInput,
      false,
    ).finally(() => {
      this.aborts.delete(childRun.id)
      this.executions.delete(childRun.id)
    })
    this.executions.set(childRun.id, execution)
    await execution
    const finishedChild = this.state(agent).runs[childRun.id] as GraphRun
    if (finishedChild.phase === 'paused' || finishedChild.phase === 'awaiting_user') {
      const parentState = read() as GraphNodeRun
      update(node.id, { ...parentState, phase: 'awaiting_user' })
      const checkpoint: GraphCheckpoint = {
        id: GraphCheckpointId(stableId('checkpoint', [parentRun.id, node.id, finishedChild.generation, 'subgraph'])),
        graphId: graph.graphId,
        revision: graph.revision,
        runId: parentRun.id,
        nodeId: node.id,
        kind: 'planning',
        status: 'pending',
        createdAt: Date.now(),
        iteration: 1,
        reason: `Nested graph ${child.graphId} revision ${String(child.revision)} requires a controller or user decision.`,
      }
      validateGraphCheckpoint(checkpoint, this.state(agent))
      requestPause({ checkpoint, phase: finishedChild.phase })
      return
    }
    if (finishedChild.phase !== 'succeeded') throw new Error(`nested graph ${child.graphId} ended with ${finishedChild.phase}`)
    const aggregate = {
      nodes: Object.fromEntries(child.nodes.map(item => [item.id, finishedChild.nodes[item.id]?.output])),
      terminal: finishedChild.terminal,
    }
    const mapped = Object.fromEntries(Object.entries(spec.output).map(([key, path]) => [key, valueAt(aggregate, path)]))
    const output: GraphNodeOutput = {
      summary: `Nested graph ${child.graphId} revision ${String(child.revision)} succeeded.`,
      data: mapped as GraphJsonValue,
      artifacts: child.nodes.flatMap(item => finishedChild.nodes[item.id]?.output?.artifacts ?? []),
    }
    validateGraphNodeOutput(output, node.outputSchema)
    assertAuthority()
    this.appendOperation(agent, readRun(), node, 'output-staged', undefined, { outputHash: outputHashOf(output) })
    const finished = read() as GraphNodeRun
    update(node.id, {
      ...finished,
      phase: 'succeeded',
      output,
      attempts: finished.attempts.map(item => item.id === attempt.id ? { ...item, finishedAt: Date.now() } : item),
    })
    assertAuthority()
    this.appendOperation(agent, readRun(), node, 'terminal', undefined, { terminalOutcome: 'succeeded' })
  }

  private async materializeArtifacts(
    agent: Agent,
    node: GraphNode,
    run: GraphRun,
    sourceRoot: string,
    manifests: readonly GraphArtifactManifest[],
    signal: AbortSignal,
  ): Promise<void> {
    if (manifests.length === 0) return
    const artifacts = this.ctx.get('graphArtifacts')
    if (artifacts === undefined) {
      throw new GraphRunExecutionError('GRAPH_ARTIFACT_SERVICE_MISSING', node.id, new Error('isolated artifact integration requires graph-artifacts'))
    }
    const paths = new Map<string, { readonly sha256: string; readonly baseSha256: string | null }>()
    for (const manifest of manifests) {
      for (const entry of manifest.entries) {
        if (entry.kind !== 'file') {
          throw new GraphRunExecutionError('GRAPH_ARTIFACT_KIND_UNSUPPORTED', node.id, new Error(`cannot integrate ${entry.kind} artifact ${entry.path}`))
        }
        if (entry.baseSha256 === undefined) {
          throw new GraphRunExecutionError('GRAPH_ARTIFACT_BASE_MISSING', node.id, new Error(`artifact ${entry.path} lacks its source content hash`))
        }
        const previous = paths.get(entry.path)
        if (previous !== undefined && (previous.sha256 !== entry.sha256 || previous.baseSha256 !== entry.baseSha256)) {
          throw new GraphRunExecutionError('GRAPH_ARTIFACT_CONFLICT', node.id, new Error(`multiple predecessor artifacts changed ${entry.path} differently`))
        }
        paths.set(entry.path, { sha256: entry.sha256, baseSha256: entry.baseSha256 })
      }
    }
    for (const [path, expected] of paths) {
      const actual = workspaceContentHash(sourceRoot, path)
      if (actual !== expected.baseSha256 && actual !== expected.sha256) {
        throw new GraphRunExecutionError('GRAPH_ARTIFACT_SOURCE_DRIFT', node.id, new Error(`integration target ${path} changed after the isolated workspace was copied`))
      }
    }
    for (const manifest of manifests) {
      if (manifest.entries.every(entry => workspaceContentHash(sourceRoot, entry.path) === entry.sha256)) continue
      const externalReference = { kind: 'artifact' as const, provider: manifest.provider, id: String(manifest.id) }
      const pending = this.beginSettlement(agent, {
        id: settlementIdOf(run.nodes[node.id]?.workId as GraphWorkId, run.generationId, `artifact-integration:${String(manifest.id)}`),
        operationId: operationIdOf(run.nodes[node.id]?.workId as GraphWorkId, run.generationId),
        workId: run.nodes[node.id]?.workId as GraphWorkId,
        runId: run.id,
        generationId: run.generationId,
        ownerEpoch: run.ownerEpoch,
        kind: 'artifact',
        externalReference,
      })
      if (pending === undefined) continue
      await this.flushBeforeExternal(agent, signal)
      try {
        const result = await artifacts.materialize(manifest.provider, {
          manifest,
          targetRoot: sourceRoot,
          overwrite: 'replace',
          signal,
        })
        agent.session.append('graph/settlement', {
          ...pending,
          outcome: 'confirmed',
          completedAt: Date.now(),
          evidence: `materialized ${String(result.paths.length)} files (${String(result.totalBytes)} bytes) into the integration workspace`,
        })
      } catch (error) {
        agent.session.append('graph/settlement', {
          ...pending,
          outcome: 'failed',
          completedAt: Date.now(),
          error: { code: 'GRAPH_ARTIFACT_MATERIALIZE_FAILED', message: errorMessage(error) },
        })
        throw new GraphRunExecutionError('GRAPH_ARTIFACT_MATERIALIZE_FAILED', node.id, error)
      }
    }
  }

  private async executeNode(
    agent: Agent,
    graph: GraphRevision,
    node: GraphNode,
    config: GraphModeConfig,
    signal: AbortSignal,
    readRun: () => GraphRun,
    read: () => GraphNodeRun | undefined,
    update: (id: GraphNodeId, state: GraphNodeRun) => void,
    requestPause: (request: GraphPauseRequest) => void,
    ancestry: readonly GraphId[],
    runtimeInput?: Readonly<Record<string, unknown>>,
    assertAuthority: () => void = () => {},
  ): Promise<void> {
    const appendOperation = (...args: Parameters<GraphModeController['appendOperation']>): void => {
      assertAuthority()
      this.appendOperation(...args)
    }
    const appendSettlement = (record: GraphSettlementRecord): void => {
      assertAuthority()
      agent.session.append('graph/settlement', record)
    }
    if (node.kind === 'environment') {
      const run = readRun()
      if (this.environmentAuthorization(agent, run, node) === undefined) {
        requestPause({
          checkpoint: this.environmentApprovalCheckpoint(agent, graph, run, node),
          phase: 'awaiting_user',
        })
        return
      }
      await this.executeEnvironmentNode(agent, node, signal, readRun, read, update, assertAuthority)
      return
    }
    if (node.kind === 'subgraph') {
      try {
        await this.executeSubgraphNode(
          agent, graph, node, config, signal, ancestry,
          readRun, read, update, requestPause, assertAuthority,
        )
      } catch (error) {
        assertAuthority()
        const state = read() as GraphNodeRun
        const now = Date.now()
        const detail = { code: 'GRAPH_SUBGRAPH_FAILED', message: errorMessage(error) }
        const attempts = state.attempts.length === 0
          ? [{ id: GraphAttemptId(randomUUID()), number: 1, startedAt: now, finishedAt: now, error: detail }]
          : state.attempts.map((item, index, values) => index === values.length - 1 ? { ...item, finishedAt: now, error: detail } : item)
        update(node.id, { ...state, phase: 'failed', attempts })
        const head = this.state(agent).operations[state.workId]?.at(-1)
        if (head?.stage !== 'terminal') appendOperation(agent, readRun(), node, 'terminal', undefined, { terminalOutcome: 'failed', detail: detail.message })
      }
      return
    }
    const override = readRun().overrides[node.id]
    const roleId = override?.roleId ?? node.roleId
    const role = config.roles.find(candidate => candidate.id === roleId && candidate.enabled && !candidate.controller) as GraphRole
    const predecessors = graph.edges.filter(edge => edge.to === node.id).map(edge => ({
      nodeId: edge.from,
      output: readRun().nodes[edge.from]?.output,
    }))
    const firstAttempt = (read()?.attempts.length ?? 0) + 1
    for (let attemptNumber = firstAttempt; attemptNumber <= node.maxAttempts; attemptNumber++) {
      const effectiveRole = effectiveGraphRole(role, override, agent.options)
      const modelProvider = effectiveRole.model.provider
      const modelId = effectiveRole.model.model
      if (modelProvider === undefined || modelId === undefined) {
        throw new GraphRunExecutionError('GRAPH_MODEL_PROFILE_UNRESOLVED', node.id, new Error('Graph Worker dispatch requires an exact provider and model'))
      }
      let resolvedModel: LlmResolvedModelInfo
      try {
        resolvedModel = await this.ctx.llm.resolveModelInfo(modelProvider, modelId, signal)
      } catch (error) {
        throw new GraphRunExecutionError('GRAPH_MODEL_PROFILE_INVALID', node.id, error)
      }
      const selectedReasoning = effectiveRole.model.reasoningEffort
      if (selectedReasoning !== undefined
        && !resolvedModel.reasoning?.efforts.some(effort => effort.id === selectedReasoning)) {
        throw new GraphRunExecutionError(
          'GRAPH_MODEL_REASONING_UNSUPPORTED',
          node.id,
          new Error(`model ${modelProvider}/${modelId} does not expose reasoning effort ${selectedReasoning}`),
        )
      }
      const workerProvider = override?.workerProvider ?? effectiveRole.workerProvider ?? this.workerProvider
      const release = await this.admission.acquire(effectiveRole, config, node.weight, signal)
      const startedAt = Date.now()
      const coordination = this.ctx.get('graphCoordination')
      const cwd = agent.session.header.cwd
      const activeRun = readRun()
      const activeNode = activeRun.nodes[node.id] as GraphNodeRun
      const resourceOperationId = GraphControlOperationId(stableId('operation', [
        activeNode.workId,
        activeRun.generationId,
        'model-reservation',
        attemptNumber,
      ]))
      const resources = this.resourceProvider === undefined ? undefined : this.ctx.get('graphResources')
      let resourceReservation: GraphResourceReservation | undefined
      let resourceSnapshot: GraphResourceSnapshot | undefined
      let claim: GraphCoordinationClaim | undefined
      let attempt: GraphAttempt & {
        readonly executionBudget: GraphNodeExecutionBudget
        readonly modelProfile: GraphModelExecutionProfile
      }
      const coordinationRequest = {
        protocolVersion: 3 as const,
        graph,
        node,
        role: effectiveRole,
        runId: activeRun.id,
        cwd: cwd as string,
        workId: activeNode.workId,
        activationId: activationIdOf(activeNode.workId, activeRun.generationId),
        ownerEpoch: activeRun.ownerEpoch,
        operationId: operationIdOf(activeNode.workId, activeRun.generationId),
        callerId: agent.id,
      }
      try {
        try {
          if (this.resourceProvider !== undefined) {
            if (resources === undefined) {
              throw new GraphRunExecutionError('GRAPH_RESOURCE_SERVICE_MISSING', node.id, new Error(`resource provider ${this.resourceProvider} is configured without graph-resources`))
            }
            appendOperation(agent, activeRun, node, 'admitted', undefined, {
              detail: `model reservation requested for ${modelProvider}/${modelId}`,
            })
            await this.flushBeforeExternal(agent, signal)
            const model = modelId
            const configuredLimit = configuredModelLimit(config, effectiveRole)
            const deadline = startedAt + graph.terminationPolicy.maxWallTimeMs
            while (resourceReservation === undefined) {
              const requestedAt = Date.now()
              if (requestedAt >= deadline) {
                throw new GraphRunExecutionError('GRAPH_RESOURCE_WAIT_EXHAUSTED', node.id, new Error('live model-resource admission exceeded the graph wall-time limit'))
              }
              const operationSignal = this.externalOperationSignal(signal)
              const decision = await this.waitForExternal(resources.reserve(this.resourceProvider, {
                protocolVersion: 1,
                ...effectiveRole.model.provider === undefined ? {} : { provider: effectiveRole.model.provider },
                model,
                workId: activeNode.workId,
                operationId: resourceOperationId,
                ownerEpoch: activeRun.ownerEpoch,
                weight: node.weight,
                hardMaxParallel: Math.min(effectiveRole.maxParallel, configuredLimit?.maxParallel ?? config.limits.globalMaxParallel),
                ...configuredLimit?.maxWeight === undefined ? {} : { hardMaxWeight: configuredLimit.maxWeight },
                requestedAt,
                deadline,
              }, operationSignal), operationSignal)
              if (decision.status === 'granted') {
                resourceReservation = decision.reservation
                resourceSnapshot = decision.reservation.snapshot
                break
              }
              if (decision.status === 'rejected') {
                throw new GraphRunExecutionError('GRAPH_RESOURCE_REJECTED', node.id, new Error(`model resource route rejected: ${decision.reason}`))
              }
              const waiting = read() as GraphNodeRun
              update(node.id, {
                ...waiting,
                resourceWait: {
                  providerId: decision.snapshot.providerId,
                  model: decision.snapshot.model,
                  reason: decision.reason,
                  observedAt: decision.snapshot.observedAt,
                  retryAt: decision.retryAt,
                },
              })
              await waitForHeartbeat(Math.min(decision.retryAt - requestedAt, deadline - requestedAt), signal)
              signal.throwIfAborted()
            }
          }
        } catch (error) {
          throw error instanceof GraphRunExecutionError
            ? error
            : new GraphRunExecutionError('GRAPH_RESOURCE_ADMISSION_FAILED', node.id, error)
        }
        if (resourceReservation === undefined) {
          appendOperation(agent, activeRun, node, 'admitted')
        } else {
          appendOperation(agent, activeRun, node, 'progress', undefined, {
            references: [{ kind: 'model', provider: resourceReservation.providerId, id: resourceReservation.id, fencingToken: resourceReservation.fencingToken }],
            detail: `model reservation ${resourceReservation.id} granted`,
          })
        }
        await this.flushBeforeExternal(agent, signal)
        try {
          const operationSignal = this.externalOperationSignal(signal)
          const disposition = coordination === undefined
            ? undefined
            : await this.waitForExternal(coordination.claim(coordinationRequest, operationSignal), operationSignal)
          if (disposition?.terminal !== undefined) {
            throw new GraphRunExecutionError(
              'GRAPH_COORDINATION_ALREADY_TERMINAL',
              node.id,
              new Error(`coordination activation already settled as ${disposition.terminal.outcome}: ${disposition.terminal.evidence}`),
            )
          }
          claim = disposition
          if (claim !== undefined) {
            appendOperation(agent, readRun(), node, 'claimed', undefined, {
              references: [
                { kind: 'coordination', provider: 'graph-coordination', id: claim.claimId },
                { kind: 'coordination', provider: 'graph-coordination-lease', id: claim.leaseId, fencingToken: claim.fencingToken },
              ],
            })
          }
        } catch (error) {
          throw error instanceof GraphRunExecutionError
            ? error
            : new GraphRunExecutionError('GRAPH_COORDINATION_CLAIM_FAILED', node.id, error)
        }
        attempt = {
          id: GraphAttemptId(randomUUID()),
          number: attemptNumber,
          startedAt,
          executionBudget: resolvedExecutionBudget(override?.executionBudget ?? node.executionBudget, resolvedModel, resourceSnapshot),
          modelProfile: executionModelProfile(effectiveRole, config, resolvedModel, resourceSnapshot),
          ...claim === undefined ? {} : { loopxClaimId: claim.claimId },
        }
        const before = read() as GraphNodeRun
        const { resourceWait: _resourceWait, ...admittedBefore } = before
        update(node.id, { ...admittedBefore, phase: 'running', attempts: [...before.attempts, attempt] })
        await this.flushBeforeExternal(agent, signal)
      } catch (error) {
        let cleanupError: unknown
        try {
          assertAuthority()
          try {
            if (coordination !== undefined && claim !== undefined) {
              const settlement = this.beginSettlement(agent, {
                id: settlementIdOf(activeNode.workId, activeRun.generationId, `coordination:${claim.claimId}`),
                operationId: coordinationRequest.operationId,
                workId: activeNode.workId,
                runId: activeRun.id,
                generationId: activeRun.generationId,
                ownerEpoch: activeRun.ownerEpoch,
                kind: 'coordination',
                externalReference: { kind: 'coordination', provider: 'graph-coordination', id: claim.claimId },
              })
              if (settlement !== undefined) {
                try {
                  await this.flushBeforeExternal(agent, this.externalOperationSignal())
                } catch (flushError) {
                  cleanupError = flushError
                  this.ctx.logger.warn('dsh-graph-mode: durability flush failed before pre-dispatch coordination cleanup for node %s: %o', node.id, flushError)
                }
                try {
                  const currentLease = await this.latestCoordinationLease(coordination, {
                    protocolVersion: 3,
                    workId: activeNode.workId,
                    activationId: coordinationRequest.activationId,
                    cwd: cwd as string,
                    callerId: agent.id,
                  }, claim, this.externalOperationSignal())
                  const evidence = `dsh graph node ${node.id} stopped before Worker dispatch: ${errorMessage(error)}`
                  const settlementSignal = this.externalOperationSignal()
                  await this.waitForExternal(coordination.settle({
                    ...coordinationRequest,
                    claimId: currentLease.claimId,
                    leaseId: currentLease.leaseId,
                    fencingToken: currentLease.fencingToken,
                    settlementId: settlement.id,
                    outcome: signal.aborted ? 'canceled' : 'failed',
                    evidence,
                  }, settlementSignal), settlementSignal)
                  appendSettlement({ ...settlement, outcome: 'confirmed', completedAt: Date.now(), evidence })
                } catch (settlementError) {
                  cleanupError = settlementError
                  appendSettlement({
                    ...settlement,
                    outcome: 'failed',
                    completedAt: Date.now(),
                    error: { code: 'GRAPH_COORDINATION_WRITEBACK_FAILED', message: errorMessage(settlementError) },
                  })
                }
              }
            }
          } catch (settlementError) {
            cleanupError = settlementError
            this.ctx.logger.warn('dsh-graph-mode: pre-dispatch coordination cleanup failed for node %s: %o', node.id, settlementError)
          }
          try {
            if (resourceReservation !== undefined) {
              const settlement = this.beginSettlement(agent, {
                id: settlementIdOf(activeNode.workId, activeRun.generationId, `resource-release:${resourceReservation.id}`),
                operationId: coordinationRequest.operationId,
                workId: activeNode.workId,
                runId: activeRun.id,
                generationId: activeRun.generationId,
                ownerEpoch: activeRun.ownerEpoch,
                kind: 'resource-release',
                externalReference: {
                  kind: 'model', provider: resourceReservation.providerId, id: resourceReservation.id,
                  fencingToken: resourceReservation.fencingToken,
                },
              })
              if (settlement !== undefined) {
                try {
                  await this.flushBeforeExternal(agent, this.externalOperationSignal())
                } catch (flushError) {
                  cleanupError ??= flushError
                  this.ctx.logger.warn('dsh-graph-mode: durability flush failed before pre-dispatch resource cleanup for node %s: %o', node.id, flushError)
                }
                try {
                  if (resources === undefined) throw new Error('graph-resources disappeared before reservation release')
                  const settlementSignal = this.externalOperationSignal()
                  await this.waitForExternal(resources.report({
                    reservationId: resourceReservation.id,
                    providerId: resourceReservation.providerId,
                    workId: resourceReservation.workId,
                    ownerEpoch: resourceReservation.ownerEpoch,
                    fencingToken: resourceReservation.fencingToken,
                    outcome: 'released',
                    at: Date.now(),
                    evidence: `Worker dispatch did not start: ${errorMessage(error)}`,
                  }, settlementSignal), settlementSignal)
                  appendSettlement({
                    ...settlement,
                    outcome: 'confirmed',
                    completedAt: Date.now(),
                    evidence: `model reservation ${resourceReservation.id} released before Worker dispatch`,
                  })
                } catch (settlementError) {
                  cleanupError ??= settlementError
                  appendSettlement({
                    ...settlement,
                    outcome: 'failed',
                    completedAt: Date.now(),
                    error: { code: 'GRAPH_RESOURCE_RELEASE_FAILED', message: errorMessage(settlementError) },
                  })
                }
              }
            }
          } catch (settlementError) {
            cleanupError ??= settlementError
            this.ctx.logger.warn('dsh-graph-mode: pre-dispatch resource cleanup failed for node %s: %o', node.id, settlementError)
          }
          const normalized = cleanupError === undefined
            ? error instanceof GraphRunExecutionError
              ? error
              : new GraphRunExecutionError(signal.aborted ? 'GRAPH_NODE_CANCELED' : 'GRAPH_NODE_ADMISSION_FAILED', node.id, error)
            : new GraphRunExecutionError('GRAPH_PRE_DISPATCH_CLEANUP_FAILED', node.id, cleanupError)
          const stopped = read() as GraphNodeRun
          update(node.id, { ...stopped, phase: signal.aborted ? 'canceled' : 'failed' })
          appendOperation(agent, readRun(), node, 'terminal', undefined, {
            terminalOutcome: signal.aborted ? 'canceled' : 'failed',
            detail: normalized.message,
          })
          throw normalized
        } finally {
          release()
        }
      }
      const heartbeatStop = new AbortController()
      const heartbeatFailure = new AbortController()
      const effectiveBudget = attempt.executionBudget
      const nodeWallClock = AbortSignal.timeout(effectiveBudget.maxWallTimeMs)
      let heartbeatError: unknown
      let resourceSettlementAttempted = false
      let resourceFailureOutcome: 'capacity' | 'oom' | 'rate-limited' | 'worker-lost' = 'worker-lost'
      let resourceRetryAfterMs: number | undefined
      const heartbeatTask = claim === undefined
        ? Promise.resolve()
        : this.keepCoordinationLease({
          ...coordinationRequest,
          claimId: claim.claimId,
          leaseId: claim.leaseId,
          fencingToken: claim.fencingToken,
          progressSequence: (attemptNumber - 1) * 2 + 1,
        }, claim, heartbeatStop.signal, `Graph node ${node.id} attempt ${String(attemptNumber)} admitted to worker ${workerProvider}.`, (nextClaim) => {
          claim = nextClaim
          appendOperation(agent, readRun(), node, 'progress', undefined, {
            detail: `Coordination lease renewed through ${new Date(nextClaim.expiresAt).toISOString()}.`,
            references: [{
              kind: 'coordination',
              provider: 'graph-coordination-lease',
              id: nextClaim.leaseId,
              fencingToken: nextClaim.fencingToken,
            }],
          })
        }, (detail) => {
          appendOperation(agent, readRun(), node, 'progress', undefined, { detail })
        }).catch((error: unknown) => {
          if (heartbeatStop.signal.aborted) return
          heartbeatError = error
          heartbeatFailure.abort(error)
        })
      const workerSignal = AbortSignal.any([signal, heartbeatFailure.signal, nodeWallClock])
      const workerKey = `${readRun().id}\u0000${node.id}`
      try {
        const upstream = new Set<GraphNodeId>()
        const queue = graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
        while (queue.length > 0) {
          const id = queue.shift() as GraphNodeId
          if (upstream.has(id)) continue
          upstream.add(id)
          queue.push(...graph.edges.filter(edge => edge.to === id).map(edge => edge.from))
        }
        const manifests = [...upstream].flatMap((id) => {
          const manifest = readRun().nodes[id]?.attempts.at(-1)?.artifactManifest
          return manifest === undefined ? [] : [manifest as unknown as GraphArtifactManifest]
        })
        await this.materializeArtifacts(agent, node, readRun(), cwd as string, manifests, workerSignal)
        const controlOutput = node.kind === 'review' || node.kind === 'verification'
          ? '\nThis is a control node. Set data.decision to approved, rejected, or needs-user. Always set data.issues to an array; each issue requires id, blocking or non-blocking severity, summary, evidence strings, and ownerNodeIds.'
          : ''
        const capacityProtocol = `\nActive subagent capacity: this Worker and every in-process descendant share the Graph run ceiling of ${String(graphActiveSubagentLimit(config))}. Do not retry CAPACITY_EXHAUSTED. Return remaining work so the controller can split it into smaller sequential Graph nodes.`
        const executionProtocol = capacityProtocol + (node.kind === 'review' || node.kind === 'verification'
          ? ''
          : '\nExecution protocol: keep the visible plan brief; perform a file read, edit, write, or focused verification early; persist one coherent deliverable before planning another; verify each persisted increment; and do not draft several complete files in hidden reasoning before using tools. Hidden reasoning and failed verification are not recoverable progress. If a Windows sandboxed dependency or build command fails with spawn EPERM because piped process I/O is unavailable, retry that exact command once through the tool\'s narrow sandbox-escalation option with a justification. Do not patch dependencies, package-manager caches, or build tools to evade the sandbox.')
        const workspaceMode = node.workspace?.mode ?? this.workspaceMode
        const workspaceReadRoots = node.workspace?.readRoots ?? ['.']
        const workspaceWriteRoots = node.workspace?.writeRoots ?? (workspaceMode === 'read-only-snapshot' ? [] : ['.'])
        const workspaceProtocol = `\nWorkspace policy: mode=${workspaceMode}; readRoots=${JSON.stringify(workspaceReadRoots)}; writeRoots=${JSON.stringify(workspaceWriteRoots)}. Treat these as exact source-relative paths inside the current runtime workspace. Paths mentioned by the graph objective, node objective, predecessor output, or coordination evidence are descriptive source paths, not alternate write targets. Never write through an absolute source-workspace path or outside writeRoots. In isolated-copy and read-only-snapshot modes, the runtime workspace is the only workspace you may access. If the requested result cannot be produced within this policy, return a concise limitation instead of attempting the same write elsewhere.`
        const campaign = Object.values(this.state(agent).campaigns).find(candidate => (
          candidate.batches.some(batch => batch.graphId === graph.graphId)
        ))
        const campaignBatch = campaign?.batches.find(batch => batch.graphId === graph.graphId)
        const campaignContext = campaign === undefined || campaignBatch === undefined
          ? {}
          : {
            campaignId: campaign.id,
            batchId: campaignBatch.id,
            predecessorBatches: campaignBatch.dependsOn.map((id) => {
              const predecessor = campaign.batches.find(batch => batch.id === id)
              const execution = predecessor?.executions.at(-1)
              return {
                batchId: id,
                status: predecessor?.status,
                graphId: predecessor?.graphId,
                runId: execution?.runId,
                revision: execution?.revision,
                settlementIds: execution?.settlementIds ?? [],
                summary: execution?.summary,
              }
            }),
          }
        const initialPrompt = `Graph objective: ${graph.objective}\nAssigned node: ${node.title}\nObjective: ${node.objective}\nAcceptance criteria:\n${node.acceptanceCriteria.map(item => `- ${item}`).join('\n')}\nCampaign input: ${JSON.stringify(campaignContext)}\nRuntime subgraph input: ${JSON.stringify(runtimeInput ?? {})}\nPredecessor outputs: ${JSON.stringify(predecessors)}\nCoordination observation: ${claim?.observation ?? 'No external coordination provider is mounted.'}${workspaceProtocol}${executionProtocol}\nReturn the required structured result with a concise summary, JSON data for downstream conditions, artifact paths, and an optional public-safe coordinationSummary of at most 2,000 characters.${controlOutput} Never put credentials, private paths, or hidden reasoning in coordinationSummary.`
        const startWorker = async (activation: number, prompt: string) => {
          const currentRun = readRun()
          const currentNode = currentRun.nodes[node.id] as GraphNodeRun
          const assignment: GraphWorkerAssignment = {
            protocolVersion: 1,
            workId: currentNode.workId,
            operationId: operationIdOf(currentNode.workId, currentRun.generationId),
            attemptId: attempt.id,
            activation,
            runId: currentRun.id,
            generationId: currentRun.generationId,
            ownerEpoch: currentRun.ownerEpoch,
            fencingToken: claim?.fencingToken ?? currentRun.ownerEpoch,
            activeSubagentLimit: graphActiveSubagentLimit(config),
            parent: agent,
            node,
            role: effectiveRole,
            prompt: [{ type: 'text', text: prompt }],
            outputSchema: node.outputSchema.schema,
            budget: effectiveBudget,
            workspace: {
              mode: workspaceMode,
              sourceRoot: cwd as string,
              readRoots: workspaceReadRoots,
              writeRoots: workspaceWriteRoots,
              cleanup: node.workspace?.cleanup ?? (workspaceMode === 'shared' ? 'retain' : 'retain-on-failure'),
            },
            deadline: Date.now() + Math.min(effectiveBudget.maxWallTimeMs, graph.terminationPolicy.maxWallTimeMs),
            signal: workerSignal,
          }
          const run = await this.ctx.graphWorkers.start(workerProvider, assignment)
          this.workerRuns.set(workerKey, run)
          return run
        }
        let childRun = await startWorker(0, initialPrompt)
        appendOperation(agent, readRun(), node, 'started', undefined, {
          references: [
            { kind: 'worker', provider: workerProvider, id: childRun.id },
            { kind: 'workspace', provider: workerProvider, id: childRun.workspace.id },
            ...childRun.childSessionId === undefined ? [] : [{ kind: 'child-session' as const, provider: workerProvider, id: childRun.childSessionId }],
          ],
        })
        const running = read() as GraphNodeRun
        const attempts = running.attempts.map(item => item.id === attempt.id
          ? { ...item, ...childRun.childSessionId === undefined ? {} : { childSessionId: childRun.childSessionId } }
          : item)
        update(node.id, { ...running, attempts })
        {
          let progressFailure: GraphRunExecutionError | undefined
          const publishProgressSnapshot = (snapshot: WorkerProgressSnapshot, activeWorker: GraphWorkerRun): void => {
            if (progressFailure !== undefined) return
            try {
              const observed = read() as GraphNodeRun
              update(node.id, {
                ...observed,
                attempts: observed.attempts.map(item => item.id === attempt.id
                  ? { ...item, health: snapshot.health, checkpoints: snapshot.checkpoints }
                  : item),
              })
            } catch (error) {
              progressFailure = new GraphRunExecutionError('GRAPH_WORKER_PROGRESS_INVALID', node.id, error)
              void activeWorker.cancel(progressFailure.message, this.externalOperationSignal())
                .catch((cancelError: unknown) => {
                  this.ctx.logger.warn(
                    'dsh-graph-mode: failed to stop Worker after invalid progress for node %s: %o',
                    node.id,
                    cancelError,
                  )
                })
            }
          }
          const awaitWorker = async (
            run: GraphWorkerRun,
            activation: number,
            baseline?: WorkerProgressSnapshot,
          ): Promise<{ readonly result: GraphWorkerResult; readonly snapshot: WorkerProgressSnapshot }> => {
            const monitor = new WorkerProgressMonitor(
              this.ctx, run, node, effectiveBudget, activeNode.workId, attempt.id,
              activation, this.externalOperationTimeoutMs,
              async () => { await this.flushBeforeExternal(agent, this.externalOperationSignal()) },
              attempt.startedAt,
              (snapshot) => { publishProgressSnapshot(snapshot, run) }, baseline,
            )
            try {
              const result = await run.result
              if (nodeWallClock.aborted) monitor.markStalled('max-wall-time')
              if (result.outcome === 'max-tokens') monitor.markMaxTokensWithoutProgress()
              const snapshot = monitor.stop()
              publishProgressSnapshot(snapshot, run)
              if (progressFailure !== undefined) throw progressFailure
              if (snapshot.health.status === 'stalled') throw new GraphWorkerStalledError(snapshot.health.stalledReason as GraphStallReason, snapshot)
              return { result, snapshot }
            } catch (error) {
              const snapshot = monitor.stop()
              publishProgressSnapshot(snapshot, run)
              if (progressFailure !== undefined) throw progressFailure
              if (snapshot.health.status === 'stalled' && !(error instanceof GraphWorkerStalledError)) {
                throw new GraphWorkerStalledError(snapshot.health.stalledReason as GraphStallReason, snapshot)
              }
              throw error
            }
          }
          const continuationSessionIds: string[] = []
          let activation = 0
          let baseline: WorkerProgressSnapshot | undefined
          let monitored: { readonly result: GraphWorkerResult; readonly snapshot: WorkerProgressSnapshot }
          while (true) {
            try {
              monitored = await awaitWorker(childRun, activation, baseline)
            } catch (error) {
              if (!(error instanceof GraphWorkerStalledError)
                || error.reason === 'max-wall-time'
                || error.snapshot.checkpoints.at(-1) === undefined) throw error
              monitored = {
                result: { outcome: 'max-tokens', output: [], error: { code: 'GRAPH_WORKER_STALLED', message: error.message } },
                snapshot: error.snapshot,
              }
            }
            const reason = monitored.result.outcome === 'max-tokens'
              ? monitored.snapshot.health.stalledReason ?? 'max-tokens'
              : undefined
            if (reason === undefined) break
            if (continuationSessionIds.length >= effectiveBudget.maxContinuations) {
              throw new Error(`child required continuation after ${String(effectiveBudget.maxContinuations)} bounded continuations: ${reason}`)
            }
            const checkpoint = monitored.snapshot.checkpoints.at(-1)
            if (checkpoint === undefined) throw new GraphWorkerStalledError('max-tokens-without-progress', monitored.snapshot)
            const preserved = JSON.stringify(checkpoint).slice(-graph.terminationPolicy.maxOutputBytes)
            activation = continuationSessionIds.length + 1
            childRun = await startWorker(
              activation,
              `${initialPrompt}\n\nThe preceding activation stopped because ${reason}. Continue the same logical attempt from this durable checkpoint; inspect the recorded files before changing them, do not repeat completed work, and return the required structured result after the remaining work is verified. Durable checkpoint:\n${preserved}`,
            )
            if (childRun.childSessionId !== undefined) continuationSessionIds.push(childRun.childSessionId)
            const continued = read() as GraphNodeRun
            update(node.id, {
              ...continued,
              attempts: continued.attempts.map(item => item.id === attempt.id
                ? { ...item, continuationSessionIds: [...continuationSessionIds] }
                : item),
            })
            baseline = monitored.snapshot
          }
          const result = monitored.result
          heartbeatStop.abort()
          await heartbeatTask
          if (heartbeatError !== undefined) {
            throw heartbeatError instanceof Error ? heartbeatError : new Error(errorMessage(heartbeatError))
          }
          if (result.outcome !== 'completed') {
            resourceFailureOutcome = result.outcome === 'oom' ? 'oom'
              : result.outcome === 'capacity' || result.outcome === 'unavailable' ? 'capacity'
                : result.error?.code === 'RATE_LIMITED' ? 'rate-limited' : 'worker-lost'
            resourceRetryAfterMs = result.error?.retryAfterMs
            if (result.error?.retryable === false) {
              throw new GraphWorkerRevisionRequiredError(result.error.code, result.error.message)
            }
            throw new Error(result.error?.message ?? `worker stopped with ${result.outcome}`)
          }
          const output = outputOf(result.structured, node)
          const checkpoint = this.checkpointForOutput(agent, graph, readRun(), node, output)
          if (result.artifactManifest !== undefined) {
            const artifactManifest = result.artifactManifest
            const captured = read() as GraphNodeRun
            update(node.id, {
              ...captured,
              attempts: captured.attempts.map(item => item.id === attempt.id
                ? { ...item, artifactManifest }
                : item),
            })
            await this.materializeArtifacts(agent, node, readRun(), cwd as string, [artifactManifest], workerSignal)
          }
          const completedAt = Date.now()
          const latestCheckpoint = monitored.snapshot.checkpoints.at(-1)
          const completedCheckpoint: GraphExecutionCheckpoint = {
            workId: activeNode.workId,
            attemptId: attempt.id,
            activation,
            sequence: monitored.snapshot.checkpoints.length + 1,
            createdAt: completedAt,
            completedCriteria: [...node.acceptanceCriteria],
            changedFiles: latestCheckpoint?.changedFiles ?? [],
            verification: latestCheckpoint?.verification ?? [],
            remainingWork: [],
            nextAction: 'Return the accepted structured result to the Graph controller.',
          }
          monitored = {
            result,
            snapshot: {
              checkpoints: [...monitored.snapshot.checkpoints, completedCheckpoint],
              health: {
                ...monitored.snapshot.health,
                status: 'checkpointed',
                lastDurableProgressAt: completedAt,
                durableActions: monitored.snapshot.health.durableActions + 1,
                checkpointCount: monitored.snapshot.checkpoints.length + 1,
              },
            },
          }
          publishProgressSnapshot(monitored.snapshot, childRun)
          appendOperation(agent, readRun(), node, 'output-staged', undefined, {
            outputHash: outputHashOf(output),
            references: [
              ...continuationSessionIds.map(id => ({ kind: 'child-session' as const, provider: workerProvider, id })),
              ...result.artifactManifest === undefined
                ? []
                : [{ kind: 'artifact' as const, provider: result.artifactManifest.provider, id: result.artifactManifest.id }],
            ],
          })
          const staged = read() as GraphNodeRun
          update(node.id, {
            ...staged,
            output,
            attempts: staged.attempts.map(item => item.id === attempt.id && result.artifactManifest !== undefined
              ? { ...item, artifactManifest: result.artifactManifest }
              : item),
          })
          await this.flushBeforeExternal(agent, workerSignal)
          const finished = read() as GraphNodeRun
          if (resourceReservation !== undefined) {
            const settlementId = settlementIdOf(finished.workId, readRun().generationId, `resource-release:${resourceReservation.id}`)
            const requestedAt = Date.now()
            const settlementBase = {
              version: 2 as const,
              id: settlementId,
              attempt: 1,
              operationId: operationIdOf(finished.workId, readRun().generationId),
              workId: finished.workId,
              runId: readRun().id,
              generationId: readRun().generationId,
              ownerEpoch: readRun().ownerEpoch,
              kind: 'resource-release' as const,
              requestedAt,
              externalReference: { kind: 'model' as const, provider: resourceReservation.providerId, id: resourceReservation.id, fencingToken: resourceReservation.fencingToken },
            }
            appendSettlement({ ...settlementBase, outcome: 'pending' })
            resourceSettlementAttempted = true
            await this.flushCleanupIntent(agent, `completed model reservation ${resourceReservation.id}`)
            try {
              if (resources === undefined) throw new Error('graph-resources disappeared before reservation release')
              const operationSignal = this.externalOperationSignal()
              await this.waitForExternal(resources.report({
                reservationId: resourceReservation.id,
                providerId: resourceReservation.providerId,
                workId: resourceReservation.workId,
                ownerEpoch: resourceReservation.ownerEpoch,
                fencingToken: resourceReservation.fencingToken,
                outcome: 'completed',
                at: Date.now(),
              }, operationSignal), operationSignal)
              appendSettlement({ ...settlementBase, outcome: 'confirmed', completedAt: Date.now(), evidence: `model reservation ${resourceReservation.id} completed` })
            } catch (error) {
              const detail = { code: 'GRAPH_RESOURCE_RELEASE_FAILED', message: errorMessage(error) }
              appendSettlement({ ...settlementBase, outcome: 'failed', completedAt: Date.now(), error: detail })
              throw new GraphRunExecutionError('GRAPH_RESOURCE_RELEASE_FAILED', node.id, error)
            }
          }
          if (coordination !== undefined && cwd !== undefined && claim !== undefined) {
            const settlementId = settlementIdOf(finished.workId, readRun().generationId, `coordination:${claim.claimId}`)
            const requestedAt = Date.now()
            const settlementBase = {
              version: 2 as const,
              id: settlementId,
              attempt: 1,
              operationId: operationIdOf(finished.workId, readRun().generationId),
              workId: finished.workId,
              runId: readRun().id,
              generationId: readRun().generationId,
              ownerEpoch: readRun().ownerEpoch,
              kind: 'coordination' as const,
              requestedAt,
              externalReference: { kind: 'coordination' as const, provider: 'graph-coordination', id: claim.claimId },
            }
            appendSettlement({ ...settlementBase, outcome: 'pending' })
            appendOperation(agent, readRun(), node, 'settlement-pending', undefined, {
              references: [settlementBase.externalReference],
            })
            await this.flushBeforeExternal(agent, this.externalOperationSignal())
            try {
              const currentLease = await this.latestCoordinationLease(coordination, {
                protocolVersion: 3,
                workId: finished.workId,
                activationId: activationIdOf(finished.workId, readRun().generationId),
                cwd,
                callerId: agent.id,
              }, claim, this.externalOperationSignal())
              if (currentLease.fencingToken !== claim.fencingToken || currentLease.leaseId !== claim.leaseId) {
                claim = { ...claim, ...currentLease }
                appendOperation(agent, readRun(), node, 'progress', undefined, {
                  detail: `Coordination lease refreshed through ${new Date(currentLease.expiresAt).toISOString()}.`,
                  references: [{
                    kind: 'coordination',
                    provider: 'graph-coordination-lease',
                    id: currentLease.leaseId,
                    fencingToken: currentLease.fencingToken,
                  }],
                })
                await this.flushBeforeExternal(agent, this.externalOperationSignal())
              }
              const progressEvidence = output.coordinationSummary ?? `Graph node ${node.id} produced schema-valid output.`
              const progressSignal = this.externalOperationSignal()
              await this.waitForExternal(coordination.publishProgress({
                ...coordinationRequest,
                claimId: claim.claimId,
                leaseId: claim.leaseId,
                fencingToken: claim.fencingToken,
                progressSequence: attemptNumber * 2,
                evidence: progressEvidence,
              }, progressSignal), progressSignal)
              appendOperation(agent, readRun(), node, 'progress', undefined, { detail: progressEvidence })
              await this.flushBeforeExternal(agent, this.externalOperationSignal())
              const settlementSignal = this.externalOperationSignal()
              await this.waitForExternal(coordination.settle({
                protocolVersion: 3, graph, node, role: effectiveRole, runId: readRun().id, cwd,
                workId: finished.workId,
                activationId: activationIdOf(finished.workId, readRun().generationId),
                ownerEpoch: readRun().ownerEpoch,
                operationId: operationIdOf(finished.workId, readRun().generationId), callerId: agent.id,
                claimId: claim.claimId,
                leaseId: claim.leaseId,
                fencingToken: claim.fencingToken,
                settlementId,
                outcome: 'succeeded',
                evidence: output.coordinationSummary ?? `dsh graph node ${node.id} completed; detailed evidence remains in child session ${childRun.childSessionId ?? childRun.id}`,
              }, settlementSignal), settlementSignal)
              appendSettlement({
                ...settlementBase,
                outcome: 'confirmed',
                completedAt: Date.now(),
                evidence: output.coordinationSummary ?? `graph node ${node.id} completed`,
              })
            } catch (error) {
              const detail = { code: 'GRAPH_COORDINATION_WRITEBACK_FAILED', message: errorMessage(error) }
              appendSettlement({ ...settlementBase, outcome: 'failed', completedAt: Date.now(), error: detail })
              const projection = this.state(agent)
              const iteration = Object.values(projection.checkpoints).filter(item => item.graphId === graph.graphId).length + 1
              const checkpoint: GraphCheckpoint = {
                id: GraphCheckpointId(stableId('checkpoint', [readRun().id, node.id, iteration, settlementId])),
                graphId: graph.graphId,
                revision: graph.revision,
                runId: readRun().id,
                nodeId: node.id,
                kind: 'awaiting_user',
                status: 'pending',
                createdAt: Date.now(),
                iteration,
                reason: `Node ${node.id} produced accepted output, but its coordination settlement is not confirmed. Reconcile the pending settlement without rerunning the Worker.`,
                issues: [{
                  id: `coordination-settlement-${node.id}-${String(attemptNumber)}`,
                  severity: 'blocking',
                  summary: 'Coordination settlement requires reconciliation.',
                  evidence: [detail.message],
                  ownerNodeIds: [node.id],
                }],
              }
              validateGraphCheckpoint(checkpoint, projection)
              update(node.id, {
                ...finished,
                phase: 'awaiting_user',
                output,
                attempts: finished.attempts.map(item => item.id === attempt.id ? { ...item, finishedAt: Date.now(), error: detail } : item),
              })
              requestPause({ checkpoint, phase: 'awaiting_user' })
              return
            }
          }
          update(node.id, {
            ...finished,
            phase: 'succeeded',
            output,
            attempts: finished.attempts.map(item => item.id === attempt.id ? { ...item, finishedAt: Date.now() } : item),
          })
          appendOperation(agent, readRun(), node, 'terminal', undefined, { terminalOutcome: 'succeeded' })
          if (checkpoint !== undefined) requestPause(checkpoint)
          return
        }
      } catch (error) {
        heartbeatStop.abort()
        await heartbeatTask
        assertAuthority()
        const failed = read() as GraphNodeRun
        const canceled = signal.aborted
        const stalled = error instanceof GraphWorkerStalledError
        const revisionRequired = error instanceof GraphWorkerRevisionRequiredError
        const executionError = error instanceof GraphRunExecutionError
        const detail = {
          code: canceled ? 'GRAPH_NODE_CANCELED'
            : stalled ? 'GRAPH_NODE_STALLED'
              : revisionRequired ? error.code
                : executionError ? error.code : 'GRAPH_NODE_ATTEMPT_FAILED',
          message: errorMessage(canceled ? signal.reason : error),
        }
        const terminal = canceled || stalled || revisionRequired || executionError || attemptNumber === node.maxAttempts
        update(node.id, {
          ...failed,
          phase: canceled ? 'canceled' : stalled || revisionRequired || executionError || attemptNumber === node.maxAttempts ? 'failed' : 'ready',
          attempts: failed.attempts.map(item => item.id === attempt.id ? { ...item, finishedAt: Date.now(), error: detail } : item),
        })
        appendOperation(agent, readRun(), node, terminal ? 'terminal' : 'reconciled', undefined, terminal
          ? { terminalOutcome: canceled ? 'canceled' : 'failed', detail: detail.message }
          : { detail: `attempt ${String(attemptNumber)} failed: ${detail.message}` })
        if (stalled) {
          const projection = this.state(agent)
          const iteration = Object.values(projection.checkpoints).filter(item => item.graphId === graph.graphId).length + 1
          const checkpoint: GraphCheckpoint = {
            id: GraphCheckpointId(stableId('checkpoint', [readRun().id, node.id, iteration, error.reason])),
            graphId: graph.graphId,
            revision: graph.revision,
            runId: readRun().id,
            nodeId: node.id,
            kind: 'planning',
            status: 'pending',
            createdAt: Date.now(),
            iteration,
            reason: `Worker for node ${node.id} stalled (${error.reason}). The controller must reduce the task granularity or change its role, model, or execution budget before dispatching replacement work.`,
            issues: [{
              id: `worker-stalled-${node.id}-${String(attemptNumber)}`,
              severity: 'blocking',
              summary: `Node made no recoverable progress before ${error.reason}.`,
              evidence: [`durableActions=${String(error.snapshot.health.durableActions)}`, `estimatedReasoningTokens=${String(error.snapshot.health.estimatedReasoningTokens)}`],
              ownerNodeIds: [node.id],
            }],
          }
          validateGraphCheckpoint(checkpoint, projection)
          requestPause({ checkpoint, phase: 'paused' })
        }
        if (revisionRequired) {
          const projection = this.state(agent)
          const iteration = Object.values(projection.checkpoints).filter(item => item.graphId === graph.graphId).length + 1
          const checkpoint: GraphCheckpoint = {
            id: GraphCheckpointId(stableId('checkpoint', [readRun().id, node.id, iteration, error.code])),
            graphId: graph.graphId,
            revision: graph.revision,
            runId: readRun().id,
            nodeId: node.id,
            kind: 'planning',
            status: 'pending',
            createdAt: Date.now(),
            iteration,
            reason: `Worker for node ${node.id} reported non-retryable error ${error.code}. The controller must correct the task or workspace ownership before dispatching replacement work.`,
            issues: [{
              id: `worker-revision-${node.id}-${String(attemptNumber)}`,
              severity: 'blocking',
              summary: `The unchanged node cannot succeed after ${error.code}.`,
              evidence: [error.workerMessage],
              ownerNodeIds: [node.id],
            }],
          }
          validateGraphCheckpoint(checkpoint, projection)
          requestPause({ checkpoint, phase: 'paused' })
        }
        if (terminal && coordination !== undefined && cwd !== undefined && claim !== undefined) {
          const settlementId = settlementIdOf(failed.workId, readRun().generationId, `coordination:${claim.claimId}`)
          const settlement = this.beginSettlement(agent, {
            id: settlementId,
            operationId: operationIdOf(failed.workId, readRun().generationId),
            workId: failed.workId,
            runId: readRun().id,
            generationId: readRun().generationId,
            ownerEpoch: readRun().ownerEpoch,
            kind: 'coordination',
            externalReference: { kind: 'coordination', provider: 'graph-coordination', id: claim.claimId },
          })
          if (settlement !== undefined) {
            const evidence = canceled
              ? `dsh graph node ${node.id} canceled: ${errorMessage(signal.reason)}`
              : stalled
                ? `dsh graph node ${node.id} stalled without recoverable progress: ${error.reason}`
                : revisionRequired
                  ? `dsh graph node ${node.id} requires revision after ${error.code}: ${error.workerMessage}`
                  : `dsh graph node ${node.id} exhausted its bounded attempts`
            if (await this.flushCleanupIntent(agent, `failed coordination claim ${claim.claimId}`)) {
              try {
                const currentLease = await this.latestCoordinationLease(coordination, {
                  protocolVersion: 3,
                  workId: failed.workId,
                  activationId: activationIdOf(failed.workId, readRun().generationId),
                  cwd,
                  callerId: agent.id,
                }, claim, this.externalOperationSignal())
                const settlementSignal = this.externalOperationSignal()
                await this.waitForExternal(coordination.settle({
                  protocolVersion: 3, graph, node, role: effectiveRole, runId: readRun().id, cwd,
                  workId: failed.workId,
                  activationId: activationIdOf(failed.workId, readRun().generationId),
                  ownerEpoch: readRun().ownerEpoch,
                  operationId: operationIdOf(failed.workId, readRun().generationId), callerId: agent.id,
                  claimId: currentLease.claimId,
                  leaseId: currentLease.leaseId,
                  fencingToken: currentLease.fencingToken,
                  settlementId,
                  outcome: canceled ? 'canceled' : 'failed',
                  evidence,
                }, settlementSignal), settlementSignal)
                appendSettlement({ ...settlement, outcome: 'confirmed', completedAt: Date.now(), evidence })
              } catch (writebackError) {
                appendSettlement({
                  ...settlement,
                  outcome: 'failed',
                  completedAt: Date.now(),
                  error: { code: 'GRAPH_COORDINATION_WRITEBACK_FAILED', message: errorMessage(writebackError) },
                })
                this.ctx.logger.warn('dsh-graph-mode: LoopX blocker writeback failed for node %s: %o', node.id, writebackError)
              }
            }
          }
        }
        if (resourceReservation !== undefined && !resourceSettlementAttempted) {
          const settlementId = settlementIdOf(failed.workId, readRun().generationId, `resource-release:${resourceReservation.id}`)
          const settlementBase = {
            version: 2 as const,
            id: settlementId,
            attempt: 1,
            operationId: operationIdOf(failed.workId, readRun().generationId),
            workId: failed.workId,
            runId: readRun().id,
            generationId: readRun().generationId,
            ownerEpoch: readRun().ownerEpoch,
            kind: 'resource-release' as const,
            requestedAt: Date.now(),
            externalReference: { kind: 'model' as const, provider: resourceReservation.providerId, id: resourceReservation.id, fencingToken: resourceReservation.fencingToken },
          }
          appendSettlement({ ...settlementBase, outcome: 'pending' })
          resourceSettlementAttempted = true
          await this.flushCleanupIntent(agent, `failed model reservation ${resourceReservation.id}`)
          try {
            if (resources === undefined) throw new Error('graph-resources disappeared before reservation release')
            const operationSignal = this.externalOperationSignal()
            await this.waitForExternal(resources.report({
              reservationId: resourceReservation.id,
              providerId: resourceReservation.providerId,
              workId: resourceReservation.workId,
              ownerEpoch: resourceReservation.ownerEpoch,
              fencingToken: resourceReservation.fencingToken,
              outcome: canceled ? 'released' : resourceFailureOutcome,
              at: Date.now(),
              ...resourceRetryAfterMs === undefined ? {} : { retryAfterMs: resourceRetryAfterMs },
              evidence: detail.message,
            }, operationSignal), operationSignal)
            appendSettlement({ ...settlementBase, outcome: 'confirmed', completedAt: Date.now(), evidence: detail.message })
          } catch (reportError) {
            appendSettlement({
              ...settlementBase,
              outcome: 'failed',
              completedAt: Date.now(),
              error: { code: 'GRAPH_RESOURCE_RELEASE_FAILED', message: errorMessage(reportError) },
            })
            this.ctx.logger.warn('dsh-graph-mode: resource release failed for node %s: %o', node.id, reportError)
          }
        }
        if (terminal) return
      } finally {
        this.workerRuns.delete(workerKey)
        heartbeatStop.abort()
        await heartbeatTask
        release()
      }
    }
  }
}

/** Install the graph-mode controller service. */
export default GraphModeController
