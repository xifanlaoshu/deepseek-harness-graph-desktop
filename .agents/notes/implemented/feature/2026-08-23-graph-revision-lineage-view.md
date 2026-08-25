# Agent Note: Graph revision lineage view

Status: implemented

English | [中文](2026-08-23-graph-revision-lineage-view.zh.md)

## Problem

The revision selector identified immutable revisions by number but did not explain their concrete objective, creation trigger, relationship to failed or superseded work, or execution cost. A user could not distinguish a new task from controller replanning or corrective work without reading the parent and child session logs. Rendering this history inside the Design DAG would conflate task topology, design evolution, and runtime evidence.

## Decision

This view extends the [Design and Execution views](2026-08-18-dual-graph-design-and-execution-views.md), [human control and revision recovery](../../proposed/feature/2026-08-18-human-graph-control-and-revision-recovery.md), and [progressive planning checkpoints](../../proposed/feature/2026-08-18-progressive-graph-planning-checkpoints.md). Those notes remain active because they own task-topology presentation, mutation semantics, and planning barriers respectively.

The Graph workspace has three primary views. Design shows one immutable task graph, Execution shows one run and its node evidence, and Revisions shows logical tasks, immutable revisions, their typed relationships, and derived runtime measurements. Revisions uses a separate read-only Cytoscape canvas because its nodes are revisions rather than executable tasks.

Every newly accepted `graph/submission` may carry versioned `GraphRevisionLineage`. The Host produces the authoritative record from the controller decision and accepted session state. The record contains a branded logical-task id, one classification, title, objective, reason, creator, trigger evidence, success criteria, relationships, and added, changed, removed, preserved, and invalidated node ids. Runtime time, status, child sessions, attempts, tokens, tool calls, retries, and human controls never come from model output.

The classifications are `new_task`, `analysis_refactor`, and `execution_correction`. A new Graph is a new logical-task lane. A revision remains in its Graph lane and records `refactors` or `corrects` against its immutable parent. Campaign Batch dependencies become `depends_on` relationships between separate task lanes. The Host rejects a new submission classified as a refactor or correction, a revision classified as a new task, unknown trigger references, mismatched structural changes, duplicate node ids, invalid text, or a missing parent relationship.

The lineage field is optional on replay because sessions created before this feature have no trustworthy classification evidence. The Revisions view labels those records as historical and unclassified instead of inferring provenance. This is a deliberate data-integrity rule, not a compatibility default for newly created submissions.

## Projection and metrics

The browser deterministically joins Graph revisions, submission lineage, Runs, node attempts, checkpoints, controls, and Settlements. Start time comes from the first attempt when available and otherwise from a non-queued Run. End time requires every recorded Run to be terminal. Duration is end minus start. Subagents count distinct primary and continuation child-session ids. Task interactions count attempts. Token and tool totals come from attempt health. Retries count attempts beyond the first for each node execution. Human interactions count user-facing controls and awaiting-user checkpoints.

Unavailable telemetry stays unavailable. Agent turns are not stored in the parent Graph projection, so the drawer renders that metric as unavailable instead of zero. Complete messages and tool events remain authoritative in child sessions; the drawer exposes safe submission, Run, control, and Settlement references rather than copying transcripts.

## Presentation and navigation

Logical tasks form vertical lanes ordered by creation time, while revisions advance horizontally. Curved labeled edges distinguish corrections, refactors, historical ancestry, and cross-task dependencies with line patterns in addition to color. Node selection opens a persistent drawer with objective, creation reason, trigger evidence, graph difference, Runs, resources, relationships, and raw event references. Relationship buttons navigate in both directions, including from a failed revision to a correcting revision and back. The drawer can open the selected immutable revision in Design or Execution.

Pointer hover waits 360 milliseconds before showing a concise preview. An equivalent ordered button list supports keyboard and assistive navigation. Search covers task text, role ids, actual model routes, and error codes. Type and Run-state filters narrow the view. Histories over forty visible revisions retain the first, current, and newest twenty revisions until the user expands the complete history. Cytoscape preserves its viewport across Run-only projection refreshes because the instance is recreated only when lineage topology or filters change.

## Verification

Domain tests cover typed lineage validation, historical records without lineage, provisional submission identity, and duplicate settlement behavior. Controller tests prove Host-derived new and refactor metadata, structural change derivation, immutable parent relationships, and accepted replay. Client tests cover the third tab, runtime aggregation, unavailable telemetry, relationship evidence, navigation back to Design, long-lived canvas behavior, and existing Design and Execution controls. The assembled Graph snapshot covers the model-visible `graph_submit` schema and controller flow.

## Alternatives considered

**Keep only the revision selector.** A selector changes the selected revision but cannot explain causality, separate logical tasks, correction chains, or resource use.

**Use a flat timeline.** Chronological order cannot represent corrective ancestry and cross-task dependencies clearly.

**Decorate the Design DAG.** Task nodes and revision nodes have different identities and evidence. Combining them would make both views ambiguous.

**Persist browser positions or aggregates.** Layout is presentation state, while measurements must replay from authoritative events. Persisting either would create a competing source of truth.

## Consequences

New sessions have durable, validated revision explanations and navigable correction history. Historical sessions remain inspectable without fabricated semantics. The UI can aggregate the telemetry already copied into Graph attempts, but exact child turn counts remain unavailable until a future parent-safe telemetry event records them. Search and bounded expansion keep large histories usable without introducing a second persistence format or a second graph renderer.
