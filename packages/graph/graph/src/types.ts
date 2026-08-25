/** Browser-safe durable vocabulary for graph-mode orchestration. @module @deepseek-ai/dsh-graph/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Stable identity of one logical graph across immutable revisions. */
export type GraphId = Branded<'GraphId'>
/** Stable identity of one task node across graph revisions. */
export type GraphNodeId = Branded<'GraphNodeId'>
/** Identity of one execution of one graph revision. */
export type GraphRunId = Branded<'GraphRunId'>
/** Stable deployment-owned role identifier. */
export type GraphRoleId = Branded<'GraphRoleId'>
/** Identity of one node execution attempt. */
export type GraphAttemptId = Branded<'GraphAttemptId'>
/** Stable identity of one logical node execution across physical attempts. */
export type GraphWorkId = Branded<'GraphWorkId'>
/** Stable identity of one coordination activation within an execution generation. */
export type GraphActivationId = Branded<'GraphActivationId'>
/** Identity of one recoverable execution generation of a graph revision. */
export type GraphRunGenerationId = Branded<'GraphRunGenerationId'>
/** Stable identity of one controller, user, or recovery operation. */
export type GraphControlOperationId = Branded<'GraphControlOperationId'>
/** Stable identity of one external terminal write. */
export type GraphSettlementId = Branded<'GraphSettlementId'>
/** Identity of one append-only graph operation transition. */
export type GraphOperationEventId = Branded<'GraphOperationEventId'>
/** Stable identity of one recoverable graph-revision submission. */
export type GraphSubmissionId = Branded<'GraphSubmissionId'>
/** Identity of one branch group in an immutable revision. */
export type GraphBranchGroupId = Branded<'GraphBranchGroupId'>
/** Identity of one durable planning, repair, or human checkpoint. */
export type GraphCheckpointId = Branded<'GraphCheckpointId'>
/** Stable identity of one multi-graph campaign. */
export type GraphCampaignId = Branded<'GraphCampaignId'>
/** Stable identity of one batch inside a campaign. */
export type GraphCampaignBatchId = Branded<'GraphCampaignBatchId'>
/** Stable identity of one user-visible logical task across its revisions. */
export type GraphTaskId = Branded<'GraphTaskId'>

/**
 * Construct a graph id after validation at the owning parser.
 * @param value validated graph id text.
 * @returns branded graph id.
 */
export const GraphId = (value: string): GraphId => value as GraphId
/**
 * Construct a graph node id after validation at the owning parser.
 * @param value validated node id text.
 * @returns branded graph node id.
 */
export const GraphNodeId = (value: string): GraphNodeId => value as GraphNodeId
/**
 * Construct a graph run id after validation at the owning parser.
 * @param value validated run id text.
 * @returns branded graph run id.
 */
export const GraphRunId = (value: string): GraphRunId => value as GraphRunId
/**
 * Construct a graph role id after validation at the owning parser.
 * @param value validated role id text.
 * @returns branded graph role id.
 */
export const GraphRoleId = (value: string): GraphRoleId => value as GraphRoleId
/**
 * Construct a graph attempt id after validation at the owning parser.
 * @param value validated attempt id text.
 * @returns branded graph attempt id.
 */
export const GraphAttemptId = (value: string): GraphAttemptId => value as GraphAttemptId
/**
 * Construct a stable graph work id after validation at the owning parser.
 * @param value validated graph work id text.
 * @returns branded graph work id.
 */
export const GraphWorkId = (value: string): GraphWorkId => value as GraphWorkId
/**
 * Construct a graph activation id after validation at the owning parser.
 * @param value validated graph activation id text.
 * @returns branded graph activation id.
 */
export const GraphActivationId = (value: string): GraphActivationId => value as GraphActivationId
/**
 * Construct a run-generation id after validation at the owning parser.
 * @param value validated run-generation id text.
 * @returns branded run-generation id.
 */
export const GraphRunGenerationId = (value: string): GraphRunGenerationId => value as GraphRunGenerationId
/**
 * Construct a control-operation id after validation at the owning parser.
 * @param value validated control-operation id text.
 * @returns branded control-operation id.
 */
export const GraphControlOperationId = (value: string): GraphControlOperationId => value as GraphControlOperationId
/**
 * Construct a settlement id after validation at the owning parser.
 * @param value validated settlement id text.
 * @returns branded settlement id.
 */
