# Agent Note: Scheduler heartbeat recovery preserves node attempt budgets

Status: implemented

English | [中文](2026-08-28-graph-scheduler-heartbeat-recovery.zh.md)

## Problem

A temporary scheduler heartbeat failure immediately revoked run authority even while the lease still had time to renew. Recovery then counted every recorded attempt, including an unfinished attempt canceled by the parent scheduler, before reconciling its Worker and coordination references. Repeated Host-level interruptions could therefore exhaust a node budget without a completed Worker outcome and leave `awaiting_user` without a durable checkpoint.

## Decision

Graph Mode retries heartbeat failures while the current lease remains live. `GraphSchedulerAuthorityError` identifies an already fenced or expired lease and revokes write authority immediately; an elapsed lease does the same after transient retries fail.

Recovery reconciles external references before evaluating the node budget. Attempts with `finishedAt` consume the budget; unfinished attempts remain in their superseded Generation audit but are removed from the recovered Generation's active attempt list. Unsafe and genuinely exhausted nodes receive a durable `awaiting_user` checkpoint with the recovery decision. The Web execution view exposes node retry for that state and omits approval when the recovery checkpoint cannot safely resume unchanged work.

SQLite Scheduler defaults give a run a 120-second lease and wait up to 30 seconds for transaction contention. The heartbeat interval remains independently configurable by Graph Mode.

## Alternatives considered

- **Fail on the first heartbeat exception** — rejected because temporary SQLite contention, a long JavaScript pause, or a transport interruption does not itself prove another owner has fenced the lease.
- **Count every started attempt** — rejected because parent cancellation caused by Host authority loss is not a settled Worker outcome and repeated infrastructure recovery would consume task policy.
- **Reset all attempts during recovery** — rejected because completed failures are task evidence and must continue to enforce the immutable node limit.
- **Redispatch every uncertain effect automatically** — rejected because manual and unreconciled effects can duplicate external changes; they require a checkpoint and an explicit operator decision.

## Consequences

- Transient heartbeat failures have several bounded renewal opportunities before takeover becomes possible.
- Fenced owners still stop durable writes immediately.
- Recovered idempotent work does not lose task attempts solely because the parent scheduler interrupted it.
- Recovery decisions are visible and actionable through durable operation and checkpoint evidence.
- The exact heartbeat exception survives only an in-process recovery; after Host restart, recovery reports durable lease and external reconciliation evidence because no fenced Session writer may append the failed heartbeat.
