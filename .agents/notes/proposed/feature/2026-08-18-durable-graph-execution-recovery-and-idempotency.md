# Agent Note: Durable Graph execution recovery and idempotency

Status: proposed

English | [中文](2026-08-18-durable-graph-execution-recovery-and-idempotency.zh.md)

## Problem

Graph definitions and run snapshots survive restart, but scheduler ownership, active attempts, LoopX todo caching, admission permits, and settlement progress are process-local. A crash can therefore leave a child process, external todo, workspace mutation, or model request whose outcome is not reflected in the latest run snapshot. Restarting the same node without a stable operation identity can duplicate expensive or irreversible effects, while treating every uncertain operation as complete can omit required work.

## Proposal

Graph will distinguish a stable logical work identity from physical attempts. `GraphWorkId` is the branded canonical tuple of `sessionId`, `graphId`, `revision`, and `nodeId`. `GraphRunGenerationId`, `GraphAttemptId`, `GraphControlOperationId`, and `GraphSettlementId` identify repeated execution, one worker attempt, one user or controller operation, and one external terminal write respectively. Wire and durable records carry the tuple fields as well as opaque ids so diagnostics remain precise without parsing ids.

Each run owns an append-only operation journal. A node advances through `planned`, `admitted`, `claimed`, `started`, zero or more `progress` observations, `output-staged`, `settlement-pending`, reconciliation decisions, and one terminal outcome. Every transition records its expected predecessor, event id, time, owner epoch, and relevant external references. The projection rejects an impossible predecessor or a second conflicting terminal result. Whole-run snapshots remain a convenient projection but no longer serve as the only recovery evidence.

## Recovery and reconciliation

At Host startup, a recovery coordinator folds each nonterminal Graph ledger, acquires a durable run-owner lease with a monotonically increasing fencing epoch, and reconstructs scheduler eligibility. A stale process may finish an OS operation, but its epoch cannot append a current transition, renew a lease, or settle external work. Heartbeat loss separately aborts execution and revokes durable write authority, so it does not create a canceled terminal snapshot or cleanup settlement after ownership is uncertain. The run remains nonterminal until a higher fenced generation reconciles it. Projection validation rejects lower or skipped generations, same-epoch takeovers, stale generation ids, and same-generation replacement after an accepted terminal outcome. The coordinator reconciles every operation that reached `claimed`, `started`, `output-staged`, or `settlement-pending` before admitting new work.

Reconciliation asks the owning provider for an exact external reference. It records `confirmed-running`, `confirmed-terminal`, `absent`, `conflict`, or `unknown`. Confirmed output is validated and resumed from settlement; absent idempotent work may be restarted under the same `GraphWorkId` with a new attempt; a conflict or unknown non-idempotent effect enters `awaiting_user`. Recovery never assumes success from a missing local process and never assumes failure solely from a missing heartbeat.

The scheduler cursor, checkpoint wakeup marker, human interaction request, admission reservation, worker lease, model-resource reservation, artifact manifest, and external coordination references are durable or reconstructible from journaled facts. A wakeup or control request has a stable operation id and an accepted marker so restart cannot enqueue it twice.

## Idempotent effects and settlements

Graph promises at-most-one accepted terminal result, not exactly-once execution of arbitrary tools. Providers and tool calls that support idempotency receive `GraphWorkId` plus an effect key derived from the node-declared operation name. Repeated calls with the same key must return the original result or a typed conflict. Non-idempotent effects must be declared, isolated behind an approval policy, and expose either reconciliation or compensation; otherwise they cannot be automatically replayed after uncertainty.

Node outputs are staged with content hashes and artifact references before external settlement. An append-only settlement log records every LoopX completion, blocker, cancellation, resource release, artifact publication, and compensation attempt with request, response, error, time, and fencing epoch. Each stable `GraphSettlementId` contains numbered `pending` plus terminal attempt pairs: `failed` or `conflict` permits the next attempt, while `confirmed` seals the id. The node reaches its terminal state only after required settlements are confirmed or recorded as a terminal `settlement-failed` outcome. Retrying settlement never reruns the worker.

External references include provider kind, endpoint identity, goal, todo, claim, lease and fencing token, remote worker, workspace allocation, model reservation, child session, artifact manifest, and provider-specific opaque data. Sensitive credentials and private observations never enter these records.

## Orphan cleanup

Graph-created external work carries `GraphWorkId`, owner epoch, and creation event id. Reconciliation may cancel or settle only records bearing those tags. An orphan scanner compares tagged LoopX todos, worker leases, model reservations, and workspace allocations with live or terminal Graph operations. It releases confirmed terminal leftovers, marks uncertain records quarantined, and appends every cleanup decision. It never deletes an untagged todo or workspace and never converts external absence into Graph success.

Retention is policy-driven. Terminal settlement records and artifact manifests follow the session's retention. Ephemeral leases and isolated workspaces may be reclaimed after their terminal settlement and configured grace period. A failed cleanup remains visible and retryable without reopening the node.

## Alternatives considered

**Resume from the latest whole-run snapshot.** A snapshot can say that a node was running but cannot identify which external effects were accepted between the snapshot and the crash. Transition and settlement records provide the necessary recovery points.

**Restart every nonterminal node.** This is safe only for proven idempotent work and can duplicate deployments, messages, filesystem mutations, or paid model calls.

**Mark every interrupted node failed.** This avoids duplicate execution but loses confirmed remote work and forces users to reconstruct which results remain usable.

**Use process ids or child session ids as stable identities.** They identify one physical attempt, not the logical node across restart, retry, remote reassignment, or settlement-only recovery.

## Acceptance criteria

- Stable work, run-generation, attempt, control-operation, and settlement ids survive replay and are used by every local, remote, LoopX, artifact, and UI operation.
- Crash tests at every journal transition recover without accepting two terminal results, duplicating an idempotent effect, or silently completing an unknown non-idempotent effect.
- Startup reconciliation handles running, terminal, absent, conflicting, and unreachable providers and records the decision before new dependent work starts.
- Output staging and settlement retry can complete after restart without rerunning the worker; every settlement attempt remains inspectable.
- A resource-settlement failure closes the physical attempt without admitting another worker attempt under terminal logical work; assembled Loader coverage exercises the configured optional resource Provider.
- Orphan cleanup touches only Graph-tagged external work, applies retention and quarantine policy, and records failures without reopening completed nodes.
- Replay and export reconstruct nonterminal ownership, external references, settlements, uncertain outcomes, and recovery decisions without process-local caches or current global settings.

## Risks

The journal increases event volume and schema complexity, and provider reconciliation quality limits how much uncertainty can be resolved automatically. Fencing prevents stale acceptance but cannot stop an already issued external side effect. Idempotency keys are only as strong as the receiving system, so Graph must preserve `unknown` and require human adjudication instead of overstating exactly-once guarantees. Cleanup policies can destroy useful forensic state if grace periods or ownership tags are wrong; quarantine and fail-closed ownership are required.
