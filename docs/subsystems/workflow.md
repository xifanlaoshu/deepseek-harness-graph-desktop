# Workflow

English | [中文](workflow.zh.md)

The workflow seam lets an agent run a model-written orchestration SCRIPT that starts subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). Like bash, it permits ONE engine implementation per context to provide `ctx.workflowEngine`; there is no named-provider registry (a second engine replaces the first through plugin configuration rather than running beside it).

Service Definition: [dsh-workflow](../../packages/workflow/workflow) (`ctx.workflowEngine` + the vocabulary below). The Service Provider is [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread) (a `node:worker_threads` engine — one worker per run, the script's vm context inside it); the model-facing Consumer is [dsh-tool-workflow](../../packages/workflow/tool-workflow). The proposal and rationale: [the dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md).

Sources: browser-safe vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts), Host request and live-run handles in [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts).

## The start request

What a caller asks for when starting a run. The ordinary workflow tool builds this from the model's `{ script, meta, args }` call plus the calling agent; specialized consumers may also select one engine-wide `subagentProvider` and lower `maxTotalAgents` for the run, but the script cannot observe or replace either policy. `meta` and `args` are plain JSON DATA (the engine validates `meta` against its schema and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script starts is attributed to it, and cwd, lineage, and depth pass through the [subagent seam](subagent.md).

```ts type-equiv
/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}
```

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

```ts type-equiv
/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}
```

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (grace force-settle,
   * worker death) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}
```

## A live run: `WorkflowRun`

The handle the consumer holds while a script executes. The consumer awaits `result`, may `cancel` mid-flight, and MUST `dispose` on every path. `result` does NOT reject — a script failure resolves with `stopReason: 'error'` — and once the run is cancelled it SETTLES within the engine's bounded grace even if the script itself never settles (the engine force-settles `cancelled`; the worker-thread engine then terminates the script's worker), so a consumer awaiting `result` is never wedged past a cancellation. `dispose()` = cancel + that bounded settle + child quiescence; it never hangs on a stuck script.

```ts type-equiv
/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>
}
```

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](#cordis-surface)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.

## Durable Chat records

The top-level `dsh-tool-workflow` consumer projects display facts into its calling parent Session without changing execution ownership. It writes `tool-workflow/run-start` after a run is accepted, pairs member start and end by `runId + seq`, and writes `tool-workflow/run-end` only after the result is known and disposal reaches quiescence. Nested transport calls write no record. The first append failure disables later writes for that run, so the log remains empty or a legal continuous prefix and the tool result is unchanged.

`dsh-tool-workflow/invariant` validates the same protocol before live commit and when a Session is loaded: one start per run, positive unique member sequences, paired member endings, no run ending with open members, and no updates after the run ending. A missing member ending or run ending at the log tail is valid interruption evidence rather than corruption.

`dsh-client-ui-workflow-run` folds the four events through the Conversation Node engine into one `workflow-run` Chat node anchored at the run-start sequence, after the original workflow tool node. Phase groups come only from actual member starts and preserve exact strings, including the distinction between an omitted phase and `''`. Closed Locations turn missing terminal facts into interrupted presentation. The [UI package README](../../packages/client/ui-workflow-run/README.md) owns disclosure, status, and same-parent local navigation behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgraphartifacts--graphartifactruntime"></a>

### `ctx.graphArtifacts` — `GraphArtifactRuntime`

Registry, validation, and dispatch for Graph artifact Providers.

```ts cordis-catalog
/**
 * Register one unique artifact Provider.
 * @param provider authenticated storage or transport implementation.
 * @returns disposer for only this registration.
 */
register(provider: GraphArtifactProvider): () => void

/**
 * Inspect the registered artifact routes without exposing mutable Provider objects.
 * @returns detached Provider deployment facts.
 */
list(): readonly { readonly name: string; readonly persistent: boolean; readonly remote: boolean }[]

