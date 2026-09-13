# `@deepseek-ai/dsh-graph`

English | [中文](README.zh.md)

New `graph/submission` records carry Host-resolved `GraphRevisionLineage`. Its branded logical-task id, `new_task`, `analysis_refactor`, or `execution_correction` classification, trigger evidence, typed relationships, success criteria, and structural node differences explain why the immutable Revision exists. New Graphs start separate task lanes, ordinary revisions record `refactors` or `corrects` against their parent, and Campaign dependencies record `depends_on` across lanes. Replay accepts older records without lineage and leaves their provenance explicitly unknown; it never invents historical intent.

`dsh-graph` owns the durable vocabulary and replay rules for graph-mode multi-agent orchestration. It provides editable software-engineering role defaults, immutable DAG revisions, initial run checkpoints plus incremental run updates, deterministic conditional edges, downstream invalidation, and the `graph` session projection.

`graph/submission` is the durable provisional record for one candidate Revision and queued Run. A pending submission does not change `currentGraphId`; the Consumer first establishes external run ownership, then appends the immutable Revision, Run, planned operations, and accepted submission result. A failed submission remains auditable without creating a Head Revision. Coordination uses a Generation-scoped `GraphActivationId` alongside the stable logical `GraphWorkId`.

`graph/campaign` links an ordered long-running objective to independent Batch Graphs. A Batch keeps only its own immutable Revisions and Runs; the Campaign records dependencies, approval state, compact execution summaries, and confirmed Settlement ids. Batch definitions already present in an accepted event are immutable. One plan extension may append a non-empty ordered suffix after every registered Batch is accepted; it increments `planRevision` and records the reason, added Batch ids, source Batch and Run, and confirmed Settlement ids. It cannot insert, reorder, remove, or replace the accepted prefix. An approved Batch activates the next ready Batch, whose controller submission creates another revision-one Graph instead of copying historical nodes into a larger DAG. A repair remains a Revision of the current Batch Graph, while Campaign history preserves the relationship between batches.

Host plugins validate controller output with `validateGraphRevision()` before appending `graph/change`. Every adjustment creates the next immutable revision. `downstreamInvalidation()` returns directly changed nodes and all transitive successors in topological order; a scheduler marks or cancels those nodes and executes the new revision without rewriting prior evidence. An unaffected accepted result reused by another revision or generation records its exact source run, generation, and node; stale invalidation metadata is removed instead of making reuse appear re-executed. Node attempts retain child session and LoopX claim identifiers, while detailed messages and tool events stay in the child session log.

The default team contains one controller plus analyst, architect, environment operator, engineer, reviewer, verifier, browser tester, and writer roles. Every role's provider, model, reasoning selector, prompt, and parallelism is editable. Global, model, optional weighted, and active-subagent limits are hard admission inputs; the controller reserve prevents worker saturation from starving intent classification. `maxActiveSubagents` counts each live Graph Worker and its in-process descendants in one Run. A historical session configuration without that field derives its own limit from its stored worker share instead of reading a later global template. The default engineer and browser-tester caps are one because this package does not claim workspace or browser-page isolation that their Providers cannot enforce.

`controllerResilience` stores ordered explicit fallback routes, eligible failure codes, a per-turn fallback ceiling, and Graph-owned compaction settings. The field is optional so a historical configuration retains its original routing and compaction behavior. New defaults enable the policy with no fallback routes; selecting an advanced model is an explicit deployment or user setting.

An `environment` node records a bounded host-operation plan separately from model work. Its immutable definition names the required `network`, `host-package-install`, or `docker` capabilities, the requested sandbox mode, and one to sixteen ordered operations with exact commands and optional documentary rollback commands. Environment nodes require a retained shared workspace, `manual` effect policy, one attempt, and an approval-sized plan. A resolved environment checkpoint authorizes exactly the next execution generation; replay rejects missing, stale, or reusable authorization. Operation and Settlement records retain command identity and terminal facts without storing command output in the parent session.

Conditions inspect published predecessor JSON through a path and one of `exists`, `truthy`, `equals`, or `not-equals`. Multiple incoming conditional edges are conjunctive: every condition must be active before the node runs. Graph definitions cannot contain executable JavaScript, duplicate edges, missing roles, or cycles. `graph/run` establishes a generation checkpoint; later `graph/run-update` events carry only changed node states and run-level fields. Replay validates identity, fencing, time, and terminal monotonicity before merging each update, so coordination and scheduler failures remain visible even when no child attempt started.

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
