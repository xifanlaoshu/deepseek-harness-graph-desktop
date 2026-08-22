# Agent Note: Human Graph control and revision recovery

Status: proposed

English | [中文](2026-08-18-human-graph-control-and-revision-recovery.zh.md)

The current Host control service serializes operations per session, rejects stale graph/revision/generation/attempt addresses and conflicting operation-id reuse, and logs actor, source, reason, applied/no-op result, and resulting revision or generation. It supports pause with draining, a durable node-specific modification request that returns to the controller for a new immutable revision, checkpoint approval/rejection, cancel, retry, resume, skip, assignment override, schema-valid substitute output with provenance, monotonic rollback, and a recovery-reconciliation request. Remaining work in this proposal is richer rejection-branch interaction, authorization policy beyond Host-authenticated ingress, and crash injection during every control settlement.

## Problem

Graph Mode can accept new requirements and controller-authored revisions, while the cancellation proposal adds stop operations. It has no durable `awaiting_user` state, approval record, exact-node resume, manual skip or retry, forced role or model override, or rollback semantics. Sending free-form text to the controller for each action makes the result model-dependent and lets a stale browser accidentally target newer work.

## Proposal

Graph Mode will expose one Host-owned control service used by the Graph panel, child-session header, command path, controller tool, and interaction UI. Every operation carries a stable control id, expected projection revision, actor, source, parent session, graph, design revision, run generation, and exact target. Node-level operations also address `GraphWorkId` and the observed attempt or terminal state. Stale, duplicate, unauthorized, and already-terminal requests return typed results without affecting newer work.

The service supports the following actions:

| Action | Durable result |
| --- | --- |
| `pause` | Stops new admission and lets policy decide whether active attempts drain or cancel; run becomes `awaiting_user`. |
| `approve` | Satisfies the exact pending approval and resumes eligible work. |
| `reject` | Records structured reason and either terminates, activates a declared rejection branch, or creates a repair checkpoint. |
| `modify-task` | Produces a controller-visible change request and requires a new immutable graph revision before execution. |
| `resume-from-node` | Starts a new run generation, reuses unaffected evidence, and invalidates the target plus complete successor closure. |
| `retry-node` | Starts a new run generation for the same design after policy checks; it never rewrites the old attempt. |
| `skip-node` | Records an explicit skipped outcome and applies declared dependency rules; it never fabricates successful output. |
| `override-assignment` | Stores an exact role, provider, model, reasoning, worker, or resource override for the new run generation after validation. |
| `rollback-revision` | Clones a selected historical design as a new head revision linked to both the current head and rollback source. |
| `cancel-node` / `cancel-run` | Uses the semantics from [user-operated cancellation](2026-08-18-user-operated-graph-cancellation.md). |
| `reconcile` | Runs exact Graph/LoopX/worker reconciliation and records the evidence without otherwise changing design. |

## Awaiting-user and approval semantics

A node, branch, policy limit, uncertain side effect, resource conflict, or controller may emit a typed interaction request through the existing interaction capability. The Graph record contains prompt, decision schema, choices, safe evidence references, default absence behavior, optional deadline, and exact continuation token. The run phase becomes `awaiting_user`; independent work may continue only when the request explicitly permits it.

Approval and rejection are structured decisions, not positive or negative sentiment extracted from prose. The Host validates the response schema and expected control revision before appending it. A deadline may fail, cancel, choose a predeclared default, or remain paused; it may never invent user approval. Non-idempotent external effects require approval unless deployment policy explicitly pre-authorizes the declared effect class.

## Resume, retry, skip, and rollback

Execution history is immutable. Resume and retry create a new `GraphRunGenerationId` with provenance to the source run and a durable reuse map. `resume-from-node` invalidates the addressed node and its transitive successors; predecessors and independent successful nodes may be reused only under normal input and schema compatibility checks. `retry-node` is rejected if its output has already been consumed by a terminal external effect that lacks reconciliation or compensation.

Skipping is permitted only when the node policy declares `skippable` and defines how each successor handles missing output. Required successors become canceled or blocked; conditional successors evaluate as inactive; independent branches continue. A user may provide a schema-valid substitute output only through a distinct `supply-output` approval action whose provenance remains visible.

Rollback never moves the current pointer backward or deletes later evidence. The Host creates a new revision whose content derives from the selected historical revision, records the rollback source and current-head parent, validates current roles and schemas from the session snapshot, and starts a new run only after confirmation. This preserves a linear head history while retaining the abandoned branch for inspection.

Assignment override is execution data, not a mutation of global templates. The UI previews model capability, concurrency, workspace, cost, and invalidation consequences. An override cannot exceed hard scheduler policy or select an unavailable role, model, worker, or reasoning value. A historical run always displays the effective assignment it actually used.

## Product control plane

The Graph panel will include an active-run control bar, pending-interaction queue, confirmation and impact preview, and an operation timeline. The node evidence drawer exposes only actions valid for the selected state. Child-session pages may cancel, pause, or open the exact parent operation but cannot mutate an unrelated run. Keyboard and screen-reader behavior follows the same enabled-state and confirmation rules.

Every completed control shows actor, time, source, target, expected and accepted revision, resulting phases, invalidation closure, reuse decisions, assignment change, external settlements, and errors. The UI waits for authoritative projected state and does not present optimistic success.

## Alternatives considered

**Send all controls as ordinary conversation text.** The controller remains useful for interpreting a requirement change, but exact execution operations require stale-state checks, authorization, and deterministic consequences that prompts cannot guarantee.

**Mutate the selected historical run in place.** This would erase which evidence the user saw and make replay unable to distinguish original execution from manual intervention.

**Treat skip as success.** Downstream nodes could consume missing or fabricated data. Skip is a distinct outcome with explicit successor policy.

**Move the head pointer backward for rollback.** Later revisions and runs would become detached from the current history. Cloning into a new revision preserves both provenance and a monotonic head.

## Acceptance criteria

- All actions use one precisely addressed, revision-checked, idempotent Host control service and retain actor, source, target, reason, impact, and result in replay and export.
- `awaiting_user` survives restart, never defaults to approval without an explicit policy, and resumes exactly once after a valid response.
- Approval, rejection, modification, resume, retry, skip, output supply, assignment override, rollback, cancellation, and reconciliation have deterministic domain and assembled-browser coverage.
- Resume and retry create a new run generation, apply the exact invalidation closure, and preserve reusable evidence with provenance; historical runs remain unchanged.
- Rollback creates a validated new head revision and never deletes or rewrites the selected source or later history.
- Overrides remain session- and run-owned, respect hard limits, and display the effective role, model, reasoning, worker, and resource decision in execution evidence.
- Conflicting browser tabs, stale child pages, duplicate clicks, restart during control settlement, and completion/control races preserve one accepted outcome.

## Risks

Powerful operator actions can bypass automated review or create an invalid project state if their preconditions are weak. Impact previews may become expensive on large graphs, and rollback across changed external systems cannot undo side effects. Durable approvals contain potentially sensitive explanations and require bounded public-safe fields plus actor authorization. A large action vocabulary also increases UI complexity; state-dependent availability and one Host service prevent presentation code from inventing semantics.
