# Agent Note: Revision commit reads live checkpoint state

Status: implemented

English | [中文](2026-08-29-live-checkpoint-revision-commit.zh.md)

## Problem

Revision submission captures a projection before it cancels predecessor work, acquires scheduler ownership, and prepares external coordination. An operator can resolve a pending checkpoint while those asynchronous steps are in progress. Resolving checkpoints from the captured projection would then append a second terminal record for the same checkpoint, making the append-only Graph log impossible to replay.

Task-modification checkpoints also require a replacement revision because resuming the old generation would execute the objective the operator asked to replace. A generic checkpoint approval path could violate that rule and create the overlapping terminal write.

## Decision

Revision activation reads checkpoints from the live Graph projection immediately before its synchronous commit and resolves only records that remain pending. There is no asynchronous yield between that read and the terminal appends, so an operator action cannot interleave with the commit.

Graph control rejects direct approval of a task-modification checkpoint. The Web execution view omits that approval action while retaining the checkpoint reason and rejection control. The controller-authored replacement revision is the only operation that resolves the modification checkpoint.

The Graph reducer continues to reject every second terminal checkpoint record. Recovery does not normalize or conceal duplicate terminal events because they prove a producer violated the append-only lifecycle.

## Alternatives considered

- **Accept identical or enriched terminal records in the reducer** — rejected because it would hide competing writers and weaken checkpoint evidence from exactly one decision to last-writer-wins state.
- **Serialize the full revision preparation with every operator control** — rejected because scheduler acquisition and coordination preparation may be slow; holding the control queue across those external operations would delay cancellation and other human intervention.
- **Use only the early submission projection** — rejected because it is intentionally stable for draft validation but cannot authorize terminal writes after asynchronous external work.

## Consequences

- Slow scheduler or coordination preparation cannot cause a checkpoint that was resolved concurrently to receive another terminal event.
- Task changes always proceed through immutable revision history instead of resuming obsolete work.
- The commit-time projection read is a required concurrency invariant and is covered by a delayed coordination-preparation regression test.
- Existing logs that already contain a duplicate terminal event still require an explicit, backed-up data repair; runtime replay remains fail-closed.
