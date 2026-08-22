# SQLite Graph scheduler

English | [中文](README.zh.md)

`@deepseek-ai/dsh-graph-scheduler-sqlite` provides cross-process Graph-run ownership with SQLite `BEGIN IMMEDIATE` transactions. It preserves fencing counters after expiry, blocks takeover while a lease is live, and rejects stale heartbeat or release identities.

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
