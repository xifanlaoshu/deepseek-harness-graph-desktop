# `@deepseek-ai/dsh-client-ui-graph`

English | [中文](README.zh.md)

The Graph workspace has Design, Execution, and Revisions as three primary tabs. Revisions renders logical tasks as vertical lanes and their immutable revisions from left to right. Typed curved links distinguish planning refactors, execution corrections, historical parents, and cross-Batch dependencies. Search covers task text, roles, actual model routes, and error codes; type and Run-state filters plus bounded expansion keep long histories navigable. A delayed hover preview gives the objective and trigger, while selection opens a persistent drawer with creation reason, graph difference, runtime metrics, relationships, safe event references, and direct navigation to the selected Design or Execution view. Historical submissions without lineage remain visible as unclassified, and unavailable child telemetry is never displayed as zero.

The browser half registers a session-header action that renders only while the session's `graph` projection is active. Design contains only the controller-authored immutable graph. Execution places the selected run graph on the left and a scrollable node summary list on the right; selecting a graph node or summary opens the complete evidence and control dialog. DOM controls and every Cytoscape canvas share one cross-platform reading font stack with restrained 400/500 weights, while structured JSON, checkpoints, and identifiers use a Cascadia Mono/Consolas-style stack without ligatures. Cytoscape renders the active read-only directed canvas with smooth dependency curves, medium-weight node labels, explicit fit and zoom controls, arrow-key node navigation, and an overview for large graphs. Run evidence and node selection preserve the active viewport; the canvas lays out and fits again only when the selected immutable revision changes or the user requests fit-to-view. The node dialog shows the enforced output schema, conditional members and branch decisions, expansion or subgraph definition, execution provenance, checkpoints, per-node timing, effective role/model/worker routing, attempts, outputs, artifacts, operation journal, settlements, terminal rule, LoopX claim ids, and child-session links. Its title bar exposes the authoritative full-child-session action for the latest attempt so the complete messages and tool events are immediately reachable; continuation-session actions remain attached to their originating attempts.

When the projection contains a Campaign, the panel places an ordered horizontal Batch track above the canvas. The heading shows the durable plan revision. Each card shows the plan revision that introduced it, objective, durable status, latest Revision, and Settlement count; its tooltip includes any extension reason and source Batch, Run, and Settlement count. Selecting a completed card opens that Batch's independent historical Graph; it does not merge the Batch nodes into the current Graph or change the durable current graph identity. A planned Batch remains disabled until the controller creates its graph.

The active-run bar exposes pause and cancellation only for applicable phases, and exposes reconciliation for `awaiting_user` external outcomes. Checkpoints expose structured approval and rejection, but a task-modification checkpoint omits approval because only its replacement revision may resolve it. Node controls expose a written task-modification request, cancellation, retry, resume, skip, assignment override, and schema-valid substitute output according to the selected node state. A task modification becomes a durable checkpoint and returns to the controller for a new immutable revision instead of editing execution history. Every browser request includes the projected graph revision, run generation, and latest attempt identity; stale tabs cannot affect newer work. The panel waits for the Host command result and renders the durable operation timeline with actor, source, expected and resulting generation, outcome, and completion time.

Primary and continuation child sessions created by a Graph attempt receive a compact Graph-node action. It resolves the child against the parent projection, shows the effective role, model, reasoning selector, node phase, and attempt number, links back to the parent graph, and can cancel a running node through the parent command channel with the exact revision, generation, and attempt identity. An unrelated subagent session receives no Graph action.

The header settings action opens an editor for the durable Graph Mode configuration through `/graph config <JSON>`. Each role selects a provider/model pair from the shared settings-backed model directory or inherits the session route; reasoning effort remains a free-form input because providers accept different values. The editor also exposes the total active-subagent ceiling, global worker ceiling, controller reserve, role ceiling, prompt, exact-model ceiling, ordered controller fallback routes, eligible failure codes, the per-turn fallback limit, and Graph-specific compaction threshold, retention, output-token, and reasoning settings. Every fallback route can independently serve controller recovery, compaction, or both. A visible footer keeps the save action outside the scrolling role list. While the editor is open, unrelated run projections cannot replace its working draft. The host validates the whole replacement before appending it, and command rejection remains visible without discarding the draft; the browser keeps no authoritative graph state.

The Plugins settings page also registers a Graph role-template tab independent of the active session. It reads the session-independent model directory and exposes the same concurrency, controller fallback, and compaction settings as the session editor, validates the complete template, rejects millisecond policy values above the Node timer limit `2_147_483_647`, and saves through the revision-fenced `graph-mode` settings namespace. Concurrent edits retain the local draft and require an explicit reload. A session copies the template only on its first Graph activation, so later global edits cannot change an existing session's role prompts, model route, limits, compaction, replay, or recovery.

## Model Experience

### Graph panel and settings

#### What the model sees

The browser plugin contributes no prompt or tool text. Settings affect later requests only after the host validates and logs the `/graph config <JSON>` replacement.

#### Token effect

The panel adds no tokens by itself; the configured role prompts and selections are rendered by `dsh-graph-mode`.

#### KV Cache effect

The browser adds no cache content. Changing a role prompt invalidates that role's previously reusable prompt prefix on later child requests.

## Known Limitations and Deferred Work

- Design and Execution mount separate Cytoscape instances only while their tab is active. Their topology and fit behavior match, but viewport pan and zoom are not preserved across a tab switch.
- Both the session editor and the Plugins settings Graph-template editor support role creation, duplication, ordering, editing, enablement, disablement, deletion, model routing, reasoning selectors, and concurrency limits. The global editor restores the built-in software-engineering team only after an explicit second confirmation.
- Model-limit editing creates exact provider/model limits. Weighted memory limits remain available in the JSON configuration but are not yet shown in the panel.