/**
 * Capture and validate files produced by one fenced Worker attempt.
 * @param providerName registered transport route.
 * @param request exact attribution, source, selection, and bounds.
 * @returns immutable manifest owned by the selected Provider.
 */
async capture(providerName: string, request: GraphArtifactCaptureRequest): Promise<GraphArtifactManifest>

/**
 * Materialize a validated immutable manifest into one explicit workspace.
 * @param providerName registered transport route.
 * @param request manifest, target, and overwrite policy.
 * @returns paths and byte count written from the complete manifest.
 */
async materialize(providerName: string, request: GraphArtifactMaterializeRequest): Promise<GraphArtifactMaterializeResult>

/**
 * Reconcile one abandoned provider reference without guessing ownership.
 * @param providerName registered transport route.
 * @param request exact manifest reference and deletion authority.
 * @returns auditable Provider disposition.
 */
async reconcile(providerName: string, request: GraphArtifactReconcileRequest): Promise<GraphArtifactReconcileResult>
```

Source: [`packages/graph/graph-artifacts/src/index.ts`](../../packages/graph/graph-artifacts/src/index.ts)

<a id="ctxgraphcoordination--graphcoordination-abstract-seam"></a>

### `ctx.graphCoordination` — `GraphCoordination` (abstract seam)

Provider-neutral external coordination seam.

```ts cordis-catalog
/**
 * Validate external coordination identity for one immutable revision.
 * @param graph immutable revision being admitted.
 * @param roles configured roles available to its nodes.
 * @param cwd session working directory used by the provider.
 * @param signal caller cancellation.
 */
abstract prepare(graph: GraphRevision, roles: readonly GraphRole[], cwd: string, signal: AbortSignal): Promise<void>

/**
 * Claim a ready node and return a compact fresh observation.
 * @param request graph, run, node, role, and working-directory identity.
 * @param signal caller cancellation.
 * @returns provider claim and bounded observation for the worker.
 */
abstract claim(request: GraphCoordinationRequest, signal: AbortSignal): Promise<GraphCoordinationClaim>

/**
 * Renew one exact live lease and return its fresh cursor.
 * @param request fenced claim and monotonic progress sequence.
 * @param signal caller cancellation.
 * @returns renewed lease, fencing, progress, and cancellation state.
 */
abstract heartbeat(request: GraphCoordinationHeartbeat, signal: AbortSignal): Promise<GraphCoordinationHeartbeatResult>

/**
 * Read a consistent public-safe snapshot without taking ownership.
 * @param request stable work identity and optional event cursor.
 * @param signal caller cancellation.
 * @returns current claim state and ordered event suffix.
 */