export const GraphSettlementId = (value: string): GraphSettlementId => value as GraphSettlementId
/**
 * Construct an operation-event id after validation at the owning parser.
 * @param value validated operation-event id text.
 * @returns branded operation-event id.
 */
export const GraphOperationEventId = (value: string): GraphOperationEventId => value as GraphOperationEventId
/**
 * Construct a graph-submission id after validation at the owning parser.
 * @param value validated graph-submission id text.
 * @returns branded graph-submission id.
 */
export const GraphSubmissionId = (value: string): GraphSubmissionId => value as GraphSubmissionId
/**
 * Construct a branch-group id after validation at the owning parser.
 * @param value validated branch-group id text.
 * @returns branded branch-group id.
 */
export const GraphBranchGroupId = (value: string): GraphBranchGroupId => value as GraphBranchGroupId
/**
 * Construct a checkpoint id after validation at the owning parser.
 * @param value validated checkpoint id text.
 * @returns branded checkpoint id.
 */
export const GraphCheckpointId = (value: string): GraphCheckpointId => value as GraphCheckpointId
/**
 * Construct a campaign id after validation at the owning parser.
 * @param value validated campaign id text.
 * @returns branded campaign id.
 */
export const GraphCampaignId = (value: string): GraphCampaignId => value as GraphCampaignId
/**
 * Construct a campaign batch id after validation at the owning parser.
 * @param value validated campaign-batch id text.
 * @returns branded campaign-batch id.
 */
export const GraphCampaignBatchId = (value: string): GraphCampaignBatchId => value as GraphCampaignBatchId
/**
 * Construct a logical-task id after validation at the owning parser.
 * @param value validated logical-task id text.
 * @returns branded logical-task id.
 */
export const GraphTaskId = (value: string): GraphTaskId => value as GraphTaskId

/** Largest millisecond delay Node timers preserve without overflow clamping. */
export const MAX_GRAPH_TIMER_MS = 2_147_483_647

/** Model selection applied to child agents assigned to a role. */
export interface GraphModelSelection {
  /** Provider route; omission inherits the parent agent's provider. */
  readonly provider?: string
  /** Model id; omission inherits the parent agent's model. */
  readonly model?: string
  /** Provider-supported reasoning selector; omission inherits its default. */
  readonly reasoningEffort?: string
}

/** Editable role definition used by the controller and scheduler. */
export interface GraphRole {
  readonly id: GraphRoleId
  readonly label: string
  readonly description: string
  readonly controller: boolean
  readonly enabled: boolean
  readonly model: GraphModelSelection
  readonly prompt: string
  /** Registered Graph Worker Provider selected for this role. */
  readonly workerProvider?: string
  /** Maximum admitted attempts for this role. */
  readonly maxParallel: number
}

/** Hard admission limit shared by roles selecting the same provider and model. */
export interface GraphModelLimit {
  readonly provider?: string
  readonly model: string
  readonly maxParallel: number
  /** Optional weighted in-flight budget for deployments with known memory costs. */
  readonly maxWeight?: number
}

/** Scheduler limits independent from a particular graph revision. */
export interface GraphSchedulerLimits {
  readonly globalMaxParallel: number
  /** Permits held aside so a saturated worker pool cannot starve the controller. */
  readonly controllerReserve: number
  readonly models: readonly GraphModelLimit[]
}

/** Whole graph-mode configuration stored in the owning session. */
export interface GraphModeConfig {
  readonly version: 2
  readonly active: boolean
  readonly roles: readonly GraphRole[]
  readonly limits: GraphSchedulerLimits
  /** Hard ceilings copied into each accepted graph revision. */
  readonly executionPolicy: GraphExecutionPolicy
}

/** Deployment ceilings for one graph and its automatic feedback work. */
export interface GraphExecutionPolicy {
  readonly maxNodesPerRevision: number
  readonly maxAttemptsPerNode: number
  readonly maxGraphRevisions: number
  readonly maxRepairRevisions: number
  readonly maxDynamicExpansions: number
  readonly maxSubgraphDepth: number
  readonly maxRuntimeContinuations: number
  /** Per-request model output ceiling for Graph Workers. */
  readonly maxOutputTokens: number
  /** Estimated reasoning-only token ceiling before the Worker is interrupted. */
  readonly maxReasoningOnlyTokens: number
  /** Maximum time from Worker publication to its first durable action. */
  readonly firstDurableActionMs: number
  /** Maximum interval between durable actions while a Worker remains active. */
  readonly maxNoDurableProgressMs: number
  /** Maximum interval between durable execution checkpoints. */
  readonly checkpointIntervalMs: number
  readonly maxWallTimeMs: number
  readonly maxOutputBytes: number
  readonly noProgressLimit: number
}

