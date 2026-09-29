---
description: "Share Graph run ownership across processes with transactional SQLite leases and persistent fencing counters. This reference covers the durable scheduler Provider."
kind: "package-reference"
---

# SQLite Graph scheduler

English | [中文](README.zh.md)

## Summary

Share Graph run ownership across processes with SQLite leases and persistent fencing counters. Transactions prevent live-lease takeover and reject stale owner operations.

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

`@deepseek-ai/dsh-graph-scheduler-sqlite` provides cross-process Graph-run ownership with SQLite `BEGIN IMMEDIATE` transactions. It preserves fencing counters after expiry, blocks takeover while a lease is live, and rejects stale heartbeat or release identities.

The default lease lifetime is 120 seconds and SQLite waits up to 30 seconds for transaction contention. These values leave several heartbeat opportunities during a temporary Host pause while preserving bounded takeover; deployments may override both values in Cordis configuration.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because SQLite transactions validate every ownership transition.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### SQLite ownership

#### What the model sees

Nothing directly. Database paths, lease rows, Host owner ids, and transaction diagnostics remain Host-only; only resulting `graph/run` evidence can reach later model context.

#### Token effect

No model tokens are added.

#### KV Cache effect

SQLite ownership has no KV-cache effect.

## Known Limitations and Deferred Work

- SQLite coordinates processes that can safely open one database file. It is not an authenticated multi-Host scheduler over an arbitrary network filesystem.
- Lease ownership identifies a configured Host process, not a remotely attested Worker. Distributed deployments still need authenticated Host identity, health reporting, and a shared durable Provider.
