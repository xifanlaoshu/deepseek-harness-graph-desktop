# Graph 编排

[English](graph.md) | 中文

Graph Mode 管理逐会话的 DAG 修订与 Run。[Graph 包参考](../../packages/graph/graph/README.zh.md)定义持久记录与修订规则；[Graph Mode 参考](../../packages/graph/graph-mode/README.zh.md)规定主控准入、调度、恢复和人工控制。下列服务分别负责制品证据、外部协作、模型资源预留、整个 Run 的执行权与节点 Worker。

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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
<!-- END GENERATED cordis-surface -->
