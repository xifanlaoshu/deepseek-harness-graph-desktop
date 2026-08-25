# `@deepseek-ai/dsh-graph-coordination`

English | [中文](README.zh.md)

Service Definition for graph-worker coordination outside the Harness session log. A provider prepares work items for an immutable graph revision, admits and claims each node with a fresh compact observation, then records terminal evidence and progress. The scheduler remains responsible for child-agent execution, DAG dependencies, retries, and durable run snapshots.

Protocol version 3 carries both a stable logical `workId` and a Generation-scoped `activationId`. Providers key mutable claim, lease, progress, cancellation, observation, and terminal state by Activation; logical Work remains the lineage key used by Graph invalidation and operator controls. A terminal Activation is immutable and does not prevent a later Generation from claiming the same logical Work under another Activation.

Repeated delivery of `claim()` for an already terminal Activation returns the accepted terminal outcome and evidence as an idempotent disposition. A Consumer must not dispatch another Worker for that disposition; reconciliation decides whether the durable local Run already contains the matching terminal result.

The seam deliberately transfers public-safe summaries only. Raw prompts, transcripts, credentials, and private paths remain in Harness sessions and must not be copied into a coordination provider.

A Consumer must give terminal settlement a live signal even when the worker was canceled, and must await that settlement before releasing the provider. This ensures that cancellation, revision replacement, and teardown cannot leave a claimed external work item executable.

A heartbeat returns the current lease id and fencing token. A Provider may advance that identity during renewal; the Consumer must durably record it and use only the newest returned identity for later heartbeats, cancellation, reconciliation, and terminal settlement.

Every Provider runs the shared eight-operation conformance suite. It verifies prepare, claim, heartbeat, observe/watch, progress, cancellation, settlement, and reconciliation together, including repeated delivery, conflicting payloads, stale fenced writes, ordered cancellation observation, and matching or conflicting terminal evidence.

## Model Experience

### Coordination observation

#### What the model sees

A worker can receive the `GraphCoordinationService.claim()` provider's fresh public-safe observation for its claimed node. The Consumer decides where to place that text and must not expose raw coordination transport details.

#### Token effect

The provider contributes at most one observation per node attempt; its implementation owns the observation bound.

#### KV Cache effect

Observations are attempt-specific suffixes, so they do not provide stable cross-node cache content.

## Known Limitations and Deferred Work

- The Service Definition does not persist or recover provider state. Each provider owns its external identity, availability, observation bounds, and recovery policy.
