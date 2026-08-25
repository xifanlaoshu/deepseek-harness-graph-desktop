/**
 * Durable graph-mode domain: default software-engineering roles, strict DAG
 * validation, downstream invalidation, and replayable session projection.
 * @module @deepseek-ai/dsh-graph
 */

import { isDeepStrictEqual } from 'node:util'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  GraphBranchGroupId,
  MAX_GRAPH_TIMER_MS,
  GraphNodeId,
  GraphRoleId,
  type GraphExecutionPolicy,
  type GraphEnvironmentPlan,
  type GraphNodeExecutionBudget,
  type GraphCheckpoint,
  type GraphCampaign,
  type GraphControlRecord,
  type GraphModeConfig,
  type GraphOutputSchema,
  type GraphOperationTransition,
  type GraphProjection,
  type GraphRevisionSubmissionRecord,
  type GraphRevision,
  type GraphRun,
  type GraphSettlementRecord,
} from './types.ts'

export * from './types.ts'

/** Durable configuration or graph-definition replacement. */
export type GraphDefinitionChange =
  | { readonly kind: 'graph/config'; readonly version: 2; readonly config: GraphModeConfig }
  | { readonly kind: 'graph/revision'; readonly version: 2; readonly graph: GraphRevision; readonly current: boolean }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole graph-mode configuration or one immutable graph revision. */
    'graph/change': GraphDefinitionChange
    /** Whole execution snapshot; the latest snapshot for a run id wins. */
    'graph/run': GraphRun
    /** Append-only recoverable transition for one logical node operation. */
    'graph/operation': GraphOperationTransition
    /** Append-only external settlement attempt and result. */
    'graph/settlement': GraphSettlementRecord
    /** Recoverable intent and result for accepting one immutable revision. */
    'graph/submission': GraphRevisionSubmissionRecord
    /** Whole durable state of one planning, repair, or human checkpoint. */
    'graph/checkpoint': GraphCheckpoint
    /** Accepted human or controller operation over one graph run. */
    'graph/control': GraphControlRecord
    /** Whole campaign snapshot linking independent batch graphs. */
    'graph/campaign': GraphCampaign
  }
}

const role = (
  id: string,
  label: string,
  description: string,
  prompt: string,
  maxParallel: number,
  controller = false,
) => ({
  id: GraphRoleId(id),
  label,
  description,
  controller,
  enabled: true,
  model: {},
  prompt,
  maxParallel,
} as const)

/**
 * Return the editable default software-engineering team. Role prompts define
 * ownership and required outputs; the controller alone classifies user intent
 * and creates graph revisions.
 * @returns a detached versioned graph-mode configuration.
 */
export function defaultGraphModeConfig(): GraphModeConfig {
  return {
    version: 2,
    active: false,
    roles: [
      role('controller', 'Controller', 'Classifies each user input and owns graph revisions.', 'Classify the input as new work, revision, inspection, control, clarification, or direct response. Create the smallest auditable DAG that preserves real dependencies. Never implement a delegated task yourself. Synthesize only from published node outputs and evidence.', 1, true),
      role('analyst', 'Analyst', 'Clarifies requirements, constraints, and acceptance criteria.', 'Turn ambiguous requests into explicit requirements, risks, and acceptance criteria. Cite repository evidence and identify questions only when the answer changes the implementation materially.', 2),
      role('architect', 'Architect', 'Defines component responsibilities and integration contracts.', 'Design the smallest coherent change across existing extension points. State APIs, durable state, failure behavior, migration impact, and verification obligations before implementation begins.', 1),
      role('environment', 'Environment Operator', 'Inspects toolchain prerequisites and plans bounded host changes.', 'Prefer project-local toolchains and reversible operations. Name exact commands, required host capabilities, affected resources, verification, and rollback evidence; never broaden a Docker or package-manager operation beyond the assigned project.', 1),
      role('engineer', 'Engineer', 'Implements scoped code changes.', 'Implement only the assigned node. Preserve unrelated work, follow repository instructions, add focused tests, and publish changed files plus verification evidence.', 1),
      role('reviewer', 'Reviewer', 'Finds correctness, security, lifecycle, and maintainability defects.', 'Review the assigned change against its acceptance criteria and repository contracts. Report actionable findings with exact evidence; do not rewrite code unless the task explicitly assigns remediation.', 2),
      role('verifier', 'Verifier', 'Runs focused checks and diagnoses failures.', 'Select the smallest checks that prove the assigned behavior. Distinguish product failures from environment failures and publish commands, results, and residual risk.', 2),
      role('browser-tester', 'Browser Tester', 'Validates web flows with DOM, visual, console, and network evidence.', 'Test only the assigned target origin and acceptance criteria. Keep one explicit browser page id, use page snapshots and element identifiers for ordinary actions, and use screenshots for visual assertions when the selected model accepts images. Inspect console errors and failed network requests after critical actions. Never enter real secrets or perform destructive or production actions. Report pass only from observed evidence, publish a structured decision and actionable issues, and close only the page you created.', 1),
      role('writer', 'Writer', 'Maintains user and developer documentation.', 'Update the authoritative documentation and public API prose for the implemented behavior. Keep current-state contracts synchronized with code and avoid review-history narration.', 1),
    ],
    limits: { globalMaxParallel: 8, controllerReserve: 1, models: [] },
    executionPolicy: defaultGraphExecutionPolicy(),
  }
}

/**
 * Return deployment ceilings used for graph validation and resolved revisions.
 * @returns detached execution policy with conservative local-worker limits.
 */
export function defaultGraphExecutionPolicy(): GraphExecutionPolicy {
  return {
    maxNodesPerRevision: 64,
    maxAttemptsPerNode: 3,
    maxGraphRevisions: 24,
    maxRepairRevisions: 8,
    maxDynamicExpansions: 8,
    maxSubgraphDepth: 4,
    maxRuntimeContinuations: 2,
    maxOutputTokens: 16_384,
    maxReasoningOnlyTokens: 4_096,
    firstDurableActionMs: 120_000,
    maxNoDurableProgressMs: 300_000,
    checkpointIntervalMs: 180_000,
    maxWallTimeMs: 1_800_000,
    maxOutputBytes: 262_144,
    noProgressLimit: 2,
  }
}

/**
 * Resolve one complete node budget from deployment policy ceilings.
 * @param policy graph execution policy copied into an accepted revision.
 * @returns detached per-node budget suitable for immutable dispatch.
 */
export function defaultGraphNodeExecutionBudget(
  policy: GraphExecutionPolicy = defaultGraphExecutionPolicy(),
): GraphNodeExecutionBudget {
  return {
    maxOutputTokens: policy.maxOutputTokens,
    maxReasoningOnlyTokens: policy.maxReasoningOnlyTokens,
    firstDurableActionMs: policy.firstDurableActionMs,
    maxNoDurableProgressMs: policy.maxNoDurableProgressMs,
    checkpointIntervalMs: policy.checkpointIntervalMs,
    maxWallTimeMs: policy.maxWallTimeMs,
    maxContinuations: policy.maxRuntimeContinuations,
  }
}

/**
 * Return the standard structured worker result schema for an ordinary node.
 * @param id stable schema id stored with the node.
 * @returns detached versioned output schema.
 */
export function defaultGraphOutputSchema(id = 'dsh.graph.node-output'): GraphOutputSchema {
  const schema: ObjectJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      coordinationSummary: { type: 'string' },
      data: {},
      artifacts: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'artifacts'],
  }
  return { id, version: 1, maxBytes: defaultGraphExecutionPolicy().maxOutputBytes, schema }
}

/**
 * Return the empty graph projection used before the first graph event.
 * @returns projection containing inactive defaults and no graphs or runs.
 */
export function emptyGraphProjection(): GraphProjection {
  return {
    config: defaultGraphModeConfig(), graphs: {}, runs: {}, operations: {}, settlements: {},
    submissions: {}, checkpoints: {}, controls: {}, campaigns: {},
  }
}

/** Stable graph validation error for controller output and settings writes. */
export class GraphValidationError extends Error {
  /** Machine-routable validation failure. */
  readonly code: string

