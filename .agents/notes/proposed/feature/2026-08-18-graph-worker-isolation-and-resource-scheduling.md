# Agent Note: Graph worker isolation and resource scheduling

Status: proposed

English | [中文](2026-08-18-graph-worker-isolation-and-resource-scheduling.zh.md)

## Problem

Graph workers support shared or isolated-copy local workspaces and a remote adapter. Static global, role, provider/model, and weighted caps combine with an optional SQLite authority that persists reservations, fencing, OOM backoff, and rate-limit expiry across local Host processes. That foundation does not observe model queue depth, available VRAM, remote worker health, or semantic file conflicts, and SQLite is not a multi-Host lease store. A distributed lease without authenticated workspace isolation and artifact ownership could allow two valid workers to overwrite the same files or expose credentials outside their intended Host.

## Current foundation

`dsh-graph-artifacts` now validates attempt-attributed content-addressed manifests and dispatches capture, materialization, and recovery to named Providers. `dsh-graph-artifacts-fs` stores immutable SHA-256 blobs and manifests, rejects unsafe paths and symlinks, re-verifies bytes before explicit materialization, and supports cross-process or cross-Host use when every Host shares the same authenticated mount. The local and remote Worker adapters can capture structured artifact paths through this seam before publishing terminal success, and the Web composition enables it for isolated local work. `dsh-graph-worker-remote` now provides an authenticated HTTP Client and Server over credential references. It persists deterministic logical job identities before dispatch, deduplicates lost-response retries, advances a durable service epoch to fence superseded process writes, quarantines uncertain nonterminal jobs on restart, maps reconciliation to exact underlying Worker references, and enforces request, response, replay, and clock bounds. The same authenticated service can publish cross-Host Scheduler and Resource authorities plus bounded content-addressed Artifact transfer; it maps private Provider identities, keeps opaque manifest mappings across restart, and verifies file paths, sizes, hashes, and local root policy at both ends. `dsh-graph-scheduler` separates whole-run Host ownership from node-level LoopX claims, and its SQLite Provider supplies the transactional lease and takeover fencing behind the remote route. `dsh-graph-resources-sqlite` can fail closed on expiring queue and device-memory snapshots atomically published by a trusted model runtime or sidecar. This does not complete resumable remote processes, replicated high-availability authorities, remote Worker health and streaming telemetry, model-server-specific native metrics adapters, object-store-scale transfer, exclusive integration leases, semantic conflict detection, or reference-aware blob garbage collection.

## Proposal

Graph execution will add a Worker Provider capability with local-process, local-isolated, and remote implementations. A worker registers a stable id, protocol version, supported platforms, tools, sandbox modes, model routes, resource telemetry features, workspace capabilities, maximum leases, and artifact transport. Registration is advisory until the worker proves a current lease and passes assignment validation.

An assignment includes `GraphWorkId`, attempt id, fencing token, immutable node input, role and prompt snapshot, exact model selection, tool policy, workspace allocation, declared read and write ownership, artifact contract, deadlines, and public coordination references. The worker streams ordered lifecycle and progress records, stages structured output and artifacts, and settles through the owning Graph operation. It cannot alter the graph definition, role template, or scheduler policy.

## Workspace and file ownership

Each executable node receives one workspace mode: read-only snapshot, isolated copy-on-write directory, Git worktree, sandbox/container mount, or explicitly shared workspace. Parallel mutation defaults to isolation. The allocation records source revision, base content hash, writable roots, cleanup policy, and provider reference. Credentials are passed as scoped references resolved on the worker, never copied into Graph events or artifact manifests.

Nodes declare normalized read roots, write roots, generated artifacts, and optional merge strategy. Submission validation rejects overlapping writable roots among concurrently eligible nodes unless a declared integration node serializes them. Runtime observation compares actual file mutations with the declaration; an undeclared write fails the node or enters approval according to policy. File ownership is path-based coordination, not a claim that semantic merges are conflict-free.

Successful isolated work produces a content-addressed artifact manifest containing hashes, modes, relative paths, provenance, and size. A dedicated integration node applies patches or merges work into the target workspace under an exclusive lease and records conflicts as structured output. Canceling a worker stops future execution but does not pretend already published filesystem or external mutations were rolled back.

## Live model-resource scheduling

Model providers and workers may publish expiring resource snapshots: route availability, active requests, queue depth, concurrency limit, reservation weight, known context window, maximum output tokens, memory class, available device memory, and recent OOM or rate-limit signals. Unknown fields remain unknown. Static Graph settings remain hard ceilings and fallbacks; telemetry may reduce or delay admission but never raise a configured limit.

Admission becomes a durable reservation over dependency readiness, role cap, exact model cap, worker lease, workspace lock, and model-resource capacity. The scheduler uses FIFO fairness within priority, reserves configured controller capacity, and records why a node is waiting. Reservations expire and use fencing so a disconnected worker cannot hold capacity forever.

An OOM, capacity rejection, or repeated max-token result is a typed resource outcome. Policy may back off the route, select another pre-approved model for the same role, continue the same child within its output budget, or return a [planning checkpoint](2026-08-18-progressive-graph-planning-checkpoints.md) for node splitting. The scheduler never silently switches to an unapproved provider, model, role, or reasoning selector.

## Security and trust

Remote workers authenticate as configured deployment identities and receive least-privilege tool, credential, network, and filesystem policies. Artifact content is validated for path traversal, size, type, and hash before integration. Host and worker protocol messages use bounded schemas and reject version or capability mismatch before claim. A worker's telemetry affects its own eligibility but is not trusted as proof that an external side effect completed.

## Alternatives considered

**Run every worker in the parent checkout.** This is simple but makes parallel file ownership unenforceable and cancellation unable to contain partial writes.

**Use only static model caps.** Static caps are necessary policy but cannot adapt to another process consuming VRAM, a remote queue, or recent OOM evidence. Telemetry is a reducing signal layered below hard ceilings.

**Let workers choose their own model when overloaded.** That would bypass session-owned role snapshots, cost policy, and evidence attribution. Alternate routes must be pre-approved and the chosen route logged before execution.

**Merge worker directories automatically on success.** Files can merge textually while violating architecture or tests. A normal integration node keeps merge, review, and verification visible in the graph.

## Acceptance criteria

- Local and remote Worker Providers pass one assignment, lease, fencing, cancellation, progress, artifact, and failure conformance suite.
- Parallel mutable nodes use isolated allocations by default; writable-root conflicts fail before execution, undeclared writes are detected, and integration occurs under an exclusive recorded operation.
- Artifact manifests are content-addressed, bounded, path-safe, attributable to the exact attempt, and recoverable without the worker remaining online.
- Admission combines static hard ceilings with expiring live telemetry and records wait reasons, reservations, releases, expiry, OOM backoff, and any approved reroute.
- Worker loss, stale fencing, workspace cleanup failure, artifact corruption, and unavailable models reach durable recoverable outcomes instead of leaking capacity or silently rerunning effects.
- The Web execution view exposes effective worker, workspace mode, model route, resource wait, reservation, artifact, and conflict evidence.

## Risks

Workspace isolation and artifact transfer add disk, network, and cleanup cost, while some tools depend on host-global state that is difficult to reproduce remotely. Telemetry can be stale or dishonest and therefore cannot replace hard limits. Path ownership misses semantic conflicts in generated indexes, databases, or external services. Supporting several isolation modes increases platform variance; the shipped profile must declare which guarantees it actually provides rather than presenting all modes as equivalent.
