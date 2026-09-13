# Agent Note: LoopX distributed coordination protocol

Status: proposed

English | [中文](2026-08-18-loopx-distributed-coordination-protocol.zh.md)

The provider-neutral Service Definition and LoopX CLI Provider implement all eight operations. A shared suite exercises their complete lifecycle, repeated delivery, stale fencing, ordered cancellation observation, and reconciliation. The LoopX Provider retains settlement identity in terminal todo evidence and stores claims, lease renewals, progress, cancellation, settlements, cursors, and progress deduplication in a validated SQLite projection. Restart tests reconstruct the ordered suffix and use stable LoopX tags to recover the latest external mutation when the process stops before projection writeback. A bounded runtime window reports a compacted prefix without dropping audit events, and `watch` retries transport failures under explicit attempt and delay limits. Deterministic write-loss injection covers renewed-lease and terminal-settlement crash windows. Remaining target work is real LoopX executable process-loss evidence and a transport-independent authenticated distributed Provider whose cursor store does not depend on a shared filesystem.

## Problem

A coordination interface limited to `prepare`, `claim`, and `settle` cannot renew ownership, publish ordered progress, observe another process, cancel a claim, recover an expired worker, or reconcile Graph and LoopX after either side restarts. Extending those calls independently would make lease, retry, and terminal semantics Provider-specific and leave Graph unable to determine whether a remote Worker still owns a node.

## Proposal

`dsh-graph-coordination` will define a versioned capability seam whose Service Definition is independent of the LoopX CLI transport. LoopX implements the first distributed provider; an in-memory conformance provider pins semantics without an external installation. The consumer remains Graph Mode and uses only the following operations:

| Operation | Required behavior |
| --- | --- |
| `prepare` | Validate goal, peer mappings, protocol version, policy, and revision metadata before execution. |
| `claim` | Atomically acquire or recover one `GraphWorkId`; return todo, claim, lease, expiry, and monotonically increasing fencing token. |
| `heartbeat` | Renew the exact live lease and report progress cursor; reject an expired or fenced owner. |
| `observe` / `watch` | Read a consistent snapshot or ordered changes after a durable cursor without taking ownership. |
| `publishProgress` | Append bounded public-safe progress with a per-work sequence; duplicate sequence numbers are idempotent and conflicting payloads fail. |
| `settle` | Append one terminal success, failure, blocker, skipped, canceled, exhausted, or uncertain result under a stable settlement id. |
| `cancel` | Request cooperative cancellation of a live lease and retain who requested it and why. |
| `reconcile` | Compare an exact Graph operation with LoopX references and return confirmed, absent, conflict, or unknown evidence. |

All operations carry protocol version, `GraphWorkId`, Graph owner epoch, caller identity, stable operation id, and cancellation signal. Responses contain typed status and public-safe bounded evidence; they never expose credentials, hidden model reasoning, or unrestricted filesystem paths.

## Lease and recovery semantics

A claim is an expiring lease, not permanent ownership. Its fencing token must increase whenever ownership transfers and may advance during a same-owner renewal when the Provider uses a lease CAS version as its fenced identity. Every heartbeat returns the current lease id and token; the Consumer persists that identity and replaces the prior one before its next progress, cancellation, reconciliation, or settlement write. Reconciliation treats a higher token for the same claim as forward progress; a replaced claim, lower token, or same-token lease mismatch is a conflict. Only the current token may write. A late worker can finish local computation, but LoopX rejects its writes and Graph records the fenced result as non-authoritative evidence.

Heartbeat cadence and lease duration are deployment settings with validated minimums and a grace policy. Missing one heartbeat does not immediately fail work. Once expiry is confirmed, reconciliation checks the provider and worker before Graph either recovers the claim under a new token, enters `awaiting_user` for a non-idempotent operation, or records terminal failure. After the Worker is confirmed stopped, Graph reacquires an expired matching claim, settles its original Activation as canceled, and retries an idempotent node in a new Generation. A recovery-created `awaiting_user` Generation with no execution identity of its own is rechecked automatically against the original Generation, while an unresolved conflict remains stable without generating repeated recovery history. Recovery preserves the same `GraphWorkId` and uses a new `GraphAttemptId`.

`watch` is cursor-based and at-least-once. Consumers deduplicate event ids and must handle compaction by fetching a fresh snapshot. Progress sequence is monotonic within one work identity and bounded in count and bytes; detailed transcripts remain in child sessions. Backpressure may coalesce progress but may not coalesce lease, cancel, or terminal transitions.

## Ledger reconciliation

Graph and LoopX retain independent authority. Graph asks `reconcile` at startup, after transport loss, before recovering an expired claim, and when a human requests it. The provider returns the exact todo, claim, lease, terminal result, and last progress cursor it can prove. Graph compares those records with its operation journal and appends one reconciliation result.

If LoopX is terminal while Graph is nonterminal, Graph validates referenced output and continues settlement or records a conflict. If Graph is terminal while LoopX is live, Graph issues idempotent `cancel` or `settle` using the journaled outcome. If both are terminal but disagree, neither ledger is overwritten; Graph enters a visible conflict requiring policy or human adjudication. Untagged LoopX todos are outside reconciliation authority.

## Remote execution contract

The coordination protocol advertises work but does not itself run models or tools. A remote worker observes eligible claims, proves a compatible role and capability set, acquires a lease, and invokes the Graph worker protocol owned by the [worker isolation and resource design](2026-08-18-graph-worker-isolation-and-resource-scheduling.md). LoopX peers remain administrative identities; Graph role ids and model selections remain session-owned execution data.

## Alternatives considered

**Poll LoopX todos and infer ownership from status text.** Polling lacks ordered evidence and status labels cannot provide fencing, idempotency, or exact Graph identity.

**Let heartbeat quota decide Graph scheduling.** LoopX heartbeat protects distributed ownership, while Graph admission protects model, role, workspace, and dependency capacity. Combining them would make an external coordination service authoritative for local execution eligibility.

**Allow the latest terminal write to win.** A stale worker could overwrite a recovered worker or user cancellation. Fencing plus immutable first accepted terminal state prevents that race.

**Put complete child transcripts in LoopX progress.** This duplicates private and potentially large session evidence. Progress is bounded coordination data; child sessions remain the detailed source.

## Acceptance criteria

- The Service Definition, LoopX provider, and Graph consumer implement all eight operations and pass a shared protocol conformance suite.
- Claims use expiring leases and monotonic fencing tokens; stale heartbeat, progress, and settlement writes are rejected and recorded without changing the accepted Graph outcome.
- Worker loss, Host loss, LoopX loss, lease expiry, duplicate delivery, cursor compaction, and reconnect are covered by deterministic recovery tests.
- Startup and on-demand reconciliation cover Graph-only, LoopX-only, matching, conflicting, unreachable, and untagged records without silent adoption or overwrite.
- Progress is ordered, bounded, public-safe, and independently inspectable from terminal settlement and child transcripts.
- Cancellation and terminal settlement are idempotent under stable operation ids and survive retries across process restart.

## Risks

Lease correctness depends on bounded clock skew or server-issued expiry, and transport outages can force work into an uncertain state even when a worker is healthy. LoopX protocol evolution creates compatibility obligations between independently deployed processes. At-least-once observation increases deduplication and storage work. Fencing controls authoritative writes but cannot revoke credentials or undo external effects already issued by a stale worker.