  /**
   * Construct a graph validation error.
   * @param code stable upper-snake-case failure code.
   * @param message human-readable failure explanation.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GraphValidationError'
    this.code = code
  }
}

const fail = (code: string, message: string): never => { throw new GraphValidationError(code, message) }
const normalized = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim()
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const isVersionOne = (value: number): boolean => value === 1
const isVersionTwo = (value: number): boolean => value === 2
const TASK_KINDS = new Set(['analysis', 'design', 'environment', 'implementation', 'review', 'verification', 'documentation', 'integration', 'specialist', 'expansion', 'subgraph'])
const ENVIRONMENT_CAPABILITIES = new Set(['network', 'host-package-install', 'docker'])
const CAMPAIGN_BATCH_STATUSES = new Set(['planned', 'running', 'approved', 'approved_with_findings', 'rejected', 'needs_user', 'blocked'])
const CAMPAIGN_PHASES = new Set(['planned', 'running', 'awaiting_user', 'succeeded', 'failed', 'canceled'])
/** Protocol bound that keeps one approved environment node reviewable. */
export const MAX_GRAPH_ENVIRONMENT_OPERATIONS = 16
/** Protocol bound reserved below the checkpoint reason limit for approval framing. */
export const MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES = 3_500

const validateCampaignShape = (campaign: GraphCampaign, state?: GraphProjection): void => {
  if (!isVersionOne(campaign.version) || !normalized(campaign.id) || !SAFE_ID.test(campaign.id)) {
    fail('GRAPH_CAMPAIGN_IDENTITY', 'campaign requires version 1 and a normalized safe id')
  }
  if (!normalized(campaign.objective) || !Number.isSafeInteger(campaign.createdAt)
    || !Number.isSafeInteger(campaign.updatedAt) || campaign.updatedAt < campaign.createdAt
    || !CAMPAIGN_PHASES.has(campaign.phase) || campaign.batches.length === 0) {
    fail('GRAPH_CAMPAIGN_FIELDS', 'campaign requires an objective, ordered batches, valid timestamps, and a known phase')
  }
  const ids = new Set<string>()
  for (const [index, batch] of campaign.batches.entries()) {
    if (!normalized(batch.id) || !SAFE_ID.test(batch.id) || ids.has(batch.id)
      || batch.ordinal !== index + 1 || !normalized(batch.title) || !normalized(batch.objective)
      || !CAMPAIGN_BATCH_STATUSES.has(batch.status)) {
      fail('GRAPH_CAMPAIGN_BATCH', `campaign batch at index ${String(index)} has invalid identity, order, text, or status`)
    }
    if (batch.dependsOn.some(id => !ids.has(id)) || new Set(batch.dependsOn).size !== batch.dependsOn.length) {
      fail('GRAPH_CAMPAIGN_DEPENDENCY', `campaign batch ${JSON.stringify(batch.id)} dependencies must name unique earlier batches`)
    }
    ids.add(batch.id)
    if (batch.graphId !== undefined && batch.executions.some(execution => execution.graphId !== batch.graphId)) {
      fail('GRAPH_CAMPAIGN_EXECUTION', `campaign batch ${JSON.stringify(batch.id)} changed graph identity`)
    }
    for (const execution of batch.executions) {
      if (!Number.isSafeInteger(execution.revision) || execution.revision < 1
        || !Number.isSafeInteger(execution.startedAt) || (execution.completedAt !== undefined
          && (!Number.isSafeInteger(execution.completedAt) || execution.completedAt < execution.startedAt))) {
        fail('GRAPH_CAMPAIGN_EXECUTION', `campaign batch ${JSON.stringify(batch.id)} has invalid execution timing`)
      }
      if (state !== undefined) {
        const graph = state.graphs[execution.graphId]?.find(revision => revision.revision === execution.revision)
        const run = state.runs[execution.runId]
        if (graph === undefined || run === undefined || run.graphId !== execution.graphId || run.revision !== execution.revision) {
          fail('GRAPH_CAMPAIGN_EXECUTION', `campaign batch ${JSON.stringify(batch.id)} names an unknown graph execution`)
        }
        if (execution.settlementIds.some(id => state.settlements[id]?.at(-1)?.outcome !== 'confirmed')) {
          fail('GRAPH_CAMPAIGN_EXECUTION', `campaign batch ${JSON.stringify(batch.id)} names an unconfirmed settlement`)
        }
      }
    }
  }
  const planRevision = campaign.planRevision ?? 1
  const planExtensions = campaign.planExtensions ?? []
  if (!Number.isSafeInteger(planRevision) || planRevision < 1 || planExtensions.length !== planRevision - 1) {
    fail('GRAPH_CAMPAIGN_PLAN', 'campaign plan revision must match its ordered extension history')
  }
  const extendedBatchCount = planExtensions.reduce((total, extension) => total + extension.addedBatchIds.length, 0)
  let extensionOffset = campaign.batches.length - extendedBatchCount
  if (extensionOffset < 1) fail('GRAPH_CAMPAIGN_PLAN', 'campaign plan extensions must retain a non-empty initial batch prefix')
  for (const [index, extension] of planExtensions.entries()) {
    const added = campaign.batches.slice(extensionOffset, extensionOffset + extension.addedBatchIds.length)
    if (extension.revision !== index + 2 || !Number.isSafeInteger(extension.createdAt)
      || extension.createdAt < campaign.createdAt || extension.createdAt > campaign.updatedAt
      || !normalized(extension.reason) || extension.addedBatchIds.length === 0
      || !isDeepStrictEqual(added.map(batch => batch.id), extension.addedBatchIds)
      || new Set(extension.addedBatchIds).size !== extension.addedBatchIds.length
      || extension.settlementIds.some(id => !normalized(id))) {
      fail('GRAPH_CAMPAIGN_PLAN', `campaign plan extension ${String(index + 2)} is invalid`)
    }
    if (extension.sourceBatchId !== undefined) {
      const sourceIndex = campaign.batches.findIndex(batch => batch.id === extension.sourceBatchId)
      const source = campaign.batches[sourceIndex]
      const execution = source?.executions.find(item => item.runId === extension.sourceRunId)
      if (sourceIndex < 0 || sourceIndex >= extensionOffset || extension.sourceRunId === undefined
        || execution === undefined || !isDeepStrictEqual(execution.settlementIds, extension.settlementIds)) {
        fail('GRAPH_CAMPAIGN_PLAN', `campaign plan extension ${String(index + 2)} has invalid source evidence`)
      }
    } else if (extension.sourceRunId !== undefined || extension.settlementIds.length > 0) {
      fail('GRAPH_CAMPAIGN_PLAN', `campaign plan extension ${String(index + 2)} has source evidence without a source batch`)
    }
    if (state !== undefined && extension.settlementIds.some(id => state.settlements[id]?.at(-1)?.outcome !== 'confirmed')) {
      fail('GRAPH_CAMPAIGN_PLAN', `campaign plan extension ${String(index + 2)} names an unconfirmed settlement`)
    }
    extensionOffset += extension.addedBatchIds.length
  }
  if (campaign.activeBatchId !== undefined && !ids.has(campaign.activeBatchId)) {
    fail('GRAPH_CAMPAIGN_ACTIVE_BATCH', 'campaign activeBatchId must name one of its batches')
  }
  if (campaign.phase === 'succeeded' && campaign.batches.some(batch => !['approved', 'approved_with_findings'].includes(batch.status))) {
    fail('GRAPH_CAMPAIGN_PHASE', 'a succeeded campaign requires every batch to be approved')
  }
}

/**
 * Validate a whole campaign snapshot against graph and run evidence already in the projection.
 * @param campaign immutable Campaign snapshot to validate.
 * @param state projection containing every referenced graph, run, and settlement.
 * @returns nothing after successful validation.
 */
export function validateGraphCampaign(campaign: GraphCampaign, state: GraphProjection): void {
  validateCampaignShape(campaign, state)
}

/**
 * Render the exact environment plan shown at its mandatory approval checkpoint.
 * @param plan immutable capabilities, authority, commands, and documentary rollback commands.
 * @returns stable JSON text suitable for the checkpoint card and audit log.
 */
export function graphEnvironmentApprovalText(plan: GraphEnvironmentPlan): string {
  return JSON.stringify({
    requiredCapabilities: plan.requiredCapabilities,
    sandboxMode: plan.sandboxMode,
    operations: plan.operations,
  }, null, 2)
}
const EDGE_KINDS = new Set(['control', 'data', 'conditional'])
const CONDITION_OPERATORS = new Set(['exists', 'truthy', 'equals', 'not-equals'])
const BRANCH_MODES = new Set(['all', 'any', 'exactly-one', 'activated'])
const NODE_PHASES = new Set(['pending', 'ready', 'running', 'awaiting_user', 'succeeded', 'failed', 'skipped', 'blocked', 'stale', 'canceled', 'exhausted'])
const RUN_PHASES = new Set(['queued', 'running', 'paused', 'awaiting_user', 'succeeded', 'failed', 'canceled', 'exhausted'])
const terminalNodePhase = (phase: string): boolean => ['succeeded', 'failed', 'skipped', 'blocked', 'stale', 'canceled', 'exhausted'].includes(phase)

const modelSelectionSchema = zod.object({
  provider: zod.string().optional(),
  model: zod.string().optional(),
  reasoningEffort: zod.string().optional(),
}).strict()
const roleSchema = zod.object({
  id: zod.string(),
  label: zod.string(),
  description: zod.string(),
  controller: zod.boolean(),
  enabled: zod.boolean(),
  model: modelSelectionSchema,
  prompt: zod.string(),
  workerProvider: zod.string().optional(),
  maxParallel: zod.number(),
}).strict()
const modelLimitSchema = zod.object({
  provider: zod.string().optional(),
  model: zod.string(),
  maxParallel: zod.number(),
  maxWeight: zod.number().optional(),
}).strict()
const executionPolicySchema = zod.object({
  maxNodesPerRevision: zod.number(),
  maxAttemptsPerNode: zod.number(),
  maxGraphRevisions: zod.number(),
  maxRepairRevisions: zod.number(),
  maxDynamicExpansions: zod.number(),
  maxSubgraphDepth: zod.number(),
  maxRuntimeContinuations: zod.number(),
  maxOutputTokens: zod.number(),
  maxReasoningOnlyTokens: zod.number(),
  firstDurableActionMs: zod.number(),
  maxNoDurableProgressMs: zod.number(),
  checkpointIntervalMs: zod.number(),
  maxWallTimeMs: zod.number(),
  maxOutputBytes: zod.number(),
  noProgressLimit: zod.number(),
}).strict()
const executionBudgetSchema = zod.object({
  maxOutputTokens: zod.number(),
  maxReasoningOnlyTokens: zod.number(),
  firstDurableActionMs: zod.number(),
  maxNoDurableProgressMs: zod.number(),
  checkpointIntervalMs: zod.number(),
  maxWallTimeMs: zod.number(),
  maxContinuations: zod.number(),
}).strict()
const configSchema = zod.object({
  version: zod.number(),
  active: zod.boolean(),
  roles: zod.array(roleSchema),
  limits: zod.object({
    globalMaxParallel: zod.number(),
    controllerReserve: zod.number(),
    models: zod.array(modelLimitSchema),
  }).strict(),
  executionPolicy: executionPolicySchema,
}).strict()
const nodeOutputSchema = zod.object({
  summary: zod.string(),
  coordinationSummary: zod.string().optional(),
  data: zod.unknown().optional(),
  artifacts: zod.array(zod.string()),
}).strict()
const conditionSchema = zod.object({
  path: zod.array(zod.string()),
  operator: zod.string(),
  value: zod.union([zod.null(), zod.boolean(), zod.number(), zod.string()]).optional(),
}).strict()
const edgeSchema = zod.object({
  from: zod.string(),
  to: zod.string(),
  kind: zod.string(),
  condition: conditionSchema.optional(),
  branchGroupId: zod.string().optional(),
}).strict()
const outputSchemaSchema = zod.object({
  id: zod.string(),
  version: zod.number(),
  maxBytes: zod.number(),
  schema: zod.unknown(),
}).strict()
const expansionSchema = zod.object({
  mode: zod.enum(['controller', 'map']),
  maxNodes: zod.number(),
  itemPath: zod.array(zod.string()).optional(),
  itemKeyPath: zod.array(zod.string()).optional(),
}).strict()
const subgraphSchema = zod.object({
  graphId: zod.string(),
  revision: zod.number(),
  input: zod.record(zod.string(), zod.array(zod.string())),
  output: zod.record(zod.string(), zod.array(zod.string())),
}).strict()
const workspaceSchema = zod.object({
  mode: zod.enum(['read-only-snapshot', 'isolated-copy', 'git-worktree', 'sandbox-mount', 'shared']),
  readRoots: zod.array(zod.string()),
  writeRoots: zod.array(zod.string()),
  cleanup: zod.enum(['delete-on-settlement', 'retain-on-failure', 'retain']),
}).strict()
const environmentOperationSchema = zod.object({
  id: zod.string(),
  description: zod.string(),
  command: zod.string(),
  rollbackCommand: zod.string().optional(),
}).strict()
const environmentPlanSchema = zod.object({
  requiredCapabilities: zod.array(zod.enum(['network', 'host-package-install', 'docker'])),
  sandboxMode: zod.enum(['workspace-write', 'danger-full-access']),
  operations: zod.array(environmentOperationSchema),
}).strict()
const nodeSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  objective: zod.string(),
  kind: zod.string(),
  roleId: zod.string(),
  acceptanceCriteria: zod.array(zod.string()),
  outputSchema: outputSchemaSchema,
  maxAttempts: zod.number(),
  weight: zod.number(),
  executionBudget: executionBudgetSchema,
  expansion: expansionSchema.optional(),
  subgraph: subgraphSchema.optional(),
  environment: environmentPlanSchema.optional(),
  workspace: workspaceSchema.optional(),
  skippable: zod.boolean(),
  effectPolicy: zod.enum(['idempotent', 'reconcile', 'manual']),
}).strict()
const branchGroupSchema = zod.object({
  id: zod.string(),
  to: zod.string(),
  mode: zod.string(),
}).strict()
const terminationPolicySchema = executionPolicySchema.extend({
  onExhausted: zod.enum(['failed', 'awaiting_user']),
}).strict()
const revisionSchema = zod.object({
  graphId: zod.string(),
  revision: zod.number(),
  objective: zod.string(),
  createdAt: zod.number(),
  parentRevision: zod.number().optional(),
  userInput: zod.string(),
  nodes: zod.array(nodeSchema),
  edges: zod.array(edgeSchema),
  branchGroups: zod.array(branchGroupSchema),
  terminationPolicy: terminationPolicySchema,
}).strict()
const attemptSchema = zod.object({
  id: zod.string(),
  number: zod.number(),
  startedAt: zod.number(),
  finishedAt: zod.number().optional(),
  childSessionId: zod.string().optional(),
  continuationSessionIds: zod.array(zod.string()).optional(),
  childRunId: zod.string().optional(),
  loopxClaimId: zod.string().optional(),
  health: zod.object({
    status: zod.enum(['starting', 'reasoning', 'active', 'checkpointed', 'stalled']),
    startedAt: zod.number(),
    lastModelActivityAt: zod.number().optional(),
    lastDurableProgressAt: zod.number().optional(),
    estimatedReasoningTokens: zod.number(),
    reasoningCharacters: zod.number(),
    inputTokens: zod.number(),
    outputTokens: zod.number(),
    providerReasoningTokens: zod.number(),
    contextWindow: zod.number().optional(),
    maxOutputTokens: zod.number().optional(),
    toolCalls: zod.number(),
    durableActions: zod.number(),
    changedFileCount: zod.number(),
    checkpointCount: zod.number(),
    stalledReason: zod.enum(['first-durable-action-timeout', 'reasoning-budget', 'checkpoint-timeout', 'no-durable-progress-timeout', 'max-wall-time', 'max-tokens-without-progress']).optional(),
  }).strict().optional(),
  executionBudget: executionBudgetSchema.optional(),
  modelProfile: zod.object({
    provider: zod.string(),
    model: zod.string(),
    contextWindow: zod.number().optional(),
    maxOutputTokens: zod.number().optional(),
    reasoningEfforts: zod.array(zod.string()).optional(),
    selectedReasoningEffort: zod.string().optional(),
    concurrencyLimit: zod.number(),
    weightLimit: zod.number().optional(),
    memoryClass: zod.string().optional(),
    availableDeviceBytes: zod.number().optional(),
  }).strict().optional(),
  checkpoints: zod.array(zod.object({
    workId: zod.string(),
    attemptId: zod.string(),
    activation: zod.number(),
    sequence: zod.number(),
    createdAt: zod.number(),
    completedCriteria: zod.array(zod.string()),
    changedFiles: zod.array(zod.object({ path: zod.string(), contentHash: zod.string() }).strict()),
    verification: zod.array(zod.object({ command: zod.string(), exitCode: zod.number(), summary: zod.string() }).strict()),
    remainingWork: zod.array(zod.string()),
    nextAction: zod.string(),
  }).strict()).optional(),
  artifactManifest: zod.object({
    id: zod.string(),
    algorithm: zod.literal('sha256'),
    provider: zod.string(),
    workId: zod.string(),
    operationId: zod.string(),
    attemptId: zod.string(),
    runId: zod.string(),
    generationId: zod.string(),
    ownerEpoch: zod.number(),
    fencingToken: zod.number(),
    createdAt: zod.number(),
    totalBytes: zod.number(),
    entries: zod.array(zod.object({
      path: zod.string(),
      sha256: zod.string(),
      baseSha256: zod.string().nullable().optional(),
      size: zod.number(),
      mode: zod.number(),
      kind: zod.enum(['file', 'symlink']),
    }).strict()),
    providerReference: zod.string(),
  }).strict().optional(),
  error: zod.object({ code: zod.string(), message: zod.string() }).strict().optional(),
}).strict()
const nodeRunSchema = zod.object({
  workId: zod.string(),
  nodeId: zod.string(),
  phase: zod.string(),
  attempts: zod.array(attemptSchema),
  resourceWait: zod.object({
    providerId: zod.string(),
    model: zod.string(),
    reason: zod.enum(['provider-degraded', 'queue', 'concurrency', 'weight', 'memory', 'oom-backoff', 'rate-limit', 'unknown']),
    observedAt: zod.number(),
    retryAt: zod.number(),
  }).strict().optional(),
  output: nodeOutputSchema.optional(),
  suppliedByControlId: zod.string().optional(),
  branchEvaluation: zod.object({
    evaluatedAt: zod.number(),
    decision: zod.enum(['active', 'inactive', 'ambiguous']),
    groups: zod.array(zod.object({
      id: zod.string(),
      mode: zod.enum(['all', 'any', 'exactly-one', 'activated']),
      matched: zod.number(),
      considered: zod.number(),
      active: zod.boolean(),
      members: zod.array(zod.object({
        from: zod.string(),
        matched: zod.boolean(),
        predecessorPhase: zod.string(),
      }).strict()),
    }).strict()),
  }).strict().optional(),
  invalidatedBy: zod.array(zod.string()).optional(),
  reusedFrom: zod.object({ runId: zod.string(), generationId: zod.string(), nodeId: zod.string() }).strict().optional(),
}).strict()
const runSchema = zod.object({
  id: zod.string(),
  graphId: zod.string(),
  revision: zod.number(),
  generation: zod.number(),
  generationId: zod.string(),
  ownerEpoch: zod.number(),
  configSnapshot: configSchema,
  overrides: zod.record(zod.string(), zod.object({
    roleId: zod.string().optional(),
    model: modelSelectionSchema.optional(),
    workerProvider: zod.string().optional(),
    executionBudget: executionBudgetSchema.optional(),
  }).strict()),
  phase: zod.string(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  nodes: zod.record(zod.string(), nodeRunSchema),
  terminal: zod.object({
    outcome: zod.enum(['succeeded', 'failed', 'canceled', 'exhausted']),
    rule: zod.string(),
    acceptedAt: zod.number(),
  }).strict().optional(),
  error: zod.object({
    code: zod.string(),
    message: zod.string(),
    nodeId: zod.string().optional(),
  }).strict().optional(),
}).strict()
const externalReferenceSchema = zod.object({
  kind: zod.enum(['coordination', 'worker', 'workspace', 'model', 'child-session', 'artifact', 'environment']),
  provider: zod.string(),
  id: zod.string(),
  fencingToken: zod.number().optional(),
}).strict()
const operationTransitionSchema = zod.object({
  version: zod.literal(1),
  eventId: zod.string(),
  operationId: zod.string(),
  workId: zod.string(),
  runId: zod.string(),
  generationId: zod.string(),
  graphId: zod.string(),
  revision: zod.number(),
  nodeId: zod.string(),
  ownerEpoch: zod.number(),
  stage: zod.enum(['planned', 'admitted', 'claimed', 'started', 'progress', 'output-staged', 'settlement-pending', 'reconciled', 'terminal']),
  expectedPrevious: zod.enum(['planned', 'admitted', 'claimed', 'started', 'progress', 'output-staged', 'settlement-pending', 'reconciled', 'terminal']).optional(),
  at: zod.number(),
  externalReferences: zod.array(externalReferenceSchema),
  outputHash: zod.string().optional(),
  terminalOutcome: zod.enum(['succeeded', 'failed', 'skipped', 'canceled', 'exhausted', 'uncertain']).optional(),
  detail: zod.string().optional(),
}).strict()
const settlementRecordSchema = zod.object({
  version: zod.literal(2),
  id: zod.string(),
  attempt: zod.number(),
  operationId: zod.string(),
  workId: zod.string(),
  runId: zod.string(),
  generationId: zod.string(),
  ownerEpoch: zod.number(),
  kind: zod.enum(['coordination', 'resource-release', 'artifact', 'environment', 'cancellation', 'compensation']),
  outcome: zod.enum(['pending', 'confirmed', 'failed', 'conflict']),
  requestedAt: zod.number(),
  completedAt: zod.number().optional(),
  externalReference: externalReferenceSchema.optional(),
  evidence: zod.string().optional(),
  error: zod.object({ code: zod.string(), message: zod.string() }).strict().optional(),
}).strict()
const campaignExecutionSchema = zod.object({
  graphId: zod.string(),
  revision: zod.number(),
  runId: zod.string(),
  status: zod.enum(['running', 'succeeded', 'failed', 'canceled', 'exhausted', 'awaiting_user']),
  startedAt: zod.number(),
  completedAt: zod.number().optional(),
  settlementIds: zod.array(zod.string()),
  summary: zod.string().optional(),
}).strict()
const campaignBatchSchema = zod.object({
  id: zod.string(),
  ordinal: zod.number(),
  title: zod.string(),
  objective: zod.string(),
  dependsOn: zod.array(zod.string()),
  status: zod.enum(['planned', 'running', 'approved', 'approved_with_findings', 'rejected', 'needs_user', 'blocked']),
  graphId: zod.string().optional(),
  executions: zod.array(campaignExecutionSchema),
}).strict()
const campaignSchema = zod.object({
  version: zod.literal(1),
  id: zod.string(),
  objective: zod.string(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  phase: zod.enum(['planned', 'running', 'awaiting_user', 'succeeded', 'failed', 'canceled']),
  batches: zod.array(campaignBatchSchema),
  activeBatchId: zod.string().optional(),
  planRevision: zod.number().optional(),
  planExtensions: zod.array(zod.object({
    revision: zod.number(),
    createdAt: zod.number(),
    reason: zod.string(),
    addedBatchIds: zod.array(zod.string()),
    sourceBatchId: zod.string().optional(),
    sourceRunId: zod.string().optional(),
    settlementIds: zod.array(zod.string()),
  }).strict()).optional(),
}).strict()
const revisionLineageSchema = zod.object({
  version: zod.literal(1),
  taskId: zod.string(),
  kind: zod.enum(['new_task', 'analysis_refactor', 'execution_correction']),
  title: zod.string(),
  objective: zod.string(),
  reason: zod.string(),
  creator: zod.enum(['controller', 'human_control', 'recovery']),
  createdAt: zod.number(),
  trigger: zod.object({
    source: zod.enum(['user', 'planning_checkpoint', 'run_failure', 'review_rejection', 'human_control', 'recovery']),
    summary: zod.string(),
    runId: zod.string().optional(),
    nodeId: zod.string().optional(),
    errorCode: zod.string().optional(),
    evidence: zod.array(zod.string()),
  }).strict(),
  relationships: zod.array(zod.object({
    kind: zod.enum(['derived_from', 'refactors', 'corrects', 'supersedes', 'depends_on']),
    graphId: zod.string(),
    revision: zod.number().optional(),
    reason: zod.string(),
  }).strict()),
  successCriteria: zod.array(zod.string()),
  changes: zod.object({
    addedNodeIds: zod.array(zod.string()),
    changedNodeIds: zod.array(zod.string()),
    removedNodeIds: zod.array(zod.string()),
    preservedNodeIds: zod.array(zod.string()),
    invalidatedNodeIds: zod.array(zod.string()),
  }).strict(),
}).strict()
const revisionSubmissionRecordSchema = zod.object({
  version: zod.literal(1),
  id: zod.string(),
  intent: zod.enum(['new', 'revise']),
  graph: revisionSchema,
  run: runSchema,
  changedNodeIds: zod.array(zod.string()),
  outcome: zod.enum(['pending', 'accepted', 'failed']),
  requestedAt: zod.number(),
  completedAt: zod.number().optional(),
  error: zod.object({ code: zod.string(), message: zod.string() }).strict().optional(),
  campaign: campaignSchema.optional(),
  lineage: revisionLineageSchema.optional(),
}).strict()
const reviewIssueSchema = zod.object({
  id: zod.string(),
  severity: zod.enum(['blocking', 'non-blocking']),
  summary: zod.string(),
  evidence: zod.array(zod.string()),
  ownerNodeIds: zod.array(zod.string()),
}).strict()
const expansionProposalSchema = zod.object({
  baseRevision: zod.number(),
  nodes: zod.array(nodeSchema),
  edges: zod.array(edgeSchema),
  branchGroups: zod.array(branchGroupSchema),
  changedNodeIds: zod.array(zod.string()),
  mapKeys: zod.array(zod.union([zod.string(), zod.number()])).optional(),
}).strict()
const checkpointSchema = zod.object({
  id: zod.string(),
  graphId: zod.string(),
  revision: zod.number(),
  runId: zod.string(),
  nodeId: zod.string(),
  kind: zod.enum(['expansion', 'repair', 'planning', 'environment', 'awaiting_user']),
  status: zod.enum(['pending', 'resolved', 'superseded', 'canceled']),
  createdAt: zod.number(),
  iteration: zod.number(),
  reason: zod.string(),
  proposal: expansionProposalSchema.optional(),
  issues: zod.array(reviewIssueSchema).optional(),
  resolvedAt: zod.number().optional(),
  replacementRevision: zod.number().optional(),
  authorizedGeneration: zod.number().optional(),
}).strict()
const controlRecordSchema = zod.object({
  version: zod.literal(2),
  id: zod.string(),
  action: zod.enum(['pause-run', 'modify-task', 'cancel-run', 'cancel-node', 'skip-node', 'retry-node', 'resume-from-node', 'override-node', 'supply-output', 'rollback', 'approve-checkpoint', 'reject-checkpoint', 'reconcile-run']),
  graphId: zod.string(),
  runId: zod.string(),
  expectedRevision: zod.number(),
  expectedGeneration: zod.number(),
  expectedAttemptId: zod.string().optional(),
  nodeId: zod.string().optional(),
  checkpointId: zod.string().optional(),
  targetRevision: zod.number().optional(),
  override: zod.object({
    roleId: zod.string().optional(),
    model: modelSelectionSchema.optional(),
    workerProvider: zod.string().optional(),
    executionBudget: executionBudgetSchema.optional(),
  }).strict().optional(),
  suppliedOutput: nodeOutputSchema.optional(),
  actor: zod.object({
    kind: zod.enum(['human', 'controller', 'system']),
    id: zod.string(),
  }).strict(),
  source: zod.enum(['command', 'host-api', 'recovery']),
  requestedAt: zod.number(),
  completedAt: zod.number(),
  reason: zod.string(),
  result: zod.object({
    outcome: zod.enum(['applied', 'no-op']),
    detail: zod.string().optional(),
  }).strict(),
  impact: zod.object({
    invalidatedNodeIds: zod.array(zod.string()),
    reusedNodeIds: zod.array(zod.string()),
  }).strict(),
  resultingGeneration: zod.number().optional(),
  resultingRevision: zod.number().optional(),
}).strict()

const parseStructure = <T>(schema: ZodType<T>, value: unknown, code: string, message: string): T => {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.join('.')
    return `${path}: ${issue.message}`
  })
  return fail(code, `${message}: ${issues.join('; ')}`)
}

