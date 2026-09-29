---
description: "Coordinate Graph model-resource reservations across processes with SQLite and durable fencing. This reference covers database configuration, telemetry, and deployment limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-resources-sqlite

English | [中文](README.zh.md)

## Summary

Coordinate expiring Graph resource reservations across processes with SQLite persistence and fencing. Shared telemetry and backoff state survive process restarts; SQLite transactions block the JavaScript thread briefly.

## Table of Contents

- [Configuration](#configuration)
- [Contract](#contract)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

SQLite Provider for [`dsh-graph-resources`](../graph-resources/README.md). It persists exact model-route reservations, fencing tokens, terminal outcomes, OOM backoff, and rate-limit expiry so Web sessions and Host processes using the same database share one capacity authority.

<a id="configuration"></a>
## Configuration

- `providerName` registers the resource Provider; default `sqlite-resources`.
- `path` selects the database file and resolves from the Host working directory; default `.sessions/graph-resources.sqlite`.
- `routes` optionally supplies lower route ceilings and planning facts. A route may set `telemetryPath`, `minimumAvailableDeviceBytesPerWeight`, and `maxQueueDepth` to require a fresh versioned JSON snapshot from a trusted model runtime or sidecar before new admission. An unlisted route remains eligible beneath the hard ceiling in its Graph request.
- `observationTtlMs`, `leaseMs`, `retryMs`, and `oomBackoffMs` bound observations, ownership, waiting, and OOM degradation.
- `telemetryMaxBytes` bounds one telemetry file. `busyTimeoutMs` bounds SQLite lock waiting. `journalMode` selects `wal`, `delete`, or `truncate` after database identity validation.

<a id="contract"></a>
## Contract

Every admission runs in a SQLite `BEGIN IMMEDIATE` transaction. The Provider removes expired leases, reuses an identical operation and owner epoch, derives a stable reservation id, allocates a monotonic fencing token, and evaluates route capacity before committing. Concurrent processes therefore cannot both consume the same final capacity slot.

The effective route ceiling is the minimum of a configured route ceiling, the current request's frozen Graph ceiling, and the ceilings carried by active reservations. This preserves historical session snapshots while preventing a session with a higher limit from overriding a stricter active session. Route weights use the same rule.

When `telemetryPath` is configured, the Provider reads and validates the complete file before opening its SQLite transaction. The snapshot must identify the exact provider/model route and carry `protocolVersion: 1`, `observedAt`, `expiresAt`, `status`, and optional request, queue, concurrency, and available-device-byte facts. Missing, stale, unavailable, or malformed telemetry fails closed. Queue and available-memory thresholds produce typed `queue` and `memory` waits, while the durable configured and Graph ceilings remain hard limits. The producer must publish the file atomically.

Terminal reports are idempotent under reservation id and fencing token. OOM and rate-limit outcomes persist their backoff state. Recovery distinguishes an already released reservation, an absent lease, and a newer fencing token; it never releases a replacement lease through an older identity.

All processes opening one database must use the same resource configuration. A different configuration is accepted only when no reservation remains; already-open Providers then reject further operations until they reload. A foreign application id, unsupported schema version, or non-empty unowned database is rejected before journal mode changes.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because SQLite transactions validate reservations and fenced terminal transitions.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### Persistent capacity evidence

#### What the model sees

Graph planning checkpoints and resource-wait evidence may include the Provider's bounded `GraphResourceSnapshot`. SQLite paths, lock diagnostics, and reservation rows remain Host-only.

#### Token effect

No direct request content is added. A later controller checkpoint may include one bounded capacity summary.

#### KV Cache effect

No direct effect; a checkpoint capacity summary varies with active leases and recent outcomes.

## Known Limitations and Deferred Work

- SQLite coordinates processes that can safely open the same database file. It is not a multi-Host lease store over an arbitrary network filesystem.
- The Provider does not know a model server's native metrics API. A trusted runtime or sidecar must translate GPU memory and queue metrics into the versioned telemetry file and keep its expiry current.
- `DatabaseSync` blocks the JavaScript thread during each short reservation transaction. A high-throughput deployment should implement the same Provider protocol over a transactional service database.
