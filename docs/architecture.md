# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

Read this before changing anything under `packages/`. It assumes you know Cordis; if you do not, start with the [primer](cordis-primer.md) or the [tutorial](cordis-tutorial/index.md).

We recommend using an agent to explore the codebase and understand its architecture.

## Cordis

[Cordis](cordis-primer.md) is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so every part is replaceable from configuration.

There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

## Profiles and bundles

A running `dsh` is a plugin tree composed at boot from ordered layers.

A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`. `web` and `headless` ship as templates.

A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.

Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

[`dsh-base`](../packages/bundle/base/README.md) is the first layer of every profile: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. [`dsh-web-app`](../packages/bundle/web-app/README.md) adds the browser application; [`dsh-headless`](../packages/bundle/headless/README.md) adds a one-shot runner with no server at all.

Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows.

To see the tree your machine actually boots:

```sh
dsh --profile web --dump-config
```

Any row it prints can be replaced by a patch of your own.

Composition mechanics are in [app-boot](../packages/boot/app-boot/README.md#profiles); config fields are in the generated [config catalog](config-catalog.md).

## Core packages

Here are some core packages that contribute to the Cordis tree.

| Package | Owns | `ctx` key |
|---|---|---|
| [`core/session`](subsystems/session.md) | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | The default driver implementing that interface | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | The per-agent scoped-registration primitive | library, no key |
| [`llm/llm`](subsystems/llm-streaming.md) | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

## Events

Events are the extension points, and picking the right domain is the first decision in most changes.

- **Session events** are durable facts appended to the log and broadcast through `session/event`. Use one when the fact must survive a reload.
- **Agent events** (`agent/*`) carry a live `Agent`: inbox, step, status, request, validation, continuation. Use one to observe or intercept work in flight.
- **Capability events** attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop.

The [event map](event-producer-consumer.md) lists every event's producers and consumers.

## Turn flow

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, and `tool/*` are durable session events; the rest are live extension points across three domains. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls, whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does.

`agent/pre-step` decides what the model sees. Listeners may rewrite the claimed messages or reject them outright; a rejected or empty first claim still closes a durable turn that spent no step, so the log records the attempt. Each step reads the prompt sections and tool schemas that plugins registered.

Details: the [sequence diagram](agent-lifecycle.md), the [tool pipeline](tool-execution-pipeline.md), and [cancellation and error recovery](subsystems/core.md#the-agent-handle).

## Session log

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log.

## Graph Mode

[`dsh-graph`](../packages/graph/graph/README.md) adds a session-owned multi-agent orchestration domain without changing the agent loop. `/graph` activates a controller policy and a `graph_submit` tool. The controller classifies every later human input, creates a new immutable DAG for new work, or creates the next revision of the current graph for an adjustment. Graph definitions and whole-run snapshots are session events, so reload, inspection, and the Web projection reconstruct the same revisions and evidence.

An ordered long objective uses a Campaign above the Revision layer. Each Batch owns an independent Graph and contains only its current work; Campaign events retain Batch dependencies, status, compact results, and Settlement references. Registered Batch definitions form an immutable prefix. After every registered Batch is accepted, the controller may append a newly discovered ordered suffix as an audited plan revision whose reason and predecessor Run and Settlement evidence remain durable. A successful Batch activates the next ready Batch through a controller follow-up, while a correction revises only the failed Batch Graph. This separates cross-task history from within-task revision lineage and prevents completed nodes from accumulating in later DAGs.

[`dsh-graph-mode`](../packages/graph/graph-mode/README.md) schedules ready nodes through the [`dsh-graph-worker`](../packages/graph/graph-worker/README.md) seam. Required edges impose predecessor completion; structured conditional edges inspect published JSON and contain no executable code. A revision derives directly changed nodes, then invalidates every transitive successor in topological order. Successful nodes outside that closure retain their published output with explicit provenance. Admission applies global, per-role, exact provider/model, and optional weighted limits before a child starts, while a controller reserve prevents worker saturation from consuming every configured permit. An optional [`dsh-graph-resources`](../packages/graph/graph-resources/README.md) provider may further delay or reject work from expiring route telemetry but cannot raise those static ceilings.

Host changes are explicit environment nodes, not enlarged Worker authority. The controller places a bounded exact-command plan before dependent engineering work and names its required network, package-install, or Docker capabilities. Deployment policy validates the plan, then Graph pauses at a human checkpoint. Approval is scoped to the next execution generation; Graph Mode executes the immutable commands through the Shell capability with stable Settlements and never grants a model child an open-ended privileged turn. Failed, uncertain, or rollback effects require a new human decision.

Every immutable node carries a resolved execution budget for model output, reasoning without durable progress, first action, progress silence, checkpoints, wall time, and continuations. Before admission, Graph Mode resolves the exact LLM route, validates its reasoning effort, intersects output and concurrency limits with live resource facts, and stores the effective model profile on the attempt. Child session events keep model activity separate from recoverable engineering progress; only successful file mutations, focused verification commands, and the accepted structured result advance a checkpoint. A token-limited or watchdog-stopped activation may continue only from a durable checkpoint. A stop without one returns the exact route, capacity, budget, counters, and latest evidence to the controller, which must revise unsafe work into 10–30 minute independently verifiable nodes instead of redispatching the same coarse task.

Whole-run ownership is separate from node execution. [`dsh-graph-scheduler`](../packages/graph/graph-scheduler/README.md) grants one expiring fenced lease to the Host allowed to advance a run; Graph Mode heartbeats it for the duration of scheduling and uses its token as `ownerEpoch`. A recovery scan reacquires queued or running durable work that has no local executor, while a live lease prevents duplicate execution. Graph state reads use the eagerly maintained session projection when available so large logs do not starve lease heartbeats. The SQLite Provider serializes local Host processes and preserves fencing counters across expiry and restart. Multi-Host deployments replace it with an authenticated distributed Provider; LoopX node claims do not substitute for this lease.

External progress coordination is a separate capability seam. [`dsh-graph-coordination`](../packages/graph/graph-coordination/README.md) owns preparation, fenced claims, heartbeats, observation and watch, bounded progress, cancellation, settlement, and reconciliation; the [LoopX provider](../packages/graph/graph-coordination-loopx/README.md) maps them to an existing goal and registered peers. Claiming an already terminal Activation returns its accepted terminal disposition and never dispatches another Worker. Graph persists operation, worker, workspace, model-reservation, artifact, settlement, checkpoint, and human-control evidence before accepting terminal state. Harness remains the execution and transcript authority. Coordination records receive bounded public-safe summaries, while child messages and tool events remain in their child sessions.

Artifact transport is another replaceable seam. [`dsh-graph-artifacts`](../packages/graph/graph-artifacts/README.md) binds every manifest to one fenced attempt and validates paths, result hashes, source hashes, byte totals, and Provider ownership. Isolated implementation attempts persist the complete manifest in Graph run evidence. An integration node collects transitive upstream manifests, rejects same-path divergence and source drift before any materialization, imports each manifest under a stable Settlement, and applies its own accepted manifest through the same check. The filesystem Provider stores immutable blobs for same-filesystem Hosts; authenticated object-store or RPC Providers can replace it without changing Graph Mode or Worker assignment.

Remote execution uses [`dsh-graph-worker-remote`](../packages/graph/graph-worker-remote/README.md). Its HTTP Client and Server authenticate Worker, Scheduler, Resource, and Artifact operations through credential references, persist deterministic logical job identities before dispatch, deduplicate lost-response retries, fence superseded process writes with a durable service epoch, quarantine uncertain nonterminal jobs after restart, and map reconciliation to exact underlying Provider references. Optional routes expose cross-Host Scheduler and Resource authorities plus bounded content-addressed Artifact transfer with durable opaque mappings and end-to-end digest verification. The SQLite Resource Provider can fail closed on expiring queue and device-memory snapshots from a trusted model runtime or sidecar. The Worker journal is one active service's persistence authority; it does not provide resumable remote processes, replicated high availability, native model-server metrics adapters, or an object store.

## Capability seams

A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three ([capability graph](capability-seams.md)).

Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks. [Subagent providers](subsystems/subagent.md) vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product.

[Experimental Agent Teams](subsystems/agent-team.md) is a private opt-in coordination seam on `ctx.agentTeams`, with a durable roster, task board, and mailbox layered over continuable subagents.

## Where new behavior goes

New behavior attaches to a documented extension point. Changing the loop itself updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it |
| Orchestrate dependent multi-agent work | use `dsh-graph-mode`; replace external coordination through `ctx.graphCoordination` |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add a Web Client Chat node | register a `ConversationNodeDefinition` + keyed renderer |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Generate session titles | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Fork a live session | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a registration to one agent | use that agent's `agent.ctx` |

The [extension cookbook](cookbook/extension-cookbook.md) maps features to capabilities and indexes the step-by-step guides for [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), [Chat nodes](cookbook/adding-a-conversation-node.md), and [settings cards](cookbook/adding-a-settings-card.md).