const isGraphJsonValue = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isGraphJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every(item => isGraphJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/**
 * Validate one child-published result before durable or coordination use.
 * @param value result decoded from the child model boundary.
 * @param declared optional node-owned schema enforced after the fixed result fields.
 * @returns assertion that the value is a valid published node output.
 */
export function validateGraphNodeOutput(value: unknown, declared?: GraphOutputSchema): asserts value is import('./types.ts').GraphNodeOutput {
  const output = parseStructure(nodeOutputSchema, value, 'GRAPH_RUN_OUTPUT', 'graph node output must contain summary, optional JSON data, and artifact strings')
  const coordinationSummary = output.coordinationSummary
  if (!normalized(output.summary)
    || (coordinationSummary !== undefined && (!normalized(coordinationSummary) || coordinationSummary.length > 2_000))
    || output.artifacts.some(item => !normalized(item))
    || (output.data !== undefined && !isGraphJsonValue(output.data))) {
    fail('GRAPH_RUN_OUTPUT', 'graph node output must contain normalized text, JSON data, and artifact strings')
  }
  if (declared === undefined) return
  const bytes = new TextEncoder().encode(JSON.stringify(output)).byteLength
  if (bytes > declared.maxBytes) {
    fail('GRAPH_RUN_OUTPUT_SIZE', `graph node output is ${String(bytes)} bytes; schema ${JSON.stringify(declared.id)} allows ${String(declared.maxBytes)}`)
  }
  const violations = validateJsonSchemaValue(declared.schema, output, 'output')
  if (violations.length > 0) {
    fail('GRAPH_RUN_OUTPUT_SCHEMA', `graph node output does not match ${JSON.stringify(declared.id)} v${String(declared.version)}: ${violations.slice(0, 3).join('; ')}`)
  }
}

/**
 * Validate graph-mode settings before committing them.
 * @param value untrusted whole configuration replacement.
 * @returns assertion that the replacement is a valid graph-mode configuration.
 */
export function validateGraphModeConfig(value: unknown): asserts value is GraphModeConfig {
  const config = parseStructure(configSchema, value, 'GRAPH_CONFIG_STRUCTURE', 'graph config fields have invalid types or unknown fields')
  const { globalMaxParallel, controllerReserve, models: modelLimits } = config.limits
  if (!isVersionTwo(config.version)) fail('GRAPH_CONFIG_VERSION', `unsupported graph config version ${String(config.version)}`)
  if (!Number.isSafeInteger(globalMaxParallel) || globalMaxParallel < 1) {
    fail('GRAPH_GLOBAL_PARALLELISM', 'globalMaxParallel must be a positive safe integer')
  }
  if (!Number.isSafeInteger(controllerReserve) || controllerReserve < 1
    || controllerReserve >= globalMaxParallel) {
    fail('GRAPH_CONTROLLER_RESERVE', 'controllerReserve must be at least one and less than globalMaxParallel')
  }
  const ids = new Set<string>()
  let controllers = 0
  let workers = 0
  for (const item of config.roles) {
    if (!normalized(item.id) || !SAFE_ID.test(item.id) || ids.has(item.id)) {
      fail('GRAPH_ROLE_ID', `role id ${JSON.stringify(item.id)} is unsafe or duplicated`)
    }
    ids.add(item.id)
    if (!normalized(item.label) || !normalized(item.description) || !normalized(item.prompt)) {
      fail('GRAPH_ROLE_TEXT', `role ${JSON.stringify(item.id)} has blank or unnormalized text`)
    }
    if (item.workerProvider !== undefined && !normalized(item.workerProvider)) {
      fail('GRAPH_ROLE_WORKER_PROVIDER', `role ${JSON.stringify(item.id)} has an invalid worker Provider`)
    }
    for (const modelValue of Object.values(item.model)) {
      if (!normalized(modelValue)) {
        fail('GRAPH_ROLE_MODEL', `role ${JSON.stringify(item.id)} has an invalid model selection`)
      }
    }
    if (!Number.isSafeInteger(item.maxParallel) || item.maxParallel < 1) {
      fail('GRAPH_ROLE_PARALLELISM', `role ${JSON.stringify(item.id)} maxParallel must be positive`)
    }
    if (item.controller && item.enabled) controllers++
    if (!item.controller && item.enabled) workers++
  }
  if (controllers !== 1) fail('GRAPH_CONTROLLER_COUNT', `graph mode requires exactly one enabled controller, got ${String(controllers)}`)
  if (workers < 1) fail('GRAPH_WORKER_COUNT', 'graph mode requires at least one enabled worker')
  const modelKeys = new Set<string>()
  for (const limit of modelLimits) {
    const { model, provider, maxParallel, maxWeight } = limit
    if (!normalized(model) || (provider !== undefined && !normalized(provider))
      || !Number.isSafeInteger(maxParallel) || maxParallel < 1) {
      fail('GRAPH_MODEL_LIMIT', 'each model limit needs a normalized model and positive maxParallel')
    }
    const key = JSON.stringify([provider ?? null, model])
    if (modelKeys.has(key)) fail('GRAPH_MODEL_LIMIT_DUPLICATE', `duplicate model limit for ${JSON.stringify(model)}`)
    modelKeys.add(key)
    if (maxWeight !== undefined && (!Number.isFinite(maxWeight) || maxWeight <= 0)) {
      fail('GRAPH_MODEL_WEIGHT', `model ${JSON.stringify(model)} maxWeight must be positive`)
    }
  }
  for (const [name, limit] of Object.entries(config.executionPolicy)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      fail('GRAPH_EXECUTION_POLICY', `${name} must be a positive safe integer`)
    }
  }
  for (const name of ['firstDurableActionMs', 'maxNoDurableProgressMs', 'checkpointIntervalMs', 'maxWallTimeMs'] as const) {
    if (config.executionPolicy[name] > MAX_GRAPH_TIMER_MS) {
      fail('GRAPH_EXECUTION_POLICY', `${name} cannot exceed the Node timer limit ${String(MAX_GRAPH_TIMER_MS)}ms`)
    }
  }
  if (config.executionPolicy.maxRepairRevisions > config.executionPolicy.maxGraphRevisions) {
    fail('GRAPH_EXECUTION_POLICY', 'maxRepairRevisions cannot exceed maxGraphRevisions')
  }
}

