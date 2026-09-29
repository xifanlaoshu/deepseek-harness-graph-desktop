---
description: "Capture content-addressed files from Graph Worker attempts and materialize exact manifests into an explicit workspace. This reference covers Provider responsibilities and artifact evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-artifacts

English | [中文](README.zh.md)

## Summary

Capture and materialize content-addressed artifacts for fenced Graph Worker attempts. Providers own storage, transfer, authentication, and retention while Graph validates attempt attribution.

## Table of Contents

- [Dev Note](#dev-note)
- [Contract](#contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

`ctx.graphArtifacts` is the Service Definition for transporting content-addressed files from a fenced Graph Worker attempt into durable storage and later materializing the exact manifest into an explicit workspace.

<a id="contract"></a>
## Contract

- Capture carries the complete Graph work, operation, attempt, run, generation, owner-epoch, and fencing identity. Returned manifests must match that attribution exactly.
- The runtime validates normalized relative paths, lexical uniqueness, result SHA-256 values, optional source SHA-256 values, modes, byte totals, limits, deadlines, and Provider references before Graph may persist the manifest. A null source hash means the changed file did not exist in the copied source workspace.
- Materialization is explicit and selects `forbid` or `replace`; a Worker never merges its own output into the source workspace.
- Recovery names one manifest and Provider reference and authorizes deletion only when no committed Graph output refers to it.
- Authentication, remote transfer, encryption, retention, and storage credentials belong to Providers rather than Graph Mode.
- Every Provider runs the shared artifact conformance suite. It verifies idempotent attempt-attributed capture, lexical content-addressed manifests, complete materialization, retained referenced evidence, exact-reference quarantine, authorized deletion, and absent-state replay.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because every artifact operation validates its manifest synchronously.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### Artifact evidence

#### What the model sees

Node output may name source-relative artifact paths. The complete `GraphArtifactManifest`, Provider locations, credentials, workspace roots, blob keys, and recovery evidence remain Host-only unless a later controller schema explicitly selects bounded public fields.

#### Token effect

No direct request content is added. Downstream nodes receive only artifact path strings already selected into predecessor output.

#### KV Cache effect

No direct effect; artifact manifests are durable execution evidence rather than prompt content.

## Known Limitations and Deferred Work

- This package defines transport and validation but does not choose a storage backend. Graph Mode owns the integration policy and requires source hashes before automatic materialization.
- Multi-Host deployments require a Provider backed by shared authenticated storage; a local filesystem Provider only covers hosts sharing the same mounted filesystem.
