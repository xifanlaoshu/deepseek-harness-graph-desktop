# Agent Note: SQLite-default session history and incremental Graph runs

Status: implemented

English | [中文](2026-08-27-sqlite-default-and-incremental-graph-history.zh.md)

## Problem

The shipped Web profile stored each session in a compressed JSONL artifact. Transcript pagination selected a small page only after `inspect()` had decoded and materialized the complete logical log. Graph Mode also appended a complete `graph/run` value after every node transition. A long Graph execution therefore accumulated many copies of a growing run; opening its cold history could require more memory than the compressed artifact size suggested.

## Decision

Shipped profiles use `dsh-session-persistence-sqlite` at `$DSH_HOME/sessions.sqlite` as the authoritative session event store. The provider accepts an optional legacy JSONL root. Startup imports identities absent from SQLite one physical Zstandard frame at a time, within one transaction per session. A failed import rolls back the metadata and events together; the source artifacts remain unchanged and a later startup retries them.

`SessionPersistence` supplies `readRange` for bounded sequence intervals, `findEventSequences` for newest-first type and append-surface positions, and `readEventPage` for event-domain filtering under event-count and UTF-8 JSON-byte budgets. SQLite implements the operations as physical queries and resolves packed chunk rows before logical filtering. Compressed JSONL visits frames without retaining the complete decoded log; other backends inherit correctness-preserving inspection fallbacks.

`session.history` locates append-origin message boundaries first and reads only a bounded page. Transcript pages exclude `graph/*`; Graph state is delivered through the independent projection baseline. The `session.list` baseline omits the Graph projection so listing every session cannot aggregate all historical Graph values in one response. Attached sessions and subagent histories apply the same page budgets. The latest preset-selection event is fetched separately for cold presenter composition, and legacy persistence implementations keep the previous full-inspection fallback.

Cold projection recovery is selective. Lightweight history-tail projections compute their restore floor without the Graph unit and read a persistence page that excludes `graph/*` before decoding; the Graph baseline is viewed directly from its identity-matching durable checkpoint. A selective fold never writes its incomplete rows back as the complete checkpoint. This prevents a large cached Graph state from being deep-restored, replayed, and serialized into several simultaneous copies while opening a transcript.

Each Graph execution Generation begins with one complete `graph/run` checkpoint. Later scheduler publications append `graph/run-update`, containing only changed node values and changed run-level fields. Replay accepts an update only for an existing run with the same graph, revision, Generation, Generation identity, and owner epoch; timestamps cannot move backward and a terminal result cannot be replaced. The fold reconstructs the same `GraphRun` value consumed by recovery and the UI. The Graph projection checkpoint version remains unchanged because its stored state representation did not change.

## Alternatives considered

- **Keep JSONL authoritative and add a SQLite history index.** Two durable stores would need crash reconciliation and a rule for which copy wins after partial writes. Making SQLite authoritative keeps one event ledger and one recovery path.
- **Continue full `graph/run` snapshots and rely on compression.** Compression reduces disk bytes but does not prevent replay from materializing repeated logical payloads. Incremental events remove the duplication before encoding.
- **Rewrite or delete legacy JSONL files after import.** An import defect would then remove the only recovery copy. Keeping the source immutable makes migration retryable and independently auditable.
- **Invalidate the Graph projection checkpoint.** The projection state representation is unchanged, so a version bump would force exactly the full legacy replay this change avoids.

## Consequences

New Graph logs grow with actual node-state changes instead of the sum of every prior run size. SQLite transcript reads allocate only non-Graph events in the bounded page rather than the complete cold session. A single event may exceed the byte budget so backward pagination always advances; the count budget remains hard. Existing projection checkpoints remain valid across the backend switch because cache identity is based on immutable session header fields; this avoids replaying a legacy large log merely to serve its tail. A missing Graph checkpoint leaves that optional baseline absent instead of forcing a legacy Graph replay during transcript loading. Resuming Graph work may still require domain recovery, so incremental Graph events, payload limits, and projection checkpoint cadence remain operational safeguards.

SQLite database schemas retain their pre-release bump-and-reject policy. The startup importer migrates the former JSONL backend format into a pristine or current SQLite database; it is not a SQLite schema upgrader. Raw JSONL encoding remains available for explicit compositions and examples that require one artifact per session.

## Verification

The shared persistence contract covers bounded intervals, append-surface positions, excluded domains, count limits, and byte limits for JSONL and SQLite. SQLite tests prove transactional legacy import and idempotent later startups. Host tests prove a cold history page and latest preset resolve without full inspection, reject dense Graph event transport, and omit Graph from session listing baselines. Graph tests prove incremental merge validation and full folded equivalence; Graph Mode tests prove one initial run checkpoint followed by node-bounded updates.