const EXECUTION_POLICY_KEYS = [
  'maxNodesPerRevision',
  'maxAttemptsPerNode',
  'maxGraphRevisions',
  'maxRepairRevisions',
  'maxDynamicExpansions',
  'maxSubgraphDepth',
  'maxRuntimeContinuations',
  'maxOutputTokens',
  'maxReasoningOnlyTokens',
  'firstDurableActionMs',
  'maxNoDurableProgressMs',
  'checkpointIntervalMs',
  'maxWallTimeMs',
  'maxOutputBytes',
  'noProgressLimit',
] as const

const ZEROABLE_TERMINATION_KEYS = new Set<keyof GraphExecutionPolicy>([
  'maxRepairRevisions',
  'maxDynamicExpansions',
  'maxSubgraphDepth',
  'maxRuntimeContinuations',
])

/** Reject a revision policy that exceeds the session-owned deployment ceilings. */
function validateTerminationPolicy(graph: GraphRevision, config: GraphModeConfig): void {
  for (const key of EXECUTION_POLICY_KEYS) {
    const value = graph.terminationPolicy[key]
    const minimum = ZEROABLE_TERMINATION_KEYS.has(key) ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum || value > config.executionPolicy[key]) {
      fail('GRAPH_TERMINATION_POLICY', `${key} must be ${minimum === 0 ? 'non-negative' : 'positive'} and cannot exceed the session execution policy`)
    }
  }
  if (graph.terminationPolicy.maxRepairRevisions > graph.terminationPolicy.maxGraphRevisions) {
    fail('GRAPH_TERMINATION_POLICY', 'maxRepairRevisions cannot exceed maxGraphRevisions')
  }
  if (graph.revision > graph.terminationPolicy.maxGraphRevisions) {
    fail('GRAPH_TERMINATION_POLICY', `revision ${String(graph.revision)} exceeds maxGraphRevisions`)
  }
}

/**
 * Validate one immutable controller-produced graph revision.
 * @param value untrusted complete graph revision.
 * @param config active role and scheduling configuration.
 * @returns assertion that the value is a valid revision for the configuration.
 */
