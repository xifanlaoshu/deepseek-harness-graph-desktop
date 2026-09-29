---
description: "Grant exclusive, fenced ownership of durable Graph runs to one Host at a time. This reference distinguishes whole-run leases from node-level worker claims."
kind: "package-reference"
---

# Graph scheduler

English | [中文](README.zh.md)

## Summary

Grant and renew exclusive ownership of a durable Graph run with expiring leases and monotonic fencing tokens. Choose a Provider that matches the deployment's persistence and transport needs.

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

`@deepseek-ai/dsh-graph-scheduler` is the Service Definition for exclusive Graph-run ownership. A Provider atomically grants one expiring lease, renews only the exact lease identity, and rejects stale fencing tokens. This is distinct from node-level LoopX claims: it decides which Host may advance the durable run.

Providers must persist fencing counters beyond lease expiry. A replacement owner receives a strictly greater token and Graph Mode uses that token as the run `ownerEpoch`.

`GraphSchedulerAuthorityError` identifies a heartbeat failure that is already known to be fenced or expired. Consumers stop writing immediately for that error; transport and storage failures that do not prove authority loss may be retried only while the current lease remains live.

Every Provider runs the shared Scheduler conformance suite. It verifies exact idempotent acquisition, competing-owner exclusion, immutable session identity, minimum-epoch admission, exact heartbeat and release, replacement fencing, and stale-owner rejection. The exported `MemoryGraphSchedulerProvider` supplies the same semantics for single-process compositions without claiming restart durability.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because each mutation validates the current lease identity and fencing token.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### Scheduler ownership

#### What the model sees

Nothing directly. Ownership decisions affect whether one Host may advance a run; persisted `graph/run` state with its `ownerEpoch` remains the model-visible evidence.

#### Token effect

No model tokens are added.

#### KV Cache effect

Scheduler ownership has no KV-cache effect.

## Known Limitations and Deferred Work

- This package defines exclusive run ownership but does not provide durable storage, Host authentication, or transport. Deployments choose a Provider that matches their failure and trust model.
- A fencing token prevents a stale Host from renewing scheduler state; it cannot undo arbitrary external effects that the stale Host already started. Workers and durable writes must enforce the same epoch where split-brain safety matters.
