# 工作流

[English](workflow.md) | 中文

工作流 seam 允许 agent（智能体）运行由模型编写、会启动 subagent 的编排脚本。与 [subagent](subagent.zh.md) 一样，它是**一项可选能力**，不属于 agent loop，因此其类型和操作记录在此处，而非 [core.md](core.zh.md)。与 bash 一样，每个上下文只允许一个引擎实现提供 `ctx.workflowEngine`；没有命名提供方注册表（第二个引擎通过插件配置替换第一个，而不与它同时运行）。

Service Definition：[dsh-workflow](../../packages/workflow/workflow)（`ctx.workflowEngine` + 下文词汇）。Service Provider 是 [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread)（一个 `node:worker_threads` 引擎——每个 run 一个 worker，脚本的 vm 上下文位于其中）；面向模型的 Consumer 是 [dsh-tool-workflow](../../packages/workflow/tool-workflow)。提案与设计理由见 [dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)。

源码：浏览器安全词汇位于 [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)，Host 请求与活跃运行句柄位于 [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts)。

## 启动请求

本节定义调用方启动一次运行时提交的请求。普通工作流工具会根据模型的 `{ script, meta, args }` 调用和发起调用的 agent 构建该请求；专用消费方还可以为本次运行选择引擎级 `subagentProvider`，并将 `maxTotalAgents` 调低，但脚本无法观察或替换这两项策略。`meta` 与 `args` 是普通 JSON 数据；引擎会用 schema 校验 `meta`，并在任何工作开始前明确报错并拒绝无效数据。引擎绝不会通过对脚本文本求值来获取它们。`parent` 是必填字段——脚本启动的每个子 agent 都归属于它，cwd、谱系与深度通过 [subagent seam](subagent.zh.md) 传递。

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

## 工作流的身份标识：`WorkflowMeta`

作为数据附在启动请求上的身份块（工具的 `meta` 参数；字段词汇与 Claude Code 动态工作流的 meta 块一致）。`phases` 仅用于进度展示：`phase()` 调用与标题匹配，供观察者使用；不暗示任何执行结构。

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

## 终态结果：`WorkflowResult`

`WorkflowRun.result` 会兑现为一次运行的结果。`value` 是脚本的物化返回值——纯宿主域 JSON 数据（脚本无返回值时为 `null`）——仅在 `completed` 时有意义。`stopReason` 是封闭联合类型（由引擎定义；消费方可穷举）：`completed` | `cancelled` | `error`。非 `completed` 的原因在 `error` 中携带失败信息，消费方将其映射为 `isError` 工具结果，而非把部分输出当作成功上报。

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

## 活跃运行：`WorkflowRun`

脚本执行期间消费方持有的句柄。消费方会等待 `result`，可以在运行期间调用 `cancel`，并且必须在每条路径上调用 `dispose`（资源释放）。`result` 不会被拒绝：脚本失败会兑现为 `stopReason: 'error'`。运行被取消后，即使脚本本身永不结算，结果也会在引擎规定的有界宽限期内结算；引擎会强制将其结算为 `cancelled`，随后 worker-thread 引擎会终止脚本所在的 worker。因此，等待 `result` 的消费方不会在取消后无限期挂起。`dispose()` 会执行取消、等待有界结算并等待子 agent 完全停稳，不会因脚本卡死而挂起。

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

## 失败纪律：`WorkflowError.fatal`

脚本内部的钩子误用：错误参数、未知或延迟的 `agent()` 选项、超出[结构化输出子集](../../packages/core/tools/README.zh.md)的 schema、超出上限、seam 启动失败、取消，都会抛出 `fatal: true` 的 `WorkflowError`。`parallel()`/`pipeline()` 组合器对 fatal 错误直接重新抛出，而非将该项映射为 `null`：一个拼写错误的选项必须明确报错并终止脚本，绝不能消融为看似普通子 agent 失败的结果。逐项的 `null` 保留给子运行失败（非 `completed` 的 stop reason）和阶段内的普通脚本错误。

## 事件

`workflow/*` 事件（`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end`，见[事件目录](#cordis-surface)）是**仅供观察**的 emit，携带数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，而非活跃的 `WorkflowRun`，因此订阅者无法获得 `cancel`/`dispose`；`workflow/end` 刻意省略 result value（观察结果的监听器不得收到调用方 result 的可变别名）。每次 emit 对每个监听器隔离：订阅者抛出的异常会被记录到日志中而不会传播，也不会阻止后续注册的监听器收到事件；每个监听器收到自己的 payload 克隆，因此修改它既不会损坏引擎也不会影响其他监听器。这种隔离方式与 `subagent/start`/`subagent/end` 一致。

## 持久 Chat 记录

顶层 `dsh-tool-workflow` 消费方把展示事实投影到调用它的父 Session，同时不改变执行所有权。运行接受后写 `tool-workflow/run-start`，以 `runId + seq` 配对成员开始与结束，并且只在结果已取得且 dispose 完全停稳后写 `tool-workflow/run-end`。嵌套 transport 调用不写记录。第一次 append 失败会禁用本运行后续写入，因此日志保持为空或合法连续前缀，工具结果不变。

`dsh-tool-workflow/invariant` 会在实时提交前和 Session 加载时校验同一协议：每个运行只有一个 start，成员序号为正且唯一，成员 end 必须配对，仍有开放成员时不能结束运行，运行结束后不能继续更新。日志尾部缺少成员 end 或 run end 是有效的中断证据，不是损坏。

`dsh-client-ui-workflow-run` 通过 Conversation Node 引擎把四类事件折叠为一个 `workflow-run` Chat 节点，以 run-start 序号锚定在原工作流工具节点之后。阶段组只来自真正开始过的成员，并保留精确字符串，包括字段缺省与 `''` 的区别。Location 关闭时，缺失终点会显示为已中断。[界面包 README](../../packages/client/ui-workflow-run/README.zh.md)负责定义 disclosure、状态与同父本地导航行为。

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