export function validateGraphRevision(value: unknown, config: GraphModeConfig): asserts value is GraphRevision {
  validateGraphModeConfig(config)
  const graph = parseStructure(revisionSchema, value, 'GRAPH_REVISION_STRUCTURE', 'graph revision fields have invalid types or unknown fields') as unknown as GraphRevision
  if (!normalized(graph.graphId) || !SAFE_ID.test(graph.graphId) || !normalized(graph.objective) || !normalized(graph.userInput)) {
    fail('GRAPH_REVISION_TEXT', 'graph id, objective, and userInput must be normalized non-empty strings')
  }
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 1
    || !Number.isSafeInteger(graph.createdAt) || graph.createdAt < 0) {
    fail('GRAPH_REVISION_NUMBER', 'graph revision must be positive and createdAt must be non-negative')
  }
  if ((graph.revision === 1) !== (graph.parentRevision === undefined)
    || (graph.parentRevision !== undefined && graph.parentRevision !== graph.revision - 1)) {
    fail('GRAPH_PARENT_REVISION', 'revision one has no parent; later revisions must name the preceding revision')
  }
  validateTerminationPolicy(graph, config)
  if (graph.nodes.length > graph.terminationPolicy.maxNodesPerRevision) {
    fail('GRAPH_NODE_LIMIT', `revision has ${String(graph.nodes.length)} nodes; policy allows ${String(graph.terminationPolicy.maxNodesPerRevision)}`)
  }
  const roles = new Map(config.roles.filter(item => item.enabled).map(item => [item.id, item]))
  const nodes = new Map<GraphNodeId, GraphRevision['nodes'][number]>()
  for (const node of graph.nodes) {
    if (!normalized(node.id) || !SAFE_ID.test(node.id) || nodes.has(node.id)) {
      fail('GRAPH_NODE_ID', `node id ${JSON.stringify(node.id)} is unsafe or duplicated`)
    }
    if (!normalized(node.title) || !normalized(node.objective) || node.acceptanceCriteria.length === 0
      || node.acceptanceCriteria.some(item => !normalized(item))) {
      fail('GRAPH_NODE_TEXT', `node ${JSON.stringify(node.id)} needs normalized text and acceptance criteria`)
    }
    if (!TASK_KINDS.has(node.kind)) fail('GRAPH_NODE_KIND', `node ${JSON.stringify(node.id)} has unsupported kind ${JSON.stringify(node.kind)}`)
    const assignedRole = roles.get(node.roleId)
      ?? fail('GRAPH_NODE_ROLE', `node ${JSON.stringify(node.id)} names unavailable role ${JSON.stringify(node.roleId)}`)
    if (assignedRole.controller) fail('GRAPH_NODE_CONTROLLER', `node ${JSON.stringify(node.id)} cannot be assigned to the controller role`)
    if (!Number.isSafeInteger(node.maxAttempts) || node.maxAttempts < 1
      || node.maxAttempts > graph.terminationPolicy.maxAttemptsPerNode
      || !Number.isFinite(node.weight) || node.weight <= 0) {
      fail('GRAPH_NODE_POLICY', `node ${JSON.stringify(node.id)} has an invalid attempt or weight policy`)
    }
    const budgetCeilings = {
      maxOutputTokens: graph.terminationPolicy.maxOutputTokens,
      maxReasoningOnlyTokens: graph.terminationPolicy.maxReasoningOnlyTokens,
      firstDurableActionMs: graph.terminationPolicy.firstDurableActionMs,
      maxNoDurableProgressMs: graph.terminationPolicy.maxNoDurableProgressMs,
      checkpointIntervalMs: graph.terminationPolicy.checkpointIntervalMs,
      maxWallTimeMs: graph.terminationPolicy.maxWallTimeMs,
      maxContinuations: graph.terminationPolicy.maxRuntimeContinuations,
    }
    for (const [name, limit] of Object.entries(node.executionBudget)) {
      const minimum = name === 'maxContinuations' ? 0 : 1
      if (!Number.isSafeInteger(limit) || limit < minimum || limit > budgetCeilings[name as keyof typeof budgetCeilings]) {
        fail('GRAPH_NODE_BUDGET', `node ${JSON.stringify(node.id)} ${name} must be ${minimum === 0 ? 'non-negative' : 'positive'} and cannot exceed the graph termination policy`)
      }
    }
    if (!normalized(node.outputSchema.id) || !SAFE_ID.test(node.outputSchema.id)
      || !Number.isSafeInteger(node.outputSchema.version) || node.outputSchema.version < 1
      || !Number.isSafeInteger(node.outputSchema.maxBytes) || node.outputSchema.maxBytes < 1
      || node.outputSchema.maxBytes > graph.terminationPolicy.maxOutputBytes) {
      fail('GRAPH_OUTPUT_SCHEMA', `node ${JSON.stringify(node.id)} has invalid output schema identity, version, or byte limit`)
    }
    try {
      assertObjectJsonSchema(node.outputSchema.schema)
    } catch (error) {
      fail('GRAPH_OUTPUT_SCHEMA', `node ${JSON.stringify(node.id)} has unsupported output schema: ${error instanceof Error ? error.message : String(error)}`)
    }
    if ((node.kind === 'expansion') !== (node.expansion !== undefined)
      || (node.kind === 'subgraph') !== (node.subgraph !== undefined)
      || (node.kind === 'environment') !== (node.environment !== undefined)) {
      fail('GRAPH_NODE_SPECIALIZATION', `node ${JSON.stringify(node.id)} must carry only the specification required by its kind`)
    }
    if (node.expansion !== undefined) {
      const { mode, maxNodes, itemPath, itemKeyPath } = node.expansion
      if (!Number.isSafeInteger(maxNodes) || maxNodes < 1
        || maxNodes > graph.terminationPolicy.maxNodesPerRevision
        || (mode === 'map') !== (itemPath !== undefined && itemKeyPath !== undefined)
        || itemPath?.some(part => !normalized(part)) === true
        || itemKeyPath?.some(part => !normalized(part)) === true) {
        fail('GRAPH_EXPANSION', `node ${JSON.stringify(node.id)} has an invalid bounded expansion specification`)
      }
    }
    if (node.subgraph !== undefined) {
      const mappings = [...Object.entries(node.subgraph.input), ...Object.entries(node.subgraph.output)]
      if (!normalized(node.subgraph.graphId) || !SAFE_ID.test(node.subgraph.graphId)
        || node.subgraph.graphId === graph.graphId
        || !Number.isSafeInteger(node.subgraph.revision) || node.subgraph.revision < 1
        || mappings.some(([key, path]) => !normalized(key) || path.some(part => !normalized(part)))) {
        fail('GRAPH_SUBGRAPH', `node ${JSON.stringify(node.id)} has an invalid subgraph reference or mapping`)
      }
    }
    if (node.environment !== undefined) {
      const capabilitySet = new Set(node.environment.requiredCapabilities)
      const operationIds = new Set<string>()
      if (capabilitySet.size === 0 || capabilitySet.size !== node.environment.requiredCapabilities.length
        || node.environment.requiredCapabilities.some(capability => !ENVIRONMENT_CAPABILITIES.has(capability))) {
        fail('GRAPH_ENVIRONMENT_CAPABILITIES', `node ${JSON.stringify(node.id)} has invalid or duplicate environment capabilities`)
      }
      if (node.environment.operations.length === 0
        || node.environment.operations.length > MAX_GRAPH_ENVIRONMENT_OPERATIONS) {
        fail('GRAPH_ENVIRONMENT_OPERATIONS', `node ${JSON.stringify(node.id)} must declare between 1 and ${String(MAX_GRAPH_ENVIRONMENT_OPERATIONS)} environment operations`)
      }
      for (const operation of node.environment.operations) {
        if (!normalized(operation.id) || !SAFE_ID.test(operation.id) || operationIds.has(operation.id)
          || !normalized(operation.description) || !normalized(operation.command)
          || (operation.rollbackCommand !== undefined && !normalized(operation.rollbackCommand))) {
          fail('GRAPH_ENVIRONMENT_OPERATIONS', `node ${JSON.stringify(node.id)} has an invalid or duplicate environment operation`)
        }
        operationIds.add(operation.id)
      }
      if (new TextEncoder().encode(graphEnvironmentApprovalText(node.environment)).byteLength
        > MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES) {
        fail('GRAPH_ENVIRONMENT_APPROVAL_SIZE', `node ${JSON.stringify(node.id)} environment approval text exceeds ${String(MAX_GRAPH_ENVIRONMENT_APPROVAL_BYTES)} bytes`)
      }
      const workspace = node.workspace
      if (node.effectPolicy !== 'manual' || node.maxAttempts !== 1 || workspace === undefined
        || workspace.mode !== 'shared' || workspace.cleanup !== 'retain') {
        fail('GRAPH_ENVIRONMENT_POLICY', `node ${JSON.stringify(node.id)} environment effects require maxAttempts 1, manual recovery, and a retained shared workspace`)
      }
    }
    if (node.workspace !== undefined) {
      const validRoot = (root: string): boolean => root === '.' || (normalized(root)
        && !root.includes('\\') && !root.startsWith('/') && !/^[A-Za-z]:/.test(root)
        && root.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
      if (node.workspace.readRoots.some(root => !validRoot(root))
        || node.workspace.writeRoots.some(root => !validRoot(root))
        || new Set(node.workspace.readRoots).size !== node.workspace.readRoots.length
        || new Set(node.workspace.writeRoots).size !== node.workspace.writeRoots.length
        || (node.workspace.mode === 'read-only-snapshot' && node.workspace.writeRoots.length > 0)) {
        fail('GRAPH_NODE_WORKSPACE', `node ${JSON.stringify(node.id)} has invalid workspace roots or write policy`)
      }
    }
    nodes.set(node.id, node)
  }
  if (nodes.size === 0) fail('GRAPH_EMPTY', 'a graph revision must contain at least one node')
  const successors = new Map<GraphNodeId, GraphNodeId[]>()
  const groups = new Map<GraphBranchGroupId, GraphRevision['branchGroups'][number]>()
  for (const group of graph.branchGroups) {
    if (!normalized(group.id) || !SAFE_ID.test(group.id) || groups.has(group.id)
      || !nodes.has(group.to) || !BRANCH_MODES.has(group.mode)) {
      fail('GRAPH_BRANCH_GROUP', `branch group ${JSON.stringify(group.id)} has invalid identity, target, or mode`)
    }
    groups.set(group.id, group)
  }
  const groupMembers = new Map<GraphBranchGroupId, number>()
  const edgeKeys = new Set<string>()
  for (const edge of graph.edges) {
    if (!EDGE_KINDS.has(edge.kind)) fail('GRAPH_EDGE_KIND', `edge has unsupported kind ${JSON.stringify(edge.kind)}`)
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) {
      fail('GRAPH_EDGE_ENDPOINT', `edge ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)} has an invalid endpoint`)
    }
    const key = `${edge.from}\u0000${edge.to}`
    if (edgeKeys.has(key)) fail('GRAPH_EDGE_DUPLICATE', `duplicate edge ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)}`)
    edgeKeys.add(key)
    if (edge.kind === 'conditional'
      ? edge.condition === undefined || edge.branchGroupId === undefined
      : edge.condition !== undefined || edge.branchGroupId !== undefined) {
      fail('GRAPH_EDGE_CONDITION', 'conditional edges carry both a condition and branchGroupId; other edges carry neither')
    }
    if (edge.condition !== undefined) {
      if (!CONDITION_OPERATORS.has(edge.condition.operator)
        || edge.condition.path.some(part => !normalized(part))
        || (['equals', 'not-equals'].includes(edge.condition.operator) && edge.condition.value === undefined)
        || (['exists', 'truthy'].includes(edge.condition.operator) && edge.condition.value !== undefined)
        || (edge.condition.value !== undefined && !isGraphJsonValue(edge.condition.value))) {
        fail('GRAPH_CONDITION', `edge ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)} has an invalid condition`)
      }
    }
    if (edge.branchGroupId !== undefined) {
      const group = groups.get(edge.branchGroupId)
        ?? fail('GRAPH_BRANCH_GROUP', `edge names unknown branch group ${JSON.stringify(edge.branchGroupId)}`)
      if (group.to !== edge.to) {
        fail('GRAPH_BRANCH_GROUP', `edge target ${JSON.stringify(edge.to)} differs from branch group ${JSON.stringify(group.id)} target`)
      }
      groupMembers.set(group.id, (groupMembers.get(group.id) ?? 0) + 1)
    }
    const list = successors.get(edge.from) ?? []
    list.push(edge.to)
    successors.set(edge.from, list)
  }
  for (const group of groups.values()) {
    if ((groupMembers.get(group.id) ?? 0) === 0) {
      fail('GRAPH_BRANCH_GROUP', `branch group ${JSON.stringify(group.id)} has no conditional edge members`)
    }
  }
  const visiting = new Set<GraphNodeId>()
  const visited = new Set<GraphNodeId>()
  const visit = (id: GraphNodeId): void => {
    if (visiting.has(id)) fail('GRAPH_CYCLE', `graph contains a cycle through ${JSON.stringify(id)}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const next of successors.get(id) ?? []) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)

  const reaches = (from: GraphNodeId, to: GraphNodeId, seen = new Set<GraphNodeId>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (successors.get(from) ?? []).some(next => reaches(next, to, seen))
  }
  const overlap = (left: string, right: string): boolean => left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  const owned = [...nodes.values()].filter(node => node.workspace !== undefined && node.workspace.writeRoots.length > 0)
  for (let leftIndex = 0; leftIndex < owned.length; leftIndex++) {
    const left = owned[leftIndex] as GraphRevision['nodes'][number]
    for (let rightIndex = leftIndex + 1; rightIndex < owned.length; rightIndex++) {
      const right = owned[rightIndex] as GraphRevision['nodes'][number]
      if (reaches(left.id, right.id) || reaches(right.id, left.id)) continue
      const conflicts = (left.workspace?.writeRoots ?? []).some(leftRoot => (
        right.workspace?.writeRoots ?? []
      ).some(rightRoot => overlap(leftRoot, rightRoot)))
      if (conflicts) {
        fail('GRAPH_WORKSPACE_OWNERSHIP', `concurrent nodes ${JSON.stringify(left.id)} and ${JSON.stringify(right.id)} declare overlapping write roots`)
      }
    }
  }
}

/**
 * Validate a durable whole-run snapshot against its immutable graph revision.
 * @param value whole replacement snapshot carried by `graph/run`.
 * @param graph immutable revision the run executes.
 * @returns assertion that the value is a valid run of the named revision.
 */
export function validateGraphRun(value: unknown, graph: GraphRevision): asserts value is GraphRun {
  const run = parseStructure(runSchema, value, 'GRAPH_RUN_STRUCTURE', 'graph run fields have invalid types or unknown fields') as unknown as GraphRun
  validateGraphModeConfig(run.configSnapshot)
  if (!normalized(run.id) || !SAFE_ID.test(run.id) || run.graphId !== graph.graphId
    || run.revision !== graph.revision || !RUN_PHASES.has(run.phase)
    || !Number.isSafeInteger(run.generation) || run.generation < 1
    || !normalized(run.generationId) || !SAFE_ID.test(run.generationId)
    || !Number.isSafeInteger(run.ownerEpoch) || run.ownerEpoch < 1
    || !Number.isSafeInteger(run.createdAt) || run.createdAt < 0
    || !Number.isSafeInteger(run.updatedAt) || run.updatedAt < run.createdAt) {
    fail('GRAPH_RUN_STRUCTURE', `run ${JSON.stringify(run.id)} has invalid identity, phase, or timestamps`)
  }
  const definitions = new Map(graph.nodes.map(node => [node.id, node]))
  const enabledWorkers = new Map(run.configSnapshot.roles.filter(role => role.enabled && !role.controller).map(role => [role.id, role]))
  for (const [nodeId, override] of Object.entries(run.overrides)) {
    if (!definitions.has(GraphNodeId(nodeId)) || (override.roleId !== undefined && !enabledWorkers.has(override.roleId))
      || Object.values(override.model ?? {}).some(value => !normalized(value))
      || (override.workerProvider !== undefined && !normalized(override.workerProvider))) {
      fail('GRAPH_RUN_OVERRIDE', `run ${JSON.stringify(run.id)} has an invalid execution override for node ${JSON.stringify(nodeId)}`)
    }
  }
  const keys = Object.keys(run.nodes)
  if (keys.length !== definitions.size || keys.some(key => !definitions.has(GraphNodeId(key)))) {
    fail('GRAPH_RUN_NODES', `run ${JSON.stringify(run.id)} must contain exactly the revision's nodes`)
  }
  for (const [key, state] of Object.entries(run.nodes)) {
    const definition = definitions.get(GraphNodeId(key)) as GraphRevision['nodes'][number]
    if (!normalized(state.workId) || !SAFE_ID.test(state.workId)
      || state.nodeId !== key || !NODE_PHASES.has(state.phase)) {
      fail('GRAPH_RUN_NODE', `run ${JSON.stringify(run.id)} has invalid state for node ${JSON.stringify(key)}`)
    }
    if (state.attempts.length > definition.maxAttempts) {
      fail('GRAPH_RUN_ATTEMPTS', `node ${JSON.stringify(key)} has attempts inconsistent with its phase or policy`)
    }
    const attemptIds = new Set<string>()
    for (const [index, attempt] of state.attempts.entries()) {
      if (!normalized(attempt.id) || !SAFE_ID.test(attempt.id) || attemptIds.has(attempt.id)
        || attempt.number !== index + 1 || !Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < run.createdAt
        || (attempt.finishedAt !== undefined && (!Number.isSafeInteger(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt))
        || (attempt.childSessionId !== undefined && !normalized(attempt.childSessionId))
        || (attempt.continuationSessionIds !== undefined && (attempt.continuationSessionIds.some(id => !normalized(id))
          || new Set(attempt.continuationSessionIds).size !== attempt.continuationSessionIds.length))
        || (attempt.childRunId !== undefined && (!normalized(attempt.childRunId) || !SAFE_ID.test(attempt.childRunId)))
        || (attempt.loopxClaimId !== undefined && !normalized(attempt.loopxClaimId))
        || (attempt.error !== undefined && (!normalized(attempt.error.code) || !normalized(attempt.error.message)))) {
        fail('GRAPH_RUN_ATTEMPT', `node ${JSON.stringify(key)} has invalid attempt ${String(index + 1)}`)
      }
      const health = attempt.health
      if (health !== undefined && (!Number.isSafeInteger(health.startedAt) || health.startedAt < attempt.startedAt
        || (health.lastModelActivityAt !== undefined
          && (!Number.isSafeInteger(health.lastModelActivityAt) || health.lastModelActivityAt < health.startedAt))
        || (health.lastDurableProgressAt !== undefined
          && (!Number.isSafeInteger(health.lastDurableProgressAt) || health.lastDurableProgressAt < health.startedAt))
        || [health.estimatedReasoningTokens, health.reasoningCharacters, health.inputTokens, health.outputTokens,
          health.providerReasoningTokens, health.toolCalls, health.durableActions, health.changedFileCount, health.checkpointCount]
          .some(value => !Number.isSafeInteger(value) || value < 0)
        || (health.contextWindow !== undefined && (!Number.isSafeInteger(health.contextWindow) || health.contextWindow < 1))
        || (health.maxOutputTokens !== undefined && (!Number.isSafeInteger(health.maxOutputTokens) || health.maxOutputTokens < 1))
        || health.checkpointCount !== (attempt.checkpoints?.length ?? 0)
        || (health.status === 'stalled') !== (health.stalledReason !== undefined))) {
        fail('GRAPH_RUN_HEALTH', `node ${JSON.stringify(key)} has invalid attempt health`)
      }
      if (attempt.executionBudget !== undefined) {
        const ceilings = {
          maxOutputTokens: graph.terminationPolicy.maxOutputTokens,
          maxReasoningOnlyTokens: graph.terminationPolicy.maxReasoningOnlyTokens,
          firstDurableActionMs: graph.terminationPolicy.firstDurableActionMs,
          maxNoDurableProgressMs: graph.terminationPolicy.maxNoDurableProgressMs,
          checkpointIntervalMs: graph.terminationPolicy.checkpointIntervalMs,
          maxWallTimeMs: graph.terminationPolicy.maxWallTimeMs,
          maxContinuations: graph.terminationPolicy.maxRuntimeContinuations,
        }
        for (const [name, limit] of Object.entries(attempt.executionBudget)) {
          const minimum = name === 'maxContinuations' ? 0 : 1
          if (!Number.isSafeInteger(limit) || limit < minimum || limit > ceilings[name as keyof typeof ceilings]) {
            fail('GRAPH_RUN_BUDGET', `node ${JSON.stringify(key)} has an attempt budget outside the graph termination policy`)
          }
        }
      }
      if (attempt.modelProfile !== undefined && (!normalized(attempt.modelProfile.provider)
        || !normalized(attempt.modelProfile.model)
        || (attempt.modelProfile.contextWindow !== undefined
          && (!Number.isSafeInteger(attempt.modelProfile.contextWindow) || attempt.modelProfile.contextWindow < 1))
        || (attempt.modelProfile.maxOutputTokens !== undefined
          && (!Number.isSafeInteger(attempt.modelProfile.maxOutputTokens) || attempt.modelProfile.maxOutputTokens < 1))
        || !Number.isSafeInteger(attempt.modelProfile.concurrencyLimit) || attempt.modelProfile.concurrencyLimit < 1
        || (attempt.modelProfile.weightLimit !== undefined
          && (!Number.isFinite(attempt.modelProfile.weightLimit) || attempt.modelProfile.weightLimit <= 0))
        || (attempt.modelProfile.memoryClass !== undefined && !normalized(attempt.modelProfile.memoryClass))
        || (attempt.modelProfile.availableDeviceBytes !== undefined
          && (!Number.isSafeInteger(attempt.modelProfile.availableDeviceBytes) || attempt.modelProfile.availableDeviceBytes < 0))
        || attempt.modelProfile.reasoningEfforts?.some(effort => !normalized(effort)) === true
        || (attempt.modelProfile.selectedReasoningEffort !== undefined && !normalized(attempt.modelProfile.selectedReasoningEffort)))) {
        fail('GRAPH_RUN_MODEL_PROFILE', `node ${JSON.stringify(key)} has an invalid attempt model profile`)
      }
      for (const [checkpointIndex, checkpoint] of (attempt.checkpoints ?? []).entries()) {
        if (checkpoint.workId !== state.workId || checkpoint.attemptId !== attempt.id
          || !Number.isSafeInteger(checkpoint.activation) || checkpoint.activation < 0
          || checkpoint.sequence !== checkpointIndex + 1
          || !Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < attempt.startedAt
          || checkpoint.completedCriteria.some(item => !normalized(item))
          || checkpoint.changedFiles.some(item => !normalized(item.path) || !normalized(item.contentHash))
          || checkpoint.verification.some(item => !normalized(item.command) || !normalized(item.summary)
            || !Number.isSafeInteger(item.exitCode))
          || checkpoint.remainingWork.some(item => !normalized(item))
          || !normalized(checkpoint.nextAction)) {
          fail('GRAPH_RUN_CHECKPOINT', `node ${JSON.stringify(key)} has invalid execution checkpoint ${String(checkpointIndex + 1)}`)
        }
      }
      const manifest = attempt.artifactManifest
      if (manifest !== undefined) {
        let totalBytes = 0
        let previousPath: string | undefined
        for (const entry of manifest.entries) {
          totalBytes += entry.size
          if (!normalized(entry.path) || entry.path.includes('\\') || entry.path.startsWith('/')
            || entry.path === '..' || entry.path.startsWith('../')
            || (previousPath !== undefined && previousPath.localeCompare(entry.path) >= 0)
            || !/^[a-f0-9]{64}$/u.test(entry.sha256)
            || (entry.baseSha256 !== undefined && entry.baseSha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.baseSha256))
            || !Number.isSafeInteger(entry.size) || entry.size < 0
            || !Number.isSafeInteger(entry.mode) || entry.mode < 0) {
            fail('GRAPH_RUN_ARTIFACT', `node ${JSON.stringify(key)} has an invalid artifact entry`)
          }
          previousPath = entry.path
        }
        if (!normalized(manifest.id) || !normalized(manifest.provider) || !normalized(manifest.operationId)
          || !normalized(manifest.providerReference) || manifest.workId !== state.workId || manifest.attemptId !== attempt.id
          || !normalized(manifest.runId) || !normalized(manifest.generationId)
          || !Number.isSafeInteger(manifest.ownerEpoch) || manifest.ownerEpoch < 1
          || !Number.isSafeInteger(manifest.fencingToken) || manifest.fencingToken < 1
          || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < attempt.startedAt
          || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== totalBytes) {
          fail('GRAPH_RUN_ARTIFACT', `node ${JSON.stringify(key)} has invalid artifact attribution`)
        }
      }
      attemptIds.add(attempt.id)
    }
    if (state.output !== undefined) {
      validateGraphNodeOutput(state.output, definition.outputSchema)
    }
    if (state.suppliedByControlId !== undefined && (!normalized(state.suppliedByControlId) || !SAFE_ID.test(state.suppliedByControlId)
      || state.output === undefined || state.attempts.length !== 0)) {
      fail('GRAPH_RUN_SUPPLIED_OUTPUT', `node ${JSON.stringify(key)} has invalid supplied-output provenance`)
    }
    if (state.resourceWait !== undefined && (!normalized(state.resourceWait.providerId) || !normalized(state.resourceWait.model)
      || !Number.isSafeInteger(state.resourceWait.observedAt) || state.resourceWait.observedAt < run.createdAt
      || !Number.isSafeInteger(state.resourceWait.retryAt) || state.resourceWait.retryAt < 0)) {
      fail('GRAPH_RUN_RESOURCE_WAIT', `node ${JSON.stringify(key)} has invalid resource-wait evidence`)
    }
    if (state.branchEvaluation !== undefined) {
      const groups = graph.branchGroups.filter(group => group.to === state.nodeId)
      if (!Number.isSafeInteger(state.branchEvaluation.evaluatedAt)
        || state.branchEvaluation.evaluatedAt < run.createdAt
        || state.branchEvaluation.groups.length !== groups.length
        || state.branchEvaluation.groups.some((evaluation, index) => evaluation.id !== groups[index]?.id
          || evaluation.mode !== groups[index].mode
          || !Number.isSafeInteger(evaluation.matched) || !Number.isSafeInteger(evaluation.considered)
          || evaluation.matched < 0 || evaluation.matched > evaluation.considered
          || evaluation.members.length !== evaluation.considered
          || evaluation.members.some(member => !definitions.has(member.from) || !NODE_PHASES.has(member.predecessorPhase)))) {
        fail('GRAPH_RUN_BRANCH', `node ${JSON.stringify(key)} has invalid branch evaluation evidence`)
      }
    }
    if (state.phase === 'succeeded' && state.output === undefined) {
      fail('GRAPH_RUN_OUTPUT', `succeeded node ${JSON.stringify(key)} must publish output`)
    }
    if (state.invalidatedBy !== undefined && state.invalidatedBy.some(id => !definitions.has(id))) {
      fail('GRAPH_RUN_INVALIDATION', `node ${JSON.stringify(key)} has an invalid invalidation source`)
    }
    if (state.reusedFrom !== undefined && (!normalized(state.reusedFrom.runId)
      || !normalized(state.reusedFrom.generationId) || !SAFE_ID.test(state.reusedFrom.generationId)
      || !normalized(state.reusedFrom.nodeId) || !definitions.has(state.reusedFrom.nodeId))) {
      fail('GRAPH_RUN_REUSE', `node ${JSON.stringify(key)} has invalid reuse provenance`)
    }
  }
  if (run.error !== undefined && (!normalized(run.error.code) || !normalized(run.error.message)
    || (run.error.nodeId !== undefined && !definitions.has(run.error.nodeId)))) {
    fail('GRAPH_RUN_ERROR', `run ${JSON.stringify(run.id)} has invalid terminal failure evidence`)
  }
  if (run.terminal !== undefined && (!normalized(run.terminal.rule)
    || !Number.isSafeInteger(run.terminal.acceptedAt) || run.terminal.acceptedAt < run.createdAt
    || run.terminal.acceptedAt > run.updatedAt || run.terminal.outcome !== run.phase)) {
    fail('GRAPH_RUN_TERMINAL', `run ${JSON.stringify(run.id)} has invalid terminal evidence`)
  }
  const phases = Object.values(run.nodes).map(node => node.phase)
  if (run.phase === 'succeeded' && phases.some(phase => !['succeeded', 'skipped'].includes(phase))) {
    fail('GRAPH_RUN_TERMINAL', 'a succeeded run may contain only succeeded or skipped nodes')
  }
  if (run.phase === 'succeeded' && run.error !== undefined) {
    fail('GRAPH_RUN_ERROR', 'a succeeded run cannot retain terminal failure evidence')
  }
  if (['failed', 'canceled', 'exhausted'].includes(run.phase) && phases.some(phase => !terminalNodePhase(phase))) {
    fail('GRAPH_RUN_TERMINAL', `a ${run.phase} run may contain only terminal nodes`)
  }
  if (['succeeded', 'failed', 'canceled', 'exhausted'].includes(run.phase) !== (run.terminal !== undefined)) {
    fail('GRAPH_RUN_TERMINAL', 'terminal run phases require terminal evidence and nonterminal phases forbid it')
  }
}