/** Resolved per-node limits for one physical Worker activation. */
export interface GraphNodeExecutionBudget {
  readonly maxOutputTokens: number
  readonly maxReasoningOnlyTokens: number
  readonly firstDurableActionMs: number
  readonly maxNoDurableProgressMs: number
  readonly checkpointIntervalMs: number
  readonly maxWallTimeMs: number
  readonly maxContinuations: number
}

/** Task kinds communicate scheduling semantics without parsing prose. */
export type GraphTaskKind = 'analysis' | 'design' | 'environment' | 'implementation' | 'review' | 'verification' | 'documentation' | 'integration' | 'specialist' | 'expansion' | 'subgraph'

/** Host capabilities named by an immutable environment-change plan. */
export type GraphEnvironmentCapability = 'network' | 'host-package-install' | 'docker'

/** One exact host command presented for approval before execution. */
export interface GraphEnvironmentOperation {
  readonly id: string
  readonly description: string
  readonly command: string
  /** Documentary recovery command; execution requires a separate approved environment node. */
  readonly rollbackCommand?: string
}

/** Approved host effects executed directly by Graph Mode rather than a model Worker. */
export interface GraphEnvironmentPlan {
  readonly requiredCapabilities: readonly GraphEnvironmentCapability[]
  readonly sandboxMode: 'workspace-write' | 'danger-full-access'
  readonly operations: readonly GraphEnvironmentOperation[]
}

/** Versioned enforced output schema stored with one immutable node. */
export interface GraphOutputSchema {
  readonly id: string
  readonly version: number
  readonly maxBytes: number
  readonly schema: ObjectJsonSchema
}

/** Bounded dynamic expansion requested by one worker and committed by the controller. */
export interface GraphExpansionSpec {
  readonly mode: 'controller' | 'map'
  readonly maxNodes: number
  /** Data path containing map items; required only in map mode. */
  readonly itemPath?: readonly string[]
  /** Item-relative path whose scalar value forms the stable child key. */
  readonly itemKeyPath?: readonly string[]
}

/** Immutable reference and mappings for one nested child graph. */
export interface GraphSubgraphSpec {
  readonly graphId: GraphId
  readonly revision: number
  readonly input: Readonly<Record<string, readonly string[]>>
  readonly output: Readonly<Record<string, readonly string[]>>
}

/** Workspace isolation and path ownership declared by one immutable node. */
export interface GraphNodeWorkspacePolicy {
  readonly mode: 'read-only-snapshot' | 'isolated-copy' | 'git-worktree' | 'sandbox-mount' | 'shared'
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly cleanup: 'delete-on-settlement' | 'retain-on-failure' | 'retain'
}

/** One immutable unit of work assigned to a role. */
export interface GraphNode {
  readonly id: GraphNodeId
  readonly title: string
  readonly objective: string
  readonly kind: GraphTaskKind
  readonly roleId: GraphRoleId
  readonly acceptanceCriteria: readonly string[]
  /** Enforced before output can activate a branch, settle, or be reused. */
  readonly outputSchema: GraphOutputSchema
  /** Scheduler retry ceiling; rework after an accepted change uses a new graph revision. */
  readonly maxAttempts: number
  /** Relative resource cost used by an optional model weight budget. */
  readonly weight: number
  /** Limits resolved into this immutable task before dispatch. */
  readonly executionBudget: GraphNodeExecutionBudget
  /** Present exactly for an expansion node. */
  readonly expansion?: GraphExpansionSpec
  /** Present exactly for a nested-subgraph node. */
  readonly subgraph?: GraphSubgraphSpec
  /** Present exactly for a host environment-change node. */
  readonly environment?: GraphEnvironmentPlan
  /** Optional node-specific workspace guarantees; the deployment default applies when omitted. */
  readonly workspace?: GraphNodeWorkspacePolicy
  /** Whether a user may record an explicit skipped result for this node. */
  readonly skippable: boolean
  /** Recovery policy for uncertain effects after worker or Host loss. */
  readonly effectPolicy: 'idempotent' | 'reconcile' | 'manual'
}