abstract observe(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation>

/**
 * Wait for or poll ordered public-safe changes after a durable cursor.
 * @param request stable work identity and optional event cursor.
 * @param signal caller cancellation or wait deadline.
 * @returns current claim state and ordered event suffix.
 */
abstract watch(request: GraphCoordinationObserveRequest, signal: AbortSignal): Promise<GraphCoordinationObservation>

/**
 * Append one idempotent bounded progress record.
 * @param request fenced claim, sequence, and public-safe evidence.
 * @param signal caller cancellation.
 * @returns durable cursor assigned to the progress record.
 */
abstract publishProgress(request: GraphCoordinationProgress, signal: AbortSignal): Promise<{ readonly cursor: string }>

/**
 * Write terminal progress and public-safe evidence.
 * @param request claim identity, terminal outcome, and public-safe evidence.
 * @param signal settlement cancellation; Consumers must not reuse a canceled worker signal.
 */
abstract settle(request: GraphCoordinationSettlement, signal: AbortSignal): Promise<void>

/**
 * Request cooperative cancellation without accepting a terminal result.
 * @param request fenced live claim and public-safe reason.
 * @param signal caller cancellation.
 */
abstract cancel(request: GraphCoordinationCancellation, signal: AbortSignal): Promise<void>

/**
 * Compare exact Graph references with provider-owned durable evidence.
 * @param request stable work identity and optional claim, lease, fencing, and outcome expectations.
 * @param signal caller cancellation.
 * @returns confirmed, absent, conflicting, or unknown provider evidence.
 */
abstract reconcile(request: GraphCoordinationReconcileRequest, signal: AbortSignal): Promise<GraphCoordinationReconcileResult>
```

Source: [`packages/graph/graph-coordination/src/index.ts`](../../packages/graph/graph-coordination/src/index.ts)

<a id="ctxgraphmode--graphmodecontroller"></a>

### `ctx.graphMode` — `GraphModeController`

`ctx.graphMode`: owns graph configuration, controller submission, and background runs.

```ts cordis-catalog
/**
 * Return replayed state for one live agent.
 * @param agent session owner whose graph events are folded.
 * @returns current graph-mode projection.
 */
state(agent: Agent): GraphProjection

/**
 * Reconcile and resume durable nonterminal work after an Agent is restored.
 * @param agent restored session owner whose nonterminal runs are recovered.
 * @param requestedRunId optional exact run selected for manual reconciliation.
 */
async recover(agent: Agent, requestedRunId?: GraphRunId): Promise<void>

/**
 * Validate and durably replace one session's graph-mode settings.
 * @param agent session owner receiving the configuration event.
 * @param config complete replacement configuration.
 */
setConfig(agent: Agent, config: GraphModeConfig): void

/**
 * Execute one idempotent human or controller operation over a durable run.
 * @param agent session owner receiving the addressed operation.
 * @param request stable operation id, action, target, and reason.
 * @param authority host-authenticated principal and ingress.
 * @returns durable accepted control record, or its existing duplicate.
 */
async control( agent: Agent, request: GraphControlRequest, authority: GraphControlAuthority = { actor: { kind: 'system', id: 'graph-mode' }, source: 'host-api' }, ): Promise<import('@deepseek-ai/dsh-graph').GraphControlRecord>

/**
 * Accept one controller decision and start background work when needed.
 * @param agent controller agent and durable session owner.
 * @param submission classified input plus an optional complete graph revision.
 * @param signal cancellation for validation and external preparation.
 * @returns accepted classification and identities for any started graph run.
 */
async submit( agent: Agent, submission: GraphSubmission, signal: AbortSignal = new AbortController().signal, ): Promise<{ accepted: true; intent: ControllerIntent; graphId?: string; runId?: string }>
```

Types: [Agent](core.md)

Source: [`packages/graph/graph-mode/src/index.ts`](../../packages/graph/graph-mode/src/index.ts)

<a id="ctxgraphresources--graphresourceruntime"></a>

### `ctx.graphResources` — `GraphResourceRuntime`

Named registry that validates every observation, reservation, and outcome.

```ts cordis-catalog
/**
 * Register one unique resource Provider until disposal.
 * @param provider named observation and reservation authority.
 * @returns disposer that removes only this registration.
 */
register(provider: GraphResourceProvider): () => void

/**
 * Observe one exact route without reserving it.
 * @param name registered resource Provider name.
 * @param route exact provider and model route.
 * @param signal caller cancellation.
 * @returns validated expiring route observation.
 */
async observe(name: string, route: GraphResourceRoute, signal: AbortSignal): Promise<GraphResourceSnapshot>

/**
 * Ask one Provider for capacity beneath the request's hard configured ceilings.
 * @param name registered resource Provider name.
 * @param request fenced work identity, route, weight, ceilings, and deadline.
 * @param signal caller cancellation.
 * @returns granted reservation, typed wait, or terminal rejection.
 */
async reserve(name: string, request: GraphResourceReservationRequest, signal: AbortSignal): Promise<GraphResourceDecision>

/**
 * Report one fenced release or resource signal idempotently to its Provider.
 * @param outcome exact reservation identity and terminal resource classification.
 * @param signal caller cancellation independent from the worker signal.
 */
async report(outcome: GraphResourceOutcome, signal: AbortSignal): Promise<void>

/**
 * Reconcile and release one exact prior reservation after scheduler recovery.
 * @param request fenced reservation identity and public-safe evidence.
 * @param signal caller cancellation independent from the abandoned Worker.
 * @returns provider-confirmed release, absence, or conflict.
 */
async reconcile(request: GraphResourceReconcileRequest, signal: AbortSignal): Promise<GraphResourceReconcileResult>
```

Source: [`packages/graph/graph-resources/src/index.ts`](../../packages/graph/graph-resources/src/index.ts)

<a id="ctxgraphscheduler--graphschedulerruntime"></a>

### `ctx.graphScheduler` — `GraphSchedulerRuntime`

`ctx.graphScheduler`: validates and routes fenced ownership operations.

```ts cordis-catalog
/**
 * Register one named ownership Provider for its Cordis lifetime.
 * @param provider named Provider to expose.
 * @returns disposer that removes this exact registration.
 */
register(provider: GraphSchedulerProvider): () => void

/**
 * Atomically acquire or renew ownership of one run.
 * @param providerId registered Provider name.
 * @param request exact run and Host identity.
 * @param signal cancellation for this Provider operation.
 * @returns granted lease or bounded busy decision.
 */
async acquire(providerId: string, request: GraphSchedulerAcquireRequest, signal: AbortSignal): Promise<GraphSchedulerDecision>

/**
 * Renew one exact lease; stale identities fail instead of silently reacquiring.
 * @param request exact current lease identity.
 * @param signal cancellation for this Provider operation.
 * @returns renewed lease with unchanged fencing identity.
 */
async heartbeat(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<GraphSchedulerLease>

/**
 * Release one exact lease idempotently; a fenced identity is rejected.
 * @param request exact current lease identity.
 * @param signal cancellation for this Provider operation.
 */
async release(request: GraphSchedulerLeaseRequest, signal: AbortSignal): Promise<void>
```

Source: [`packages/graph/graph-scheduler/src/index.ts`](../../packages/graph/graph-scheduler/src/index.ts)

<a id="ctxgraphworkers--graphworkerruntime"></a>

### `ctx.graphWorkers` — `GraphWorkerRuntime`

Provider registry and capability-validating assignment Consumer API.

```ts cordis-catalog
/**
 * Register one unique provider until the returned disposer runs.
 * @param provider named Worker implementation and advertised capabilities.
 * @returns disposer that removes only this registration.
 */
register(provider: GraphWorkerProvider): () => void

/**
 * Return detached descriptors for deployment inspection and scheduler selection.
 * @returns registered provider names and copied capability declarations.
 */
list(): readonly { readonly name: string; readonly capabilities: GraphWorkerCapabilities }[]

/**
 * Validate requirements and assign work to one exact provider.
 * @param name registered Worker Provider name.
 * @param assignment frozen fenced node attempt.
 * @returns published worker, workspace, result, and cancellation handle.
 */
async start(name: string, assignment: GraphWorkerAssignment): Promise<GraphWorkerRun>

/**
 * Reconcile one provider-owned Worker and workspace after scheduler recovery.
 * @param name registered Worker Provider name.
 * @param request exact prior work and allocation references plus deletion authority.
 * @param signal caller cancellation independent from the abandoned Worker signal.
 * @returns validated provider disposition and bounded evidence.
 */
async reconcile(name: string, request: GraphWorkerReconcileRequest, signal: AbortSignal): Promise<GraphWorkerReconcileResult>
```

Source: [`packages/graph/graph-worker/src/index.ts`](../../packages/graph/graph-worker/src/index.ts)

<a id="ctxworkflowengine--workflowengine-abstract-seam"></a>

### `ctx.workflowEngine` — `WorkflowEngine` (abstract seam)

Workflow Service Definition contract. Invalid requests throw before publication; a live run is holder-owned, its result never rejects, cancellation and disposal are bounded, and disposal waits for child cleanup within that bound. Lifecycle listener failures are contained, and `workflow/end` fires exactly once as the result settles.

```ts cordis-catalog
/**
 * Parse and execute a workflow script.
 * @param request - the script, its `args`, the parent agent, and an
 *   optional cancel signal.
 * @returns the live run; its `result` resolves when the script settles.
 */
abstract start(request: WorkflowStartRequest): WorkflowRun
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflow-events"></a>

### `workflow/*` events

<a id="workflowagent-end--emit"></a>

#### `workflow/agent-end` — emit

One `agent()` call settled (clean result, child failure, or run cancellation). Paired with Events['workflow/agent-start'] by `agent.seq`, exactly once per started call on every stop path — on an engine termination path (a worker killed past its grace) the end is engine-synthesized with outcome `'cancelled'`.

```ts cordis-catalog
/**
 * One `agent()` call settled (clean result, child failure, or run
 * cancellation). Paired with {@link Events['workflow/agent-start']} by
 * `agent.seq`, exactly once per started call on every stop path — on an
 * engine termination path (a worker killed past its grace) the end is
 * engine-synthesized with outcome `'cancelled'`.
 * @param info - the run's identity snapshot.
 * @param agent - the call identity plus its outcome.
 * @mode emit
 */
'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-start--emit"></a>

#### `workflow/agent-start` — emit

One `agent()` call established a published child run. Paired with Events['workflow/agent-end'] by `agent.seq`. A call that never receives a published run from the provider emits neither event in this pair.

```ts cordis-catalog
/**
 * One `agent()` call established a published child run. Paired with
 * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
 * receives a published run from the provider emits neither
 * event in this pair.
 * @param info - the run's identity snapshot.
 * @param agent - the call's sequence number, label, phase, and child id.
 * @mode emit
 */
'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowend--emit"></a>

#### `workflow/end` — emit

A workflow run settled (any stop reason). Fired when WorkflowRun.result resolves. Paired with Events['workflow/start'].

```ts cordis-catalog
/**
 * A workflow run settled (any stop reason). Fired when
 * {@link WorkflowRun.result} resolves. Paired with
 * {@link Events['workflow/start']}.
 * @param info - the run's identity snapshot.
 * @param result - the outcome data (stop reason, error, agent count) —
 *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
 * @mode emit
 */
'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowlog--emit"></a>

#### `workflow/log` — emit

The script emitted a narration line (a `log(message)` call).

```ts cordis-catalog
/**
 * The script emitted a narration line (a `log(message)` call).
 * @param info - the run's identity snapshot.
 * @param message - the logged message, verbatim.
 * @mode emit
 */
'workflow/log'(info: WorkflowRunInfo, message: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowphase--emit"></a>

#### `workflow/phase` — emit

The script entered a phase (a `phase(title)` call) — progress grouping for observers; no execution semantics.

```ts cordis-catalog
/**
 * The script entered a phase (a `phase(title)` call) — progress grouping
 * for observers; no execution semantics.
 * @param info - the run's identity snapshot.
 * @param title - the phase title, verbatim.
 * @mode emit
 */
'workflow/phase'(info: WorkflowRunInfo, title: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowstart--emit"></a>

#### `workflow/start` — emit

A workflow run started — the script's meta block validated, the body about to execute. Paired with Events['workflow/end'].

```ts cordis-catalog
/**
 * A workflow run started — the script's meta block validated, the body
 * about to execute. Paired with {@link Events['workflow/end']}.
 * @param info - the run's identity snapshot (id + meta).
 * @mode emit
 */
'workflow/start'(info: WorkflowRunInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)
<!-- END GENERATED cordis-surface -->