/** Validate one operation-journal transition before replay accepts it. */
function validateOperationTransition(value: unknown, state: GraphProjection): GraphOperationTransition {
  const transition = parseStructure(operationTransitionSchema, value, 'GRAPH_OPERATION_STRUCTURE', 'graph operation fields have invalid types or unknown fields') as unknown as GraphOperationTransition
  const run = state.runs[transition.runId]
    ?? fail('GRAPH_OPERATION_RUN', `operation ${JSON.stringify(transition.eventId)} names unknown run ${JSON.stringify(transition.runId)}`)
  if (![transition.eventId, transition.operationId, transition.workId, transition.generationId, transition.graphId, transition.nodeId]
    .every(value => normalized(value) && SAFE_ID.test(value))) {
    fail('GRAPH_OPERATION_ID', 'graph operation identities must be normalized safe ids')
  }
  if (transition.graphId !== run.graphId || transition.revision !== run.revision
    || transition.generationId !== run.generationId || transition.ownerEpoch !== run.ownerEpoch
    || run.nodes[transition.nodeId]?.workId !== transition.workId
    || !Number.isSafeInteger(transition.at) || transition.at < run.createdAt
    || !Number.isSafeInteger(transition.ownerEpoch) || transition.ownerEpoch < 1) {
    fail('GRAPH_OPERATION_IDENTITY', `operation ${JSON.stringify(transition.eventId)} does not match its durable run identity`)
  }
  if (transition.outputHash !== undefined && (!normalized(transition.outputHash) || !SAFE_ID.test(transition.outputHash))) {
    fail('GRAPH_OPERATION_OUTPUT', 'operation outputHash must be a normalized safe id')
  }
  if ((transition.stage === 'output-staged') !== (transition.outputHash !== undefined)) {
    fail('GRAPH_OPERATION_OUTPUT', 'exactly output-staged transitions carry outputHash')
  }
  if ((transition.stage === 'terminal') !== (transition.terminalOutcome !== undefined)) {
    fail('GRAPH_OPERATION_TERMINAL', 'exactly terminal transitions carry terminalOutcome')
  }
  if (transition.detail !== undefined && (!normalized(transition.detail) || transition.detail.length > 4_000)) {
    fail('GRAPH_OPERATION_DETAIL', 'operation detail must be normalized and at most 4,000 characters')
  }
  const referenceKeys = new Set<string>()
  for (const reference of transition.externalReferences) {
    if (!normalized(reference.provider) || !normalized(reference.id)
      || (reference.fencingToken !== undefined && (!Number.isSafeInteger(reference.fencingToken) || reference.fencingToken < 1))) {
      fail('GRAPH_OPERATION_REFERENCE', 'external references need normalized identity and a positive fencing token')
    }
    const key = JSON.stringify([reference.kind, reference.provider, reference.id])
    if (referenceKeys.has(key)) fail('GRAPH_OPERATION_REFERENCE', `duplicate external reference ${key}`)
    referenceKeys.add(key)
  }
  return transition
}

/** Validate one settlement record before replay accepts it. */
function validateSettlementRecord(value: unknown, state: GraphProjection): GraphSettlementRecord {
  const settlement = parseStructure(settlementRecordSchema, value, 'GRAPH_SETTLEMENT_STRUCTURE', 'graph settlement fields have invalid types or unknown fields') as unknown as GraphSettlementRecord
  const run = state.runs[settlement.runId]
    ?? fail('GRAPH_SETTLEMENT_RUN', `settlement ${JSON.stringify(settlement.id)} names unknown run ${JSON.stringify(settlement.runId)}`)
  if (![settlement.id, settlement.operationId, settlement.workId, settlement.generationId]
    .every(value => normalized(value) && SAFE_ID.test(value))
    || settlement.generationId !== run.generationId || settlement.ownerEpoch !== run.ownerEpoch
    || !Object.values(run.nodes).some(node => node.workId === settlement.workId)
    || !Number.isSafeInteger(settlement.attempt) || settlement.attempt < 1
    || !Number.isSafeInteger(settlement.requestedAt) || settlement.requestedAt < run.createdAt
    || (settlement.completedAt !== undefined && (
      !Number.isSafeInteger(settlement.completedAt) || settlement.completedAt < settlement.requestedAt
    ))) {
    fail('GRAPH_SETTLEMENT_IDENTITY', `settlement ${JSON.stringify(settlement.id)} does not match its durable run identity`)
  }
  if ((settlement.outcome === 'pending') !== (settlement.completedAt === undefined)) {
    fail('GRAPH_SETTLEMENT_TIME', 'pending settlements omit completedAt and terminal settlements require it')
  }
  if (settlement.evidence !== undefined && (!normalized(settlement.evidence) || settlement.evidence.length > 4_000)) {
    fail('GRAPH_SETTLEMENT_EVIDENCE', 'settlement evidence must be normalized and at most 4,000 characters')
  }
  if (settlement.error !== undefined && (!normalized(settlement.error.code) || !normalized(settlement.error.message))) {
    fail('GRAPH_SETTLEMENT_ERROR', 'settlement errors require normalized code and message')
  }
  return settlement
}

/** Validate one graph-revision submission record before replay accepts it. */
function validateRevisionSubmissionRecord(value: unknown, state: GraphProjection): GraphRevisionSubmissionRecord {
  const submission = parseStructure(
    revisionSubmissionRecordSchema,
    value,
    'GRAPH_SUBMISSION_STRUCTURE',
    'graph submission fields have invalid types or unknown fields',
  ) as unknown as GraphRevisionSubmissionRecord
  if (!normalized(submission.id) || !SAFE_ID.test(submission.id)
    || !Number.isSafeInteger(submission.requestedAt)
    || (submission.completedAt !== undefined && (
      !Number.isSafeInteger(submission.completedAt) || submission.completedAt < submission.requestedAt
    ))) {
    fail('GRAPH_SUBMISSION_IDENTITY', 'graph submission identity and timestamps are invalid')
  }
  if (state.submissions[submission.id] === undefined) {
    validateGraphRevision(submission.graph, state.config)
    validateGraphRun(submission.run, submission.graph)
    if (submission.run.graphId !== submission.graph.graphId || submission.run.revision !== submission.graph.revision
      || submission.run.phase !== 'queued' || submission.run.terminal !== undefined) {
      fail('GRAPH_SUBMISSION_RUN', `submission ${JSON.stringify(submission.id)} does not carry its queued initial run`)
    }
    const nodes = new Set(submission.graph.nodes.map(node => node.id))
    if (submission.changedNodeIds.length === 0 || new Set(submission.changedNodeIds).size !== submission.changedNodeIds.length
      || submission.changedNodeIds.some(nodeId => !nodes.has(nodeId))) {
      fail('GRAPH_SUBMISSION_CHANGES', `submission ${JSON.stringify(submission.id)} has invalid changed node ids`)
    }
    if (submission.campaign !== undefined) {
      validateCampaignShape(submission.campaign)
      const execution = submission.campaign.batches.flatMap(batch => batch.executions)
        .find(item => item.runId === submission.run.id)
      if (execution === undefined || execution.graphId !== submission.graph.graphId
        || execution.revision !== submission.graph.revision || execution.status !== 'running') {
        fail('GRAPH_SUBMISSION_CAMPAIGN', `submission ${JSON.stringify(submission.id)} campaign does not bind its queued run`)
      }
    }
    if (submission.lineage !== undefined) {
      const { lineage } = submission
      const text = [lineage.title, lineage.objective, lineage.reason, lineage.trigger.summary,
        ...lineage.successCriteria, ...lineage.trigger.evidence, ...lineage.relationships.map(item => item.reason)]
      const nodeLists = Object.values(lineage.changes)
      if (!normalized(lineage.taskId) || !SAFE_ID.test(lineage.taskId)
        || lineage.createdAt !== submission.requestedAt
        || text.some(item => !normalized(item) || item.length > 4_000)
        || lineage.successCriteria.length === 0
        || nodeLists.some(items => new Set(items).size !== items.length)) {
        fail('GRAPH_SUBMISSION_LINEAGE', 'revision lineage has invalid identity, time, text, criteria, or duplicate node ids')
      }
      const graphNodeIds = new Set(submission.graph.nodes.map(node => node.id))
      const previous = submission.graph.parentRevision === undefined
        ? undefined
        : state.graphs[submission.graph.graphId]?.find(item => item.revision === submission.graph.parentRevision)
      const previousNodeIds = new Set(previous?.nodes.map(node => node.id) ?? [])
      if (lineage.changes.addedNodeIds.some(id => !graphNodeIds.has(id) || previousNodeIds.has(id))
        || lineage.changes.changedNodeIds.some(id => !graphNodeIds.has(id) || !previousNodeIds.has(id))
        || lineage.changes.removedNodeIds.some(id => graphNodeIds.has(id) || !previousNodeIds.has(id))
        || lineage.changes.preservedNodeIds.some(id => !graphNodeIds.has(id) || !previousNodeIds.has(id))
        || lineage.changes.invalidatedNodeIds.some(id => !graphNodeIds.has(id))
        || new Set(lineage.changes.invalidatedNodeIds).size !== lineage.changes.invalidatedNodeIds.length) {
        fail('GRAPH_SUBMISSION_LINEAGE', 'revision lineage node changes do not match the immutable revisions')
      }
      if ((submission.intent === 'new') !== (lineage.kind === 'new_task')
        || (submission.intent === 'new' && lineage.relationships.some(item => item.kind !== 'depends_on'))
        || (submission.intent === 'revise' && !lineage.relationships.some(item => (
          item.graphId === submission.graph.graphId && item.revision === submission.graph.parentRevision
        )))) {
        fail('GRAPH_SUBMISSION_LINEAGE', 'revision lineage classification or parent relationship does not match the submission')
      }
      for (const relationship of lineage.relationships) {
        if (!normalized(relationship.graphId) || !SAFE_ID.test(relationship.graphId)
          || (relationship.revision !== undefined && (!Number.isSafeInteger(relationship.revision) || relationship.revision < 1))) {
          fail('GRAPH_SUBMISSION_LINEAGE', 'revision lineage relationship has an invalid target')
        }
      }
    }
  }
  if ((submission.outcome === 'pending') !== (submission.completedAt === undefined)
    || (submission.outcome === 'failed') !== (submission.error !== undefined)) {
    fail('GRAPH_SUBMISSION_RESULT', 'pending submissions omit terminal fields and failed submissions require an error')
  }
  return submission
}

/**
 * Validate a checkpoint and any proposed immutable replacement revision.
 * @param value untrusted whole checkpoint state.
 * @param state graph projection containing its revision and run.
 * @returns validated checkpoint.
 */
