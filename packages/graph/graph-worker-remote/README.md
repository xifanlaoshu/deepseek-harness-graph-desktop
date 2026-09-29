---
description: "Run Graph Workers through authenticated HTTP or a legacy out-of-process adapter. This reference covers remote assignment, durable recovery, and optional resource, scheduler, and artifact routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-worker-remote

English | [中文](README.zh.md)

## Summary

Run Graph Workers through authenticated HTTP or a legacy out-of-process adapter. The HTTP service persists accepted work and fences superseded processes; uncertain active jobs are quarantined for reconciliation.

## Table of Contents

- [Configuration](#configuration)
- [Contract](#contract)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

Authenticated remote Client and durable Worker service for [`dsh-graph-worker`](../graph-worker/README.md), plus a legacy adapter for existing out-of-process subagent Providers.

<a id="configuration"></a>
## Configuration

`mode` selects `client`, `server`, or `both`; the default is `client`.

The legacy Client uses `providerName`, `subagentProvider`, optional absolute `cwd`, and optional `artifactProvider`. `maxArtifactFiles` and `maxArtifactBytes` bound capture through `ctx.graphArtifacts`.

An authenticated HTTP Client sets `http.endpoint`, `principal`, `audience`, `credentialRef`, advertised `workspaceModes`, polling and retry limits, request timeout, and response-byte limit. `schedulerProviderName` and `resourceProviderName` optionally register the service's Graph Scheduler and Resource routes. `artifactProviderName` optionally registers its Graph Artifact route; capture and materialization roots plus file and byte limits define the local filesystem policy. HTTPS is mandatory except for an explicitly enabled loopback development endpoint. The selected credential is resolved before every operation, so rotation does not require a plugin restart.

Server and `both` modes require `server`:

- `audience`, `basePath`, and `principals` bind the service identity and each allowed caller to credential references.
- `journalPath` stores accepted jobs, logical Worker/workspace identities, underlying Provider references, terminal results, service epochs, and opaque Artifact mappings in SQLite.
- `workerProvider` names the same-process Provider that executes accepted assignments; `parentSessionId` names its live service-owned delegating Agent.
- `resourceRouteName` and `resourceProvider` optionally publish one same-process Graph Resource authority over the authenticated route.
- `schedulerRouteName` and `schedulerProvider` optionally publish one same-process durable Graph Scheduler ownership authority.
- `artifactRouteName`, `artifactProvider`, and `artifactTempRoot` optionally publish one persistent same-process Graph Artifact Provider through a private staging directory; `artifactMaxFiles` and `artifactMaxBytes` bound transfers.
- `maxClockSkewMs`, `maxRequestBytes`, `maxResultBytes`, `maxReplayEntries`, `busyTimeoutMs`, and `operationTimeoutMs` are hard deployment bounds.

<a id="contract"></a>
## Contract

The HTTP Client signs Worker, Resource, Scheduler, and Artifact requests with HMAC-SHA256. A signature covers the normalized method, exact request target, caller principal, service audience, millisecond timestamp, cryptographic nonce, and SHA-256 digest of the exact body. The server verifies signatures with constant-time comparison, rejects stale or replayed requests, and fails closed when its bounded nonce cache is full. Secrets contain 32 to 4,096 UTF-8 bytes.

Start is idempotent for one fenced assignment. The server persists a deterministic logical job, Worker, and workspace identity before invoking the underlying Provider. A retry after a lost response returns the same identity and never launches a second Worker. A new service process advances a durable epoch, fences writes from the superseded process, and turns every uncertain nonterminal row into a terminal quarantined result instead of silently redispatching it. Durable JSON is schema-validated when read. Reconciliation maps logical remote references back to the exact underlying Provider references. Cancellation is reported as accepted only after the underlying Worker accepts it.

The optional Resource route forwards observe, reserve, report, and reconcile operations to one shared Provider and rewrites its private Provider identity to the public route identity. This lets several Graph Hosts use one persistent capacity authority, including its live model-memory snapshots and reservation telemetry.

The optional Scheduler route forwards acquire, heartbeat, and release to one durable Provider and rewrites its private lease Provider identity. Multiple Graph Hosts can therefore contend for one run through a central transactional lease authority while retaining the same owner epoch and fencing rules used locally.

The optional Artifact route uploads only normalized regular files below configured roots, verifies decoded size and SHA-256, and stages them in a private directory before the persistent Provider captures them. The journal retains opaque public-to-underlying manifest mappings across restart. Materialization verifies the durable manifest, downloads every file through bounded staging, then the Client verifies every digest again and writes atomically below an allowed target root. Reconciliation deletes the mapping only after the underlying Provider reports `deleted` or `absent`.

The legacy adapter advertises shared-workspace execution. It forwards role/model selection to the configured subagent route and can capture artifact paths before terminal success. An offline legacy reference remains `quarantined` because that adapter has no durable remote journal.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because wire, journal, transfer, and Provider responses are validated at their trust boundaries.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### Remote assignment

#### What the model sees

The remote child receives the role and node prompt, exact `model.provider`, `model.model`, and `model.reasoningEffort` selection, structured-output schema, workspace policy, and tool restriction supported by the selected Worker Provider. Authentication, retry, and journal diagnostics remain Host evidence.

#### Token effect

The legacy adapter adds one bounded JSON-schema instruction. HTTP transport does not add model-visible text; the executing Provider owns its normal prompt adaptation.

#### KV Cache effect

Nodes with the same role and output schema can reuse those prompt prefixes. Node objectives and dependency evidence remain variable.

## Known Limitations and Deferred Work

- The Worker SQLite journal is one active-service persistence authority with epoch fencing. Multi-Host run ownership requires configuring the Scheduler route over a durable Provider; the HTTP service itself is not a replicated high-availability database.
- Restart recovery quarantines uncertain nonterminal jobs. It does not resume a live process or claim an external side effect was absent; reconciliation must settle retained Provider references before policy retries the work.
- The HTTP Worker protocol polls terminal state and does not yet stream progress. Resource snapshots are request/response telemetry rather than a server-pushed stream.
- Artifact files are base64-encoded inside bounded authenticated requests and responses. Large deployments should add an object-store Provider with presigned, digest-bound transfer instead of raising HTTP body limits indefinitely.