/** Recoverable engineering evidence captured after one durable Worker action. */
export interface GraphExecutionCheckpoint {
  readonly workId: GraphWorkId
  readonly attemptId: GraphAttemptId
  readonly activation: number
  readonly sequence: number
  readonly createdAt: number
  readonly completedCriteria: readonly string[]
  readonly changedFiles: readonly { readonly path: string; readonly contentHash: string }[]
  readonly verification: readonly { readonly command: string; readonly exitCode: number; readonly summary: string }[]
  readonly remainingWork: readonly string[]
  readonly nextAction: string
}

/** Latest observable activity for one attempt; reasoning alone is not durable progress. */
export interface GraphExecutionHealth {
  readonly status: 'starting' | 'reasoning' | 'active' | 'checkpointed' | 'stalled'
  readonly startedAt: number
  readonly lastModelActivityAt?: number
  readonly lastDurableProgressAt?: number
  readonly estimatedReasoningTokens: number
  readonly reasoningCharacters: number
  /** Provider-reported uncached input tokens accumulated across this attempt. */
  readonly inputTokens: number
  /** Provider-reported output tokens accumulated across this attempt. */
  readonly outputTokens: number
  /** Provider-reported reasoning subset when the route exposes it. */
  readonly providerReasoningTokens: number
  /** Exact model context capacity recorded by the child request, when advertised. */
  readonly contextWindow?: number
  /** Effective per-activation output ceiling recorded by the child request. */
  readonly maxOutputTokens?: number
  readonly toolCalls: number
  readonly durableActions: number
  readonly changedFileCount: number
  readonly checkpointCount: number
  readonly stalledReason?: 'first-durable-action-timeout' | 'reasoning-budget' | 'checkpoint-timeout' | 'no-durable-progress-timeout' | 'max-wall-time' | 'max-tokens-without-progress'
}

/** Exact model and resource facts frozen for one admitted attempt. */
export interface GraphModelExecutionProfile {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly reasoningEfforts?: readonly string[]
  readonly selectedReasoningEffort?: string
  readonly concurrencyLimit: number
  readonly weightLimit?: number
  readonly memoryClass?: string
  readonly availableDeviceBytes?: number
}

/** Structured, deterministic condition over a predecessor's published JSON output. */
export interface GraphCondition {
  readonly path: readonly string[]
  readonly operator: 'exists' | 'truthy' | 'equals' | 'not-equals'
  readonly value?: null | boolean | number | string
}

/** Dependency between two task nodes. */
export interface GraphEdge {
  readonly from: GraphNodeId
  readonly to: GraphNodeId
  readonly kind: 'control' | 'data' | 'conditional'
  /** Required exactly for a conditional edge. */
  readonly condition?: GraphCondition
  /** Required exactly for a conditional edge. */
  readonly branchGroupId?: GraphBranchGroupId
}

/** How conditional members targeting one node combine. */
export type GraphBranchMode = 'all' | 'any' | 'exactly-one' | 'activated'

/** Named conditional-edge group with deterministic activation semantics. */
export interface GraphBranchGroup {
  readonly id: GraphBranchGroupId
  readonly to: GraphNodeId
  readonly mode: GraphBranchMode
}

/** Resolved termination policy copied into an immutable revision. */
export interface GraphTerminationPolicy extends GraphExecutionPolicy {
  readonly onExhausted: 'failed' | 'awaiting_user'
}

/** One immutable graph revision produced by the controller. */
export interface GraphRevision {
  readonly graphId: GraphId
  readonly revision: number
  readonly objective: string
  readonly createdAt: number
  readonly parentRevision?: number
  readonly userInput: string
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly branchGroups: readonly GraphBranchGroup[]
  readonly terminationPolicy: GraphTerminationPolicy
}

/** User-visible classification of why one immutable revision was created. */
export type GraphRevisionKind = 'new_task' | 'analysis_refactor' | 'execution_correction'