export function validateGraphCheckpoint(value: unknown, state: GraphProjection): GraphCheckpoint {
  const checkpoint = parseStructure(checkpointSchema, value, 'GRAPH_CHECKPOINT_STRUCTURE', 'graph checkpoint fields have invalid types or unknown fields') as unknown as GraphCheckpoint
  const graph = state.graphs[checkpoint.graphId]?.find(item => item.revision === checkpoint.revision)
    ?? fail('GRAPH_CHECKPOINT_GRAPH', `checkpoint ${JSON.stringify(checkpoint.id)} names an unknown graph revision`)
  const run = state.runs[checkpoint.runId]
    ?? fail('GRAPH_CHECKPOINT_RUN', `checkpoint ${JSON.stringify(checkpoint.id)} names an unknown run`)
  const node = graph.nodes.find(item => item.id === checkpoint.nodeId)
    ?? fail('GRAPH_CHECKPOINT_NODE', `checkpoint ${JSON.stringify(checkpoint.id)} names an unknown node`)
  if (![checkpoint.id, checkpoint.graphId, checkpoint.runId, checkpoint.nodeId].every(value => normalized(value) && SAFE_ID.test(value))
    || checkpoint.graphId !== run.graphId || checkpoint.revision !== run.revision
    || !Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < run.createdAt
    || !Number.isSafeInteger(checkpoint.iteration) || checkpoint.iteration < 1
    || !normalized(checkpoint.reason) || checkpoint.reason.length > 4_000) {
    fail('GRAPH_CHECKPOINT_IDENTITY', `checkpoint ${JSON.stringify(checkpoint.id)} has invalid identity, time, iteration, or reason`)
  }
  const terminal = checkpoint.status !== 'pending'
  if (terminal !== (checkpoint.resolvedAt !== undefined)
    || (checkpoint.resolvedAt !== undefined && (
      !Number.isSafeInteger(checkpoint.resolvedAt) || checkpoint.resolvedAt < checkpoint.createdAt
    ))
    || (checkpoint.replacementRevision !== undefined && (checkpoint.status !== 'resolved'
      || checkpoint.replacementRevision !== checkpoint.revision + 1))) {
    fail('GRAPH_CHECKPOINT_RESOLUTION', 'checkpoint resolution fields do not match its status')
  }
  if ((checkpoint.kind === 'environment' && checkpoint.status === 'resolved')
    !== (checkpoint.authorizedGeneration !== undefined)
    || (checkpoint.authorizedGeneration !== undefined
      && (!Number.isSafeInteger(checkpoint.authorizedGeneration)
        || checkpoint.authorizedGeneration !== run.generation + 1))) {
    fail('GRAPH_CHECKPOINT_AUTHORIZATION', 'exactly resolved environment checkpoints authorize one positive execution generation')
  }
  if ((checkpoint.kind === 'expansion') !== (checkpoint.proposal !== undefined)) {
    fail('GRAPH_CHECKPOINT_PROPOSAL', 'exactly expansion checkpoints carry a proposal')
  }
  if ((checkpoint.kind === 'repair' || checkpoint.kind === 'awaiting_user') && (checkpoint.issues?.length ?? 0) === 0) {
    fail('GRAPH_CHECKPOINT_ISSUES', 'repair and awaiting_user checkpoints require structured issues')
  }
  for (const issue of checkpoint.issues ?? []) {
    if (!normalized(issue.id) || !SAFE_ID.test(issue.id) || !normalized(issue.summary)
      || issue.evidence.some(item => !normalized(item)) || issue.ownerNodeIds.length === 0
      || issue.ownerNodeIds.some(id => !graph.nodes.some(item => item.id === id))) {
      fail('GRAPH_CHECKPOINT_ISSUES', `checkpoint issue ${JSON.stringify(issue.id)} is invalid`)
    }
  }
  if (checkpoint.proposal !== undefined) {
    const proposal = checkpoint.proposal
    const expansion = node.expansion ?? fail('GRAPH_CHECKPOINT_PROPOSAL', 'expansion checkpoint node lacks an expansion specification')
    if (proposal.baseRevision !== graph.revision
      || proposal.nodes.length === 0 || proposal.nodes.length > expansion.maxNodes
      || proposal.changedNodeIds.length === 0
      || proposal.changedNodeIds.some(id => !proposal.nodes.some(candidate => candidate.id === id))) {
      fail('GRAPH_CHECKPOINT_PROPOSAL', 'expansion proposal does not match its node or configured size')
    }
    if (expansion.mode === 'controller' && proposal.mapKeys !== undefined) {
      fail('GRAPH_CHECKPOINT_PROPOSAL', 'controller expansion cannot carry map keys')
    }
    if (expansion.mode === 'map') {
      const keys = proposal.mapKeys ?? fail('GRAPH_CHECKPOINT_PROPOSAL', 'map expansion requires stable keys')
      if (keys.length !== proposal.nodes.length || new Set(keys.map(String)).size !== keys.length) {
        fail('GRAPH_CHECKPOINT_PROPOSAL', 'map expansion keys must be unique and match candidate nodes')
      }
      for (const [index, key] of keys.entries()) {
        const text = String(key)
        if (!normalized(text) || !SAFE_ID.test(text) || proposal.nodes[index]?.id !== `${node.id}.${text}`) {
          fail('GRAPH_CHECKPOINT_PROPOSAL', 'map candidate ids must be derived from normalized stable keys')
        }
      }
    }
    const candidate: GraphRevision = {
      ...graph,
      revision: graph.revision + 1,
      parentRevision: graph.revision,
      createdAt: checkpoint.createdAt,
      userInput: `Expand graph from checkpoint ${checkpoint.id}`,
      nodes: [...graph.nodes, ...proposal.nodes],
      edges: [...graph.edges, ...proposal.edges],
      branchGroups: [...graph.branchGroups, ...proposal.branchGroups],
    }
    validateGraphRevision(candidate, state.config)
  }
  return checkpoint
}

/** Validate one completed human or controller operation. */
function validateControlRecord(value: unknown, state: GraphProjection): GraphControlRecord {
  const control = parseStructure(controlRecordSchema, value, 'GRAPH_CONTROL_STRUCTURE', 'graph control fields have invalid types or unknown fields') as unknown as GraphControlRecord
  const run = state.runs[control.runId] ?? fail('GRAPH_CONTROL_RUN', `control ${JSON.stringify(control.id)} names an unknown run`)
  const graph = state.graphs[control.graphId]?.find(item => item.revision === run.revision)
    ?? fail('GRAPH_CONTROL_GRAPH', `control ${JSON.stringify(control.id)} names an unknown graph`)
  if (![control.id, control.graphId, control.runId].every(value => normalized(value) && SAFE_ID.test(value))
    || run.graphId !== control.graphId || !normalized(control.reason) || control.reason.length > 4_000
    || !normalized(control.actor.id) || control.actor.id.length > 256
    || !Number.isSafeInteger(control.requestedAt) || !Number.isSafeInteger(control.completedAt)
    || control.completedAt < control.requestedAt) fail('GRAPH_CONTROL_IDENTITY', 'graph control has invalid identity, reason, or time')
  if (!Number.isSafeInteger(control.expectedRevision) || control.expectedRevision !== run.revision
    || !Number.isSafeInteger(control.expectedGeneration) || control.expectedGeneration < 1 || control.expectedGeneration > run.generation) {
    fail('GRAPH_CONTROL_EXPECTATION', 'graph control has invalid revision or generation expectations')
  }
  if (control.expectedAttemptId !== undefined && (!normalized(control.expectedAttemptId) || !SAFE_ID.test(control.expectedAttemptId))) {
    fail('GRAPH_CONTROL_ATTEMPT', 'graph control has an invalid expected attempt id')
  }
  if (control.nodeId !== undefined && !graph.nodes.some(node => node.id === control.nodeId)) fail('GRAPH_CONTROL_NODE', 'graph control names an unknown node')
  const nodeAction = ['modify-task', 'cancel-node', 'skip-node', 'retry-node', 'resume-from-node', 'override-node', 'supply-output'].includes(control.action)
  if (nodeAction !== (control.nodeId !== undefined) || (control.expectedAttemptId !== undefined && control.nodeId === undefined)) {
    fail('GRAPH_CONTROL_TARGET', 'graph control node target does not match its action')
  }
  if ((control.action === 'override-node') !== (control.override !== undefined)) fail('GRAPH_CONTROL_OVERRIDE', 'exactly override-node controls carry an override')
  if (control.override?.executionBudget !== undefined) {
    const ceilings = {
      maxOutputTokens: graph.terminationPolicy.maxOutputTokens,
      maxReasoningOnlyTokens: graph.terminationPolicy.maxReasoningOnlyTokens,
      firstDurableActionMs: graph.terminationPolicy.firstDurableActionMs,
      maxNoDurableProgressMs: graph.terminationPolicy.maxNoDurableProgressMs,
      checkpointIntervalMs: graph.terminationPolicy.checkpointIntervalMs,
      maxWallTimeMs: graph.terminationPolicy.maxWallTimeMs,
      maxContinuations: graph.terminationPolicy.maxRuntimeContinuations,
    }
    for (const [name, limit] of Object.entries(control.override.executionBudget)) {
      const minimum = name === 'maxContinuations' ? 0 : 1
      if (!Number.isSafeInteger(limit) || limit < minimum || limit > ceilings[name as keyof typeof ceilings]) {
        fail('GRAPH_CONTROL_OVERRIDE', `override execution budget ${name} must remain within the graph termination policy`)
      }
    }
  }
  if ((control.action === 'supply-output') !== (control.suppliedOutput !== undefined)) fail('GRAPH_CONTROL_OUTPUT', 'exactly supply-output controls carry supplied output')
  if ((control.action === 'rollback') !== (control.targetRevision !== undefined)) fail('GRAPH_CONTROL_REVISION', 'exactly rollback controls carry a target revision')
  const checkpointAction = control.action === 'approve-checkpoint' || control.action === 'reject-checkpoint'
  if (checkpointAction !== (control.checkpointId !== undefined)) fail('GRAPH_CONTROL_CHECKPOINT', 'graph control checkpoint target does not match its action')
  if (control.suppliedOutput !== undefined) {
    const node = graph.nodes.find(candidate => candidate.id === control.nodeId)
      ?? fail('GRAPH_CONTROL_OUTPUT', 'graph control supplied output without a target node')
    validateGraphNodeOutput(control.suppliedOutput, node.outputSchema)
  }
  if (control.checkpointId !== undefined) {
    const checkpoint = state.checkpoints[control.checkpointId]
    if (checkpoint === undefined || checkpoint.runId !== control.runId
      || checkpoint.graphId !== control.graphId || checkpoint.revision !== control.expectedRevision) {
      fail('GRAPH_CONTROL_CHECKPOINT', 'graph control names a checkpoint outside the addressed run')
    }
  }
  if (control.targetRevision !== undefined
    && (!Number.isSafeInteger(control.targetRevision) || control.targetRevision < 1)) {
    fail('GRAPH_CONTROL_REVISION', 'graph control target revision must be positive')
  }
  if (control.resultingGeneration !== undefined && (!Number.isSafeInteger(control.resultingGeneration)
    || control.resultingGeneration <= control.expectedGeneration || control.resultingGeneration > run.generation)) {
    fail('GRAPH_CONTROL_GENERATION', 'graph control resulting generation must be newer than the addressed generation and already stored')
  }
  if (control.resultingRevision !== undefined && (!Number.isSafeInteger(control.resultingRevision)
    || control.resultingRevision <= control.expectedRevision
    || state.graphs[control.graphId]?.some(item => item.revision === control.resultingRevision) !== true)) {
    fail('GRAPH_CONTROL_RESULT_REVISION', 'graph control resulting revision must name a newer stored revision')
  }
  if (control.result.detail !== undefined
    && (!normalized(control.result.detail) || control.result.detail.length > 4_000)) {
    fail('GRAPH_CONTROL_RESULT', 'graph control result detail must be non-empty and bounded')
  }
  const impactIds = [...control.impact.invalidatedNodeIds, ...control.impact.reusedNodeIds]
  const knownNodeIds = new Set(state.graphs[control.graphId]?.flatMap(revision => revision.nodes.map(node => node.id)) ?? [])
  if (new Set(impactIds).size !== impactIds.length || impactIds.some(id => !knownNodeIds.has(id))) {
    fail('GRAPH_CONTROL_IMPACT', 'graph control impact must contain unique nodes from the addressed revision')
  }
  return control
}

/**
 * Return changed nodes plus every transitive successor that must rerun after
 * a graph adjustment. The result follows deterministic topological order.
 * @param graph adjusted graph revision whose edges define downstream impact.
 * @param changed node ids directly changed by the revision.
 * @returns unique affected node ids in topological order.
 */
export function downstreamInvalidation(graph: GraphRevision, changed: readonly GraphNodeId[]): GraphNodeId[] {
  const nodes = new Set(graph.nodes.map(node => node.id))
  for (const id of changed) if (!nodes.has(id)) fail('GRAPH_INVALIDATION_NODE', `cannot invalidate missing node ${JSON.stringify(id)}`)
  const affected = new Set<GraphNodeId>(changed)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const edge of graph.edges) {
      if (affected.has(edge.from) && !affected.has(edge.to)) {
        affected.add(edge.to)
        expanded = true
      }
    }
  }
  const indegree = new Map<GraphNodeId, number>()
  for (const id of affected) indegree.set(id, 0)
  for (const edge of graph.edges) {
    if (affected.has(edge.from)) indegree.set(edge.to, (indegree.get(edge.to) as number) + 1)
  }
  const queue = graph.nodes.map(node => node.id).filter(id => affected.has(id) && indegree.get(id) === 0)
  const ordered: GraphNodeId[] = []
  while (queue.length > 0) {
    const id = queue.shift() as GraphNodeId
    ordered.push(id)
    for (const edge of graph.edges) {
      if (edge.from !== id || !affected.has(edge.to)) continue
      const next = (indegree.get(edge.to) as number) - 1
      indegree.set(edge.to, next)
      if (next === 0) queue.push(edge.to)
    }
  }
  if (ordered.length !== affected.size) fail('GRAPH_CYCLE', 'cannot order invalidation closure of a cyclic graph')
  return ordered
}

