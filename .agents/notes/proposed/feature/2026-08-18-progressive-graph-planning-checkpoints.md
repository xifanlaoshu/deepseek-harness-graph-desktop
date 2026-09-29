# Agent Note: Progressive graph planning checkpoints

Status: proposed

English | [中文](2026-08-18-progressive-graph-planning-checkpoints.zh.md)

## Problem

The Graph controller currently submits a complete execution DAG from the user's request and a static role summary. It cannot plan from the analysis, architecture, and repository-scaffold evidence that its own workers later discover, and it does not receive the workers' resolved model capacities or observed execution limits. A broad implementation node can therefore combine unrelated subsystems, exhaust one model response, and consume every retry without producing artifacts.

Routing an architecture node back to a controller node would make the persisted task graph cyclic and would treat the controller as ordinary delegated work. Requiring users to recognize and split oversized nodes would also move an orchestration responsibility out of Graph Mode.

## Proposal

Graph Mode will support progressive planning through durable planning checkpoints. The controller remains outside the task DAG as the session's control plane. A checkpoint returns control to that controller without adding a reverse edge or executable predicate to an immutable graph revision.

For work whose implementation depends on repository facts, the controller will first submit a discovery revision containing only the necessary analysis, repository/scaffold inspection, and architecture nodes. The revision will declare an expansion checkpoint after those nodes. The scheduler will stop admitting undiscovered execution work when the checkpoint becomes eligible, persist the paused run and checkpoint evidence, and wake the controller through a model-visible logged message.

The checkpoint planning context will contain bounded structured node outputs and artifact references, the repository/scaffold summary, the session-owned role selections, exact provider/model scheduler limits, and model metadata resolved by the LLM service, including known context windows, output limits, and reasoning selectors. Unknown capabilities will remain explicit rather than receiving invented values. Deployment-varying node-size and planning limits will be validated Graph settings, not plugin constants.

The controller will use that evidence to submit the next immutable revision. Completed discovery nodes will be reused with source-run references unless their inputs changed; the revision will expand the implementation, integration, review, verification, and documentation nodes at a granularity compatible with the assigned models and file ownership. The normal revision invalidation rules will rerun every affected successor while retaining older revisions and runs for inspection.

Graph submission will include a planning validation pass before the revision is logged. It will reject conflicting writable-path ownership, missing verification, execution nodes that combine independently verifiable subsystems beyond the configured policy, and model assignments that exceed declared capacity. The rejection will return structured findings to the controller so it can resubmit without asking the user to decompose the work.

Checkpoint modes will distinguish initial expansion, repair after structured review or verification rejection, and replanning after a runtime limit. A `max-tokens` result with useful artifacts may continue the same worker conversation within a bounded continuation policy; a reasoning-only or repeatedly unproductive attempt will return to the controller for node splitting instead of starting the same one-shot task again. Provider or process failures retain a separate bounded retry policy.

Review and verification branches will publish machine-readable decisions and issue ownership. A rejection will pause affected work and let the controller create a new revision with targeted repair nodes; the graph itself remains acyclic, and the revised nodes' transitive successors execute again under the existing invalidation rules.

Checkpoint payloads will carry concise outputs and artifact references rather than complete child transcripts. Child sessions remain authoritative for detailed messages and tool activity, while LoopX receives only its existing bounded coordination observations and settlement evidence. No todo will be created for work that the controller has not expanded into an executable revision.

The Graph UI will show checkpoint state, the controller's expansion or repair revision, reused discovery evidence, and the planning reason that caused a pause. The separate design and execution presentation is owned by the [dual graph views decision](../../implemented/feature/2026-08-18-dual-graph-design-and-execution-views.md); this proposal supplies the revisions and checkpoint evidence that presentation consumes.

Role and planning settings will be snapshotted into the session-owned Graph configuration. Changes to global role templates or model directories will affect later sessions or an explicit session update, never silently reinterpret an existing graph's planning evidence.

## Alternatives considered

**Generate the complete DAG before any worker runs.** This keeps one controller turn simple, but forces implementation granularity to be guessed before analysis, architecture, and repository inspection exist.

**Represent the controller as a graph node with a reverse edge.** This makes replanning visible as ordinary work but introduces cycles, mixes control authority with delegated execution, and prevents immutable revisions from identifying which controller decision produced a node.

**Wake the controller after every node.** Continuous replanning observes the most current evidence, but serializes independent work, increases controller cost, and makes revision history noisy. Explicit uncertainty and decision checkpoints preserve useful parallelism.

**Rely only on a stronger controller prompt.** Prompt guidance can improve typical graphs but cannot observe missing model metadata, enforce writable-path ownership, or prevent a malformed oversized submission. The controller needs structured planning context and deterministic validation.

## Acceptance criteria

- The controller can submit a discovery-only revision with a durable expansion checkpoint after selected analysis, repository inspection, and architecture nodes.
- An eligible checkpoint pauses undiscovered execution, persists its reason and evidence, and wakes the controller without adding a graph cycle or controller task node.
- The logged planning context contains bounded predecessor results, artifact references, repository/scaffold evidence, session role selections, scheduler limits, and every model capability the LLM service can resolve; unknown values remain unknown.
- The controller can expand the same graph through a new immutable revision that reuses unchanged discovery nodes with source-run references and creates model-appropriate execution nodes.
- Submission validation returns structured controller-visible findings for configured node-size violations, writable-path conflicts, missing verification, and incompatible model assignments before logging the revision.
- Review or verification rejection creates a controller checkpoint whose replacement revision reruns each changed node and its complete transitive successor closure.
- Runtime-limit handling distinguishes same-session continuation, controller replanning, and provider retry; a `max-tokens` attempt does not blindly start the same one-shot prompt until `maxAttempts` is exhausted.
- Exact-model admission limits remain enforced across roles after expansion, so multiple roles assigned to one local model cannot exceed that model's configured concurrency.
- Restart and history replay reconstruct paused checkpoints, their planning evidence, the revisions they produced, and reused-node source references without consulting current global templates.
- The assembled Web application provides product-visible coverage for discovery, checkpoint pause, controller expansion, execution, rejection-driven repair, and inspection of the resulting design and execution revisions.

## Risks

Progressive planning creates more revisions and controller turns, so checkpoint placement must be explicit and sparse. Model metadata may be absent or inaccurate, and output size remains model-dependent even when a route advertises a capacity; conservative configurable policy and observed run evidence can inform planning without claiming deterministic token prediction. Checkpoint payloads can themselves consume context if workers publish verbose results, so schemas and size limits must keep summaries bounded and leave full evidence in child sessions. A crash while paused requires persisted checkpoint admission state to prevent duplicate controller wakeups. Reusing discovery results across revisions is safe only when direct changes and incoming dependencies remain unchanged under the existing invalidation rules.
