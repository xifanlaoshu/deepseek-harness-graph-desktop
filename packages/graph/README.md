# Graph

English | [中文](README.zh.md)

The graph group owns durable, editable DAG orchestration for multi-agent work. The [subsystem reference](../../docs/subsystems/graph.md) lists its Cordis services.

| Package | Role | Cordis key |
|---|---|---|
| [`dsh-graph`](graph/README.md) | Durable definitions, revisions, runs, validation, and projection | none |
| [`dsh-graph-mode`](graph-mode/README.md) | `/graph` controller and bounded background scheduler | `graphMode` |
| [`dsh-graph-coordination`](graph-coordination/README.md) | Provider-neutral claim, observation, and evidence seam | `graphCoordination` |
| [`dsh-graph-coordination-loopx`](graph-coordination-loopx/README.md) | LoopX CLI coordination provider | `graphCoordination` |
| [`dsh-graph-worker`](graph-worker/README.md) | Provider-neutral fenced worker assignment and lifecycle seam | `graphWorkers` |
| [`dsh-graph-worker-local`](graph-worker-local/README.md) | Shared, isolated-copy, or read-only-snapshot local worker provider | `graphWorkers` |
| [`dsh-graph-worker-remote`](graph-worker-remote/README.md) | Out-of-process subagent worker adapter | `graphWorkers` |
| [`dsh-graph-artifacts`](graph-artifacts/README.md) | Content-addressed artifact capture and materialization seam | `graphArtifacts` |
| [`dsh-graph-artifacts-fs`](graph-artifacts-fs/README.md) | Persistent filesystem artifact transport | `graphArtifacts` |
| [`dsh-graph-resources`](graph-resources/README.md) | Expiring model-resource observations and fenced reservations | `graphResources` |
| [`dsh-graph-resources-local`](graph-resources-local/README.md) | Local leased capacity with OOM and rate-limit backoff | `graphResources` |
| [`dsh-graph-resources-sqlite`](graph-resources-sqlite/README.md) | Durable cross-process capacity, fencing, and backoff | `graphResources` |
| [`dsh-graph-scheduler`](graph-scheduler/README.md) | Provider-neutral fenced ownership of whole Graph runs | `graphScheduler` |
| [`dsh-graph-scheduler-sqlite`](graph-scheduler-sqlite/README.md) | Cross-process run leases and persistent fencing counters | `graphScheduler` |

The scheduler requires one named worker provider and can run without external coordination, run ownership, or live resource telemetry. Production compositions mount a run-ownership Provider so only one Host can advance a restored run. A deployment that requires cross-agent control-plane state mounts exactly one coordination provider; the LoopX provider fails loud when its configured goal or peer roster is unavailable. Static Graph limits remain hard ceilings when a resource provider is mounted.