/**
 * Apply one committed graph event to a projection.
 * @param state projection before the event.
 * @param event committed session event.
 * @returns projection after applying graph events, or the original state for other events.
 */
export function applyGraphEvent(state: GraphProjection, event: SessionEvent): GraphProjection {
  if (event.type === 'graph/change') {
    const change = event.data
    if (!isVersionTwo(change.version)) fail('GRAPH_CHANGE_VERSION', `unsupported graph change version ${String(change.version)}`)
    if (change.kind === 'graph/config') {
      validateGraphModeConfig(change.config)
      return { ...state, config: change.config }
    }
    validateGraphRevision(change.graph, state.config)
    const prior = state.graphs[change.graph.graphId] ?? []
    const previous = prior.at(-1)
    if (previous === undefined ? change.graph.revision !== 1 : change.graph.revision !== previous.revision + 1) {
      fail('GRAPH_REVISION_SEQUENCE', `graph ${JSON.stringify(change.graph.graphId)} revision is not contiguous`)
    }
    return {
      ...state,
      graphs: { ...state.graphs, [change.graph.graphId]: [...prior, change.graph] },
      ...change.current ? { currentGraphId: change.graph.graphId } : {},
    }
  }
  if (event.type === 'graph/run') {
    const run = event.data
    const revisions = state.graphs[run.graphId]
    const revision = revisions?.find(item => item.revision === run.revision)
    const knownRevision = revision ?? fail('GRAPH_RUN_REVISION', `run ${JSON.stringify(run.id)} names an unknown graph revision`)
    validateGraphRun(run, knownRevision)
    const prior = state.runs[run.id]
    if (prior !== undefined) {
      const sameGeneration = run.generation === prior.generation
        && run.generationId === prior.generationId
        && run.ownerEpoch === prior.ownerEpoch
      const nextGeneration = run.generation === prior.generation + 1
        && run.generationId !== prior.generationId
        && run.ownerEpoch > prior.ownerEpoch
      if (prior.graphId !== run.graphId || prior.revision !== run.revision
        || prior.createdAt !== run.createdAt || run.updatedAt < prior.updatedAt
        || (!sameGeneration && !nextGeneration)
        || (prior.terminal !== undefined && sameGeneration)) {
        fail('GRAPH_RUN_REPLACEMENT', `run ${JSON.stringify(run.id)} changed identity, used a stale owner, or moved backward in time`)
      }
    }
    return { ...state, runs: { ...state.runs, [run.id]: run } }
  }
  if (event.type === 'graph/operation') {
    const transition = validateOperationTransition(event.data, state)
    const prior = state.operations[transition.workId] ?? []
    if (prior.some(item => item.eventId === transition.eventId)) {
      fail('GRAPH_OPERATION_DUPLICATE', `operation event ${JSON.stringify(transition.eventId)} was appended twice`)
    }
    const previous = prior.at(-1)
    if (previous === undefined) {
      if (transition.stage !== 'planned' || transition.expectedPrevious !== undefined) {
        fail('GRAPH_OPERATION_SEQUENCE', 'the first logical-work transition must be planned without expectedPrevious')
      }
    } else {
      const recoveryTakeover = transition.stage === 'reconciled'
        && transition.ownerEpoch === previous.ownerEpoch + 1
        && transition.generationId !== previous.generationId
      if (previous.stage === 'terminal' && !recoveryTakeover) fail('GRAPH_OPERATION_TERMINAL', `logical work ${JSON.stringify(transition.workId)} already has an accepted terminal result`)
      if (transition.expectedPrevious !== previous.stage || transition.runId !== previous.runId
        || (!recoveryTakeover && (transition.operationId !== previous.operationId
          || transition.generationId !== previous.generationId || transition.ownerEpoch !== previous.ownerEpoch))
        || transition.at < previous.at) {
        fail('GRAPH_OPERATION_SEQUENCE', `operation ${JSON.stringify(transition.eventId)} does not follow the accepted journal head`)
      }
    }
    return { ...state, operations: { ...state.operations, [transition.workId]: [...prior, transition] } }
  }
  if (event.type === 'graph/settlement') {
    const settlement = validateSettlementRecord(event.data, state)
    const prior = state.settlements[settlement.id] ?? []
    const previous = prior.at(-1)
    if (previous === undefined) {
      if (settlement.outcome !== 'pending' || settlement.attempt !== 1) {
        fail('GRAPH_SETTLEMENT_SEQUENCE', `settlement ${JSON.stringify(settlement.id)} must start with pending attempt 1`)
      }
    } else {
      const sameIdentity = settlement.operationId === previous.operationId
        && settlement.workId === previous.workId && settlement.runId === previous.runId
        && settlement.generationId === previous.generationId && settlement.ownerEpoch === previous.ownerEpoch
        && settlement.kind === previous.kind
        && JSON.stringify(settlement.externalReference ?? null) === JSON.stringify(previous.externalReference ?? null)
      const completesAttempt = previous.outcome === 'pending'
        && settlement.outcome !== 'pending'
        && settlement.attempt === previous.attempt
        && settlement.requestedAt === previous.requestedAt
      const retriesFailure = (previous.outcome === 'failed' || previous.outcome === 'conflict')
        && settlement.outcome === 'pending'
        && settlement.attempt === previous.attempt + 1
      if (!sameIdentity || (!completesAttempt && !retriesFailure)) {
        fail('GRAPH_SETTLEMENT_SEQUENCE', `settlement ${JSON.stringify(settlement.id)} does not complete or retry the accepted attempt`)
      }
      if (previous.outcome === 'confirmed') {
        fail('GRAPH_SETTLEMENT_TERMINAL', `settlement ${JSON.stringify(settlement.id)} is already confirmed`)
      }
    }
    return { ...state, settlements: { ...state.settlements, [settlement.id]: [...prior, settlement] } }
  }
  if (event.type === 'graph/submission') {
    const submission = validateRevisionSubmissionRecord(event.data, state)
    const prior = state.submissions[submission.id]
    if (prior === undefined) {
      if (submission.outcome !== 'pending') fail('GRAPH_SUBMISSION_SEQUENCE', 'a new graph submission must start pending')
      if (Object.values(state.submissions).some(candidate => candidate.outcome === 'pending'
        && candidate.graph.graphId === submission.graph.graphId
        && candidate.graph.revision === submission.graph.revision)) {
        fail('GRAPH_SUBMISSION_SEQUENCE', 'a graph revision already has a pending submission')
      }
      const revisions = state.graphs[submission.graph.graphId]
      if (submission.intent === 'new') {
        if (submission.graph.revision !== 1 || revisions !== undefined) {
          fail('GRAPH_SUBMISSION_SEQUENCE', 'new work requires revision one of a new graph id')
        }
      } else if (state.currentGraphId !== submission.graph.graphId
        || submission.graph.revision !== (revisions?.at(-1)?.revision ?? 0) + 1) {
        fail('GRAPH_SUBMISSION_SEQUENCE', 'revised work must immediately follow the current graph revision')
      }
    } else {
      if (prior.outcome !== 'pending' || submission.outcome === 'pending'
        || submission.intent !== prior.intent || submission.requestedAt !== prior.requestedAt
        || JSON.stringify(submission.graph) !== JSON.stringify(prior.graph)
        || JSON.stringify(submission.run) !== JSON.stringify(prior.run)
        || JSON.stringify(submission.changedNodeIds) !== JSON.stringify(prior.changedNodeIds)
        || JSON.stringify(submission.campaign) !== JSON.stringify(prior.campaign)
        || JSON.stringify(submission.lineage) !== JSON.stringify(prior.lineage)) {
        fail('GRAPH_SUBMISSION_SEQUENCE', `submission ${JSON.stringify(submission.id)} changed identity or was settled twice`)
      }
    }
    return { ...state, submissions: { ...state.submissions, [submission.id]: submission } }
  }
  if (event.type === 'graph/checkpoint') {
    const checkpoint = validateGraphCheckpoint(event.data, state)
    const prior = state.checkpoints[checkpoint.id]
    if (prior === undefined) {
      if (checkpoint.status !== 'pending') fail('GRAPH_CHECKPOINT_SEQUENCE', 'a new checkpoint must start pending')
    } else if (prior.status !== 'pending' || checkpoint.status === 'pending'
      || checkpoint.graphId !== prior.graphId || checkpoint.revision !== prior.revision
      || checkpoint.runId !== prior.runId || checkpoint.nodeId !== prior.nodeId
      || checkpoint.kind !== prior.kind || checkpoint.createdAt !== prior.createdAt
      || checkpoint.iteration !== prior.iteration || checkpoint.reason !== prior.reason
      || JSON.stringify(checkpoint.proposal) !== JSON.stringify(prior.proposal)
      || JSON.stringify(checkpoint.issues) !== JSON.stringify(prior.issues)) {
      fail('GRAPH_CHECKPOINT_SEQUENCE', `checkpoint ${JSON.stringify(checkpoint.id)} changed identity or was resolved twice`)
    }
    return { ...state, checkpoints: { ...state.checkpoints, [checkpoint.id]: checkpoint } }
  }
  if (event.type === 'graph/campaign') {
    const campaign = event.data
    validateGraphCampaign(campaign, state)
    const prior = state.campaigns[campaign.id]
    if (prior !== undefined) {
      if (campaign.createdAt !== prior.createdAt || campaign.objective !== prior.objective
        || campaign.updatedAt < prior.updatedAt || campaign.batches.length < prior.batches.length) {
        fail('GRAPH_CAMPAIGN_REPLACEMENT', `campaign ${JSON.stringify(campaign.id)} changed identity or moved backward`)
      }
      const priorPlanRevision = prior.planRevision ?? 1
      const planRevision = campaign.planRevision ?? 1
      const priorExtensions = prior.planExtensions ?? []
      const planExtensions = campaign.planExtensions ?? []
      const appended = campaign.batches.length > prior.batches.length
      if ((!appended && (planRevision !== priorPlanRevision || !isDeepStrictEqual(planExtensions, priorExtensions)))
        || (appended && (planRevision !== priorPlanRevision + 1
          || planExtensions.length !== priorExtensions.length + 1
          || !isDeepStrictEqual(planExtensions.slice(0, priorExtensions.length), priorExtensions)
          || !isDeepStrictEqual(
            planExtensions.at(-1)?.addedBatchIds,
            campaign.batches.slice(prior.batches.length).map(batch => batch.id),
          )))) {
        fail('GRAPH_CAMPAIGN_REPLACEMENT', `campaign ${JSON.stringify(campaign.id)} has an invalid plan extension`)
      }
      for (const [index, previous] of prior.batches.entries()) {
        const batch = campaign.batches[index]
        if (batch === undefined) throw new GraphValidationError('GRAPH_CAMPAIGN_REPLACEMENT', `campaign ${JSON.stringify(campaign.id)} removed an accepted batch`)
        const retainedExecutions = batch.executions.length === previous.executions.length
          ? Math.max(0, batch.executions.length - 1)
          : previous.executions.length
        if (batch.id !== previous.id || batch.ordinal !== previous.ordinal
          || batch.title !== previous.title || batch.objective !== previous.objective
          || JSON.stringify(batch.dependsOn) !== JSON.stringify(previous.dependsOn)
          || batch.executions.length < previous.executions.length
          || !isDeepStrictEqual(batch.executions.slice(0, retainedExecutions), previous.executions.slice(0, retainedExecutions))) {
          fail('GRAPH_CAMPAIGN_REPLACEMENT', `campaign ${JSON.stringify(campaign.id)} changed an accepted batch definition or execution`)
        }
        if (batch.executions.length === previous.executions.length && batch.executions.length > 0) {
          const execution = batch.executions.at(-1)
          const priorExecution = previous.executions.at(-1)
          if (execution === undefined || priorExecution === undefined
            || execution.graphId !== priorExecution.graphId || execution.revision !== priorExecution.revision
            || execution.runId !== priorExecution.runId || execution.startedAt !== priorExecution.startedAt
            || execution.completedAt !== undefined && execution.completedAt < priorExecution.startedAt
            || priorExecution.completedAt !== undefined
              && (execution.completedAt === undefined || execution.completedAt < priorExecution.completedAt)
            || execution.settlementIds.length < priorExecution.settlementIds.length
            || !isDeepStrictEqual(
              execution.settlementIds.slice(0, priorExecution.settlementIds.length),
              priorExecution.settlementIds,
            )) {
            fail('GRAPH_CAMPAIGN_REPLACEMENT', `campaign ${JSON.stringify(campaign.id)} changed an active batch execution identity`)
          }
        }
      }
    }
    return {
      ...state,
      campaigns: { ...state.campaigns, [campaign.id]: campaign },
      currentCampaignId: campaign.id,
    }
  }
  if (event.type === 'graph/control') {
    const control = validateControlRecord(event.data, state)
    if (state.controls[control.id] !== undefined) fail('GRAPH_CONTROL_DUPLICATE', `control ${JSON.stringify(control.id)} was appended twice`)
    return { ...state, controls: { ...state.controls, [control.id]: control } }
  }
  return state
}

/**
 * Fold all durable graph events into their browser-facing projection.
 * @param events ordered session event stream.
 * @returns replayed graph projection.
 */
export function foldGraph(events: readonly SessionEvent[]): GraphProjection {
  return events.reduce(applyGraphEvent, emptyGraphProjection())
}

/** Wire schema for the graph projection registry. */
export const graphProjectionSchema: ZodType<GraphProjection> = zod.custom<GraphProjection>((value) => {
  if (typeof value !== 'object' || value === null) return false
  try {
    validateGraphModeConfig((value as GraphProjection).config)
    return true
  } catch {
    return false
  }
})

/** Pure projection unit installed when the session-projection service is present. */
export const graphProjectionDefinition = {
  key: 'graph',
  stateSchema: graphProjectionSchema,
  init: emptyGraphProjection,
  apply: applyGraphEvent,
  wire: {
    viewSchema: graphProjectionSchema,
    view: (state: GraphProjection): GraphProjection => state,
  },
  stateVersion: 8,
} as const

/**
 * Register the graph projection without making the projection service mandatory.
 * @param ctx Cordis context that may carry the projection registry.
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  ctx.inject(['sessionProjections'], inner => inner.sessionProjections.register(graphProjectionDefinition))
}