/** Evidence that caused the controller or Host to create one revision. */
export interface GraphRevisionTrigger {
  readonly source: 'user' | 'planning_checkpoint' | 'run_failure' | 'review_rejection' | 'human_control' | 'recovery'
  readonly summary: string
  readonly runId?: GraphRunId
  readonly nodeId?: GraphNodeId
  readonly errorCode?: string
  readonly evidence: readonly string[]
}

/** Typed relationship from one revision to another revision or logical task. */
export interface GraphRevisionRelationship {
  readonly kind: 'derived_from' | 'refactors' | 'corrects' | 'supersedes' | 'depends_on'
  readonly graphId: GraphId
  readonly revision?: number
  readonly reason: string
}

/** Durable controller decision used to explain and render one revision. */
export interface GraphRevisionLineage {
  readonly version: 1
  readonly taskId: GraphTaskId
  readonly kind: GraphRevisionKind
  readonly title: string
  readonly objective: string
  readonly reason: string
  readonly creator: 'controller' | 'human_control' | 'recovery'
  readonly createdAt: number
  readonly trigger: GraphRevisionTrigger
  readonly relationships: readonly GraphRevisionRelationship[]
  readonly successCriteria: readonly string[]
  readonly changes: {
    readonly addedNodeIds: readonly GraphNodeId[]
    readonly changedNodeIds: readonly GraphNodeId[]
    readonly removedNodeIds: readonly GraphNodeId[]
    readonly preservedNodeIds: readonly GraphNodeId[]
    readonly invalidatedNodeIds: readonly GraphNodeId[]
  }
}

/** One immutable batch definition and its compact graph-execution history. */
export interface GraphCampaignBatch {
  readonly id: GraphCampaignBatchId
  readonly ordinal: number
  readonly title: string
  readonly objective: string
  readonly dependsOn: readonly GraphCampaignBatchId[]
  readonly status: 'planned' | 'running' | 'approved' | 'approved_with_findings' | 'rejected' | 'needs_user' | 'blocked'
  readonly graphId?: GraphId
  readonly executions: readonly {
    readonly graphId: GraphId
    readonly revision: number
    readonly runId: GraphRunId
    readonly status: 'running' | 'succeeded' | 'failed' | 'canceled' | 'exhausted' | 'awaiting_user'
    readonly startedAt: number
    readonly completedAt?: number
    readonly settlementIds: readonly GraphSettlementId[]
    readonly summary?: string
  }[]
}

/** One audited append to the ordered Campaign plan. */
export interface GraphCampaignPlanExtension {
  readonly revision: number
  readonly createdAt: number
  readonly reason: string
  readonly addedBatchIds: readonly GraphCampaignBatchId[]
  readonly sourceBatchId?: GraphCampaignBatchId
  readonly sourceRunId?: GraphRunId
  readonly settlementIds: readonly GraphSettlementId[]
}

/** Campaign-level state that links independent batch graphs without copying their nodes. */
export interface GraphCampaign {
  readonly version: 1
  readonly id: GraphCampaignId
  readonly objective: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly phase: 'planned' | 'running' | 'awaiting_user' | 'succeeded' | 'failed' | 'canceled'
  readonly batches: readonly GraphCampaignBatch[]
  readonly activeBatchId?: GraphCampaignBatchId
  /** Append-only plan revision; omission in an older event means revision one. */
  readonly planRevision?: number
  /** Audited suffix additions; omission in an older event means no extensions. */
  readonly planExtensions?: readonly GraphCampaignPlanExtension[]
}

/** Controller-reviewable candidate records produced by an expansion worker. */
export interface GraphExpansionProposal {
  readonly baseRevision: number
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly branchGroups: readonly GraphBranchGroup[]
  readonly changedNodeIds: readonly GraphNodeId[]
  /** Stable scalar keys materialized by a bounded map expansion. */
  readonly mapKeys?: readonly (string | number)[]
}

/** Structured issue that owns an automatic repair scope. */
export interface GraphReviewIssue {
  readonly id: string
  readonly severity: 'blocking' | 'non-blocking'
  readonly summary: string
  readonly evidence: readonly string[]
  readonly ownerNodeIds: readonly GraphNodeId[]
}

