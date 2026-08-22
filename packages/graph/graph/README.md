# `@deepseek-ai/dsh-graph`

English | [中文](README.zh.md)

`dsh-graph` owns the durable vocabulary and replay rules for graph-mode multi-agent orchestration. It provides editable software-engineering role defaults, immutable DAG revisions, whole-run snapshots, deterministic conditional edges, downstream invalidation, and the `graph` session projection.

`graph/submission` is the durable provisional record for one candidate Revision and queued Run. A pending submission does not change `currentGraphId`; the Consumer first establishes external run ownership, then appends the immutable Revision, Run, planned operations, and accepted submission result. A failed submission remains auditable without creating a Head Revision. Coordination uses a Generation-scoped `GraphActivationId` alongside the stable logical `GraphWorkId`.

Host plugins validate controller output with `validateGraphRevision()` before appending `graph/change`. Every adjustment creates the next immutable revision. `downstreamInvalidation()` returns directly changed nodes and all transitive successors in topological order; a scheduler marks or cancels those nodes and executes the new revision without rewriting prior evidence. An unaffected accepted result reused by another revision or generation records its exact source run, generation, and node; stale invalidation metadata is removed instead of making reuse appear re-executed. Node attempts retain child session and LoopX claim identifiers, while detailed messages and tool events stay in the child session log.

The default team contains one controller plus analyst, architect, engineer, reviewer, verifier, and writer roles. Every role's provider, model, reasoning selector, prompt, and parallelism is editable. Global, model, and optional weighted limits are hard admission inputs; the controller reserve prevents worker saturation from starving intent classification. The default engineer cap is one because this package does not claim workspace isolation that its subagent provider cannot enforce.

Conditions inspect published predecessor JSON through a path and one of `exists`, `truthy`, `equals`, or `not-equals`. Multiple incoming conditional edges are conjunctive: every condition must be active before the node runs. Graph definitions cannot contain executable JavaScript, duplicate edges, missing roles, or cycles. A terminal run-level error is part of each whole-run snapshot, so coordination and scheduler failures remain visible after replay even when no child attempt started.

Execution-policy millisecond fields cannot exceed `MAX_GRAPH_TIMER_MS` (`2_147_483_647`), the largest delay Node timers accept without clamping or rejecting. Domain validation rejects larger durable configurations before a Host constructs a timer.

Human and controller operations are versioned durable records. Each record binds a stable operation id to an exact graph, design revision, run generation, optional node attempt, authenticated actor, ingress, bounded reason, applied or no-op result, resulting generation or revision, and the node ids invalidated or reused by the change. Substitute node output is validated against the node schema and retained both in the control record and node state with its control provenance. Projection replay rejects conflicting duplicate ids, invalid provenance, and control records that address an impossible revision or future generation.

## Model Experience

### Graph revision planning

#### What the model sees

The controller sees the configured role catalog and current graph identity, then publishes a complete graph revision through the `graph_submit` schema. Worker rendering is owned by `dsh-graph-mode`.

#### Token effect

The role catalog and current graph identity are added once to each active controller request; the durable domain adds no text to worker requests by itself.

#### KV Cache effect

The stable role catalog can share a prefix across controller turns until settings change, while the current graph identity changes when a new graph or revision becomes active.

## Known Limitations and Deferred Work

- This package is the durable domain and projection, not an executor. The graph-mode controller, local scheduler, LoopX adapter, host API, and canvas UI are separate plugins so deployments can replace each role independently. Static concurrency caps reduce OOM risk but cannot guarantee memory safety without provider or operating-system resource telemetry.