/** Durable controller or human decision boundary between immutable revisions. */
export interface GraphCheckpoint {
  readonly id: GraphCheckpointId
  readonly graphId: GraphId
  readonly revision: number
  readonly runId: GraphRunId
  readonly nodeId: GraphNodeId
  readonly kind: 'expansion' | 'repair' | 'planning' | 'environment' | 'awaiting_user'
  readonly status: 'pending' | 'resolved' | 'superseded' | 'canceled'
  readonly createdAt: number
  readonly iteration: number
  readonly reason: string
  readonly proposal?: GraphExpansionProposal
  readonly issues?: readonly GraphReviewIssue[]
  readonly resolvedAt?: number
  readonly replacementRevision?: number
  /** Execution generation authorized by a resolved environment checkpoint. */
  readonly authorizedGeneration?: number
}

/** Durable lifecycle of a node in one run. */
export type GraphNodePhase = 'pending' | 'ready' | 'running' | 'awaiting_user' | 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'stale' | 'canceled' | 'exhausted'

/** JSON value published by a child agent for conditions and downstream prompts. */
export type GraphJsonValue = null | boolean | number | string | readonly GraphJsonValue[] | { readonly [key: string]: GraphJsonValue }

/** Published result of one completed child-agent attempt. */
export interface GraphNodeOutput {
  readonly summary: string
  /** Public-safe progress summary eligible for an external coordination store. */
  readonly coordinationSummary?: string
  readonly data?: GraphJsonValue
  readonly artifacts: readonly string[]
}

/** Durable content-addressed changes produced by one isolated worker attempt. */
export interface GraphAttemptArtifactManifest {
  readonly id: string
  readonly algorithm: 'sha256'
  readonly provider: string
  readonly workId: GraphWorkId
  readonly operationId: GraphControlOperationId
  readonly attemptId: GraphAttemptId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly createdAt: number
  readonly totalBytes: number
  readonly entries: readonly {
    readonly path: string
    readonly sha256: string
    readonly baseSha256?: string | null
    readonly size: number
    readonly mode: number
    readonly kind: 'file' | 'symlink'
  }[]
  readonly providerReference: string
}

/** Auditable attempt metadata; detailed messages and tool events remain in the child session. */
export interface GraphAttempt {
  readonly id: GraphAttemptId
  readonly number: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly childSessionId?: string
  /** Additional child sessions used to continue a token-limited attempt. */
  readonly continuationSessionIds?: readonly string[]
  readonly childRunId?: GraphRunId
  readonly loopxClaimId?: string
  /** Latest bounded activity counters for the active or settled attempt. */
  readonly health?: GraphExecutionHealth
  /** Effective node limits after exact-model and live-resource ceilings. */
  readonly executionBudget?: GraphNodeExecutionBudget
  /** Exact model and capacity facts used for this attempt's admission. */
  readonly modelProfile?: GraphModelExecutionProfile
  /** Durable engineering checkpoints retained in publication order. */
  readonly checkpoints?: readonly GraphExecutionCheckpoint[]
  /** Complete isolated-workspace artifact evidence used by later integration nodes. */
  readonly artifactManifest?: GraphAttemptArtifactManifest
  readonly error?: { readonly code: string; readonly message: string }
}

/** Durable evidence for one conditional branch member. */
export interface GraphBranchMemberEvaluation {
  readonly from: GraphNodeId
  readonly matched: boolean
  readonly predecessorPhase: GraphNodePhase
}

/** Deterministic branch decision retained with the target node state. */
export interface GraphBranchEvaluation {
  readonly evaluatedAt: number
  readonly decision: 'active' | 'inactive' | 'ambiguous'
  readonly groups: readonly {
    readonly id: GraphBranchGroupId
    readonly mode: GraphBranchMode
    readonly matched: number
    readonly considered: number
    readonly active: boolean
    readonly members: readonly GraphBranchMemberEvaluation[]
  }[]
}

/** Current execution state of one node. */
export interface GraphNodeRun {
  readonly workId: GraphWorkId
  readonly nodeId: GraphNodeId
  readonly phase: GraphNodePhase
  readonly attempts: readonly GraphAttempt[]
  /** Latest expiring reason why live model capacity has not admitted this node. */
  readonly resourceWait?: {
    readonly providerId: string
    readonly model: string
    readonly reason: 'provider-degraded' | 'queue' | 'concurrency' | 'weight' | 'memory' | 'oom-backoff' | 'rate-limit' | 'unknown'
    readonly observedAt: number
    readonly retryAt: number
  }
  readonly output?: GraphNodeOutput
  /** Control operation that supplied the output without a Worker attempt. */
  readonly suppliedByControlId?: GraphControlOperationId
  /** Exact condition evidence used to activate, skip, or block this node. */
  readonly branchEvaluation?: GraphBranchEvaluation
  readonly invalidatedBy?: readonly GraphNodeId[]
  /** Successful result reused from an unaffected node in the preceding revision. */
  readonly reusedFrom?: {
    readonly runId: GraphRunId
    readonly generationId: GraphRunGenerationId
    readonly nodeId: GraphNodeId
  }
}

/** Durable lifecycle of one graph run. */
export type GraphRunPhase = 'queued' | 'running' | 'paused' | 'awaiting_user' | 'succeeded' | 'failed' | 'canceled' | 'exhausted'

/** Deterministic rule that accepted one terminal run outcome. */
export interface GraphTerminalEvidence {
  readonly outcome: 'succeeded' | 'failed' | 'canceled' | 'exhausted'
  readonly rule: string
  readonly acceptedAt: number
}

/** Durable failure that prevented a graph run or one of its nodes from continuing. */
export interface GraphRunError {
  readonly code: string
  readonly message: string
  /** Node whose dispatch or execution exposed the failure, when known. */
  readonly nodeId?: GraphNodeId
}

/** Durable per-generation role/model override chosen by a human controller. */
export interface GraphNodeExecutionOverride {
  readonly roleId?: GraphRoleId
  readonly model?: GraphModelSelection
  readonly workerProvider?: string
  /** Complete replacement limits for the restarted node generation. */
  readonly executionBudget?: GraphNodeExecutionBudget
}

/** Whole durable state of one execution of an immutable revision. */
export interface GraphRun {
  readonly id: GraphRunId
  readonly graphId: GraphId
  readonly revision: number
  /** Monotonic execution generation for this immutable design revision. */
  readonly generation: number
  /** Stable id of this recoverable execution generation. */
  readonly generationId: GraphRunGenerationId
  /** Monotonic fencing epoch for scheduler and external writes. */
  readonly ownerEpoch: number
  /** Session role and resource settings frozen when this generation starts. */
  readonly configSnapshot: GraphModeConfig
  /** Explicit node overrides applied only to this generation. */
  readonly overrides: Readonly<Record<string, GraphNodeExecutionOverride>>
  readonly phase: GraphRunPhase
  readonly createdAt: number
  readonly updatedAt: number
  readonly nodes: Readonly<Record<string, GraphNodeRun>>
  readonly terminal?: GraphTerminalEvidence
  /** Terminal failure evidence retained even when no child attempt started. */
  readonly error?: GraphRunError
}

/** Recoverable operation stages for one logical node execution. */
export type GraphOperationStage = 'planned' | 'admitted' | 'claimed' | 'started' | 'progress' | 'output-staged' | 'settlement-pending' | 'reconciled' | 'terminal'

/** Bounded external reference retained for recovery and diagnostics. */
export interface GraphExternalReference {
  readonly kind: 'coordination' | 'worker' | 'workspace' | 'model' | 'child-session' | 'artifact' | 'environment'
  readonly provider: string
  readonly id: string
  readonly fencingToken?: number
}

/** One append-only transition in a logical node operation journal. */
export interface GraphOperationTransition {
  readonly version: 1
  readonly eventId: GraphOperationEventId
  readonly operationId: GraphControlOperationId
  readonly workId: GraphWorkId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly graphId: GraphId
  readonly revision: number
  readonly nodeId: GraphNodeId
  readonly ownerEpoch: number
  readonly stage: GraphOperationStage
  readonly expectedPrevious?: GraphOperationStage
  readonly at: number
  readonly externalReferences: readonly GraphExternalReference[]
  readonly outputHash?: string
  readonly terminalOutcome?: 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'exhausted' | 'uncertain'
  readonly detail?: string
}

/** One append-only external settlement attempt. */
export interface GraphSettlementRecord {
  readonly version: 2
  readonly id: GraphSettlementId
  /** One-based retry attempt under the stable settlement identity. */
  readonly attempt: number
  readonly operationId: GraphControlOperationId
  readonly workId: GraphWorkId
  readonly runId: GraphRunId
  readonly generationId: GraphRunGenerationId
  readonly ownerEpoch: number
  readonly kind: 'coordination' | 'resource-release' | 'artifact' | 'environment' | 'cancellation' | 'compensation'
  readonly outcome: 'pending' | 'confirmed' | 'failed' | 'conflict'
  readonly requestedAt: number
  readonly completedAt?: number
  readonly externalReference?: GraphExternalReference
  readonly evidence?: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** Durable intent and terminal result for accepting one immutable graph revision. */
export interface GraphRevisionSubmissionRecord {
  readonly version: 1
  readonly id: GraphSubmissionId
  readonly intent: 'new' | 'revise'
  readonly graph: GraphRevision
  readonly run: GraphRun
  readonly changedNodeIds: readonly GraphNodeId[]
  readonly outcome: 'pending' | 'accepted' | 'failed'
  readonly requestedAt: number
  readonly completedAt?: number
  readonly error?: { readonly code: string; readonly message: string }
  /** Campaign snapshot committed with the accepted revision and run. */
  readonly campaign?: GraphCampaign
  /** Explanation and typed relationships for this revision; absent on historical records. */
  readonly lineage?: GraphRevisionLineage
}

/** Identity retained for the principal that requested a graph control operation. */
export interface GraphControlActor {
  readonly kind: 'human' | 'controller' | 'system'
  readonly id: string
}

/** Durable human or controller operation over one graph run. */
export interface GraphControlRecord {
  readonly version: 2
  readonly id: GraphControlOperationId
  readonly action: 'pause-run' | 'modify-task' | 'cancel-run' | 'cancel-node' | 'skip-node' | 'retry-node' | 'resume-from-node' | 'override-node' | 'supply-output' | 'rollback' | 'approve-checkpoint' | 'reject-checkpoint' | 'reconcile-run'
  readonly graphId: GraphId
  readonly runId: GraphRunId
  /** Immutable design revision the requester observed. */
  readonly expectedRevision: number
  /** Execution generation the requester observed. */
  readonly expectedGeneration: number
  /** Latest node attempt the requester observed, when the operation addresses one attempt. */
  readonly expectedAttemptId?: GraphAttemptId
  readonly nodeId?: GraphNodeId
  readonly checkpointId?: GraphCheckpointId
  readonly targetRevision?: number
  readonly override?: GraphNodeExecutionOverride
  readonly suppliedOutput?: GraphNodeOutput
  readonly actor: GraphControlActor
  readonly source: 'command' | 'host-api' | 'recovery'
  readonly requestedAt: number
  readonly completedAt: number
  readonly reason: string
  readonly result: {
    readonly outcome: 'applied' | 'no-op'
    readonly detail?: string
  }
  readonly impact: {
    readonly invalidatedNodeIds: readonly GraphNodeId[]
    readonly reusedNodeIds: readonly GraphNodeId[]
  }
  readonly resultingGeneration?: number
  readonly resultingRevision?: number
}

/** Session projection consumed by the host API and browser UI. */
export interface GraphProjection {
  readonly config: GraphModeConfig
  readonly graphs: Readonly<Record<string, readonly GraphRevision[]>>
  readonly runs: Readonly<Record<string, GraphRun>>
  /** Append-only operation journals keyed by stable logical work id. */
  readonly operations: Readonly<Record<string, readonly GraphOperationTransition[]>>
  /** Append-only external settlement attempts keyed by stable settlement id. */
  readonly settlements: Readonly<Record<string, readonly GraphSettlementRecord[]>>
  /** Latest state of every recoverable graph-revision submission. */
  readonly submissions: Readonly<Record<string, GraphRevisionSubmissionRecord>>
  /** Latest state of every durable planning or human checkpoint. */
  readonly checkpoints: Readonly<Record<string, GraphCheckpoint>>
  /** Accepted human and controller operations keyed by stable operation id. */
  readonly controls: Readonly<Record<string, GraphControlRecord>>
  /** Multi-graph campaigns keyed by stable campaign id. */
  readonly campaigns: Readonly<Record<string, GraphCampaign>>
  readonly currentGraphId?: GraphId
  readonly currentCampaignId?: GraphCampaignId
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Live host fold state for durable graph-mode execution. */
    graph: GraphProjection
  }

  interface SessionProjectionMap {
    /** Durable graph-mode configuration, graph revisions, and execution snapshots. */
    graph: GraphProjection
  }
}
