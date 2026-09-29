---
description: "Persist Graph artifact manifests and files in a configured filesystem root. Use this reference to understand storage configuration, path safety, and materialization limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-artifacts-fs

English | [中文](README.zh.md)

## Summary

Persist content-addressed Graph artifact manifests and files below a configured filesystem root. The Provider validates paths and hashes and keeps materialization explicit.

## Table of Contents

- [Configuration](#configuration)
- [Safety](#safety)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

Persistent filesystem Provider for [`dsh-graph-artifacts`](../graph-artifacts/README.md). It captures selected Worker files into immutable SHA-256 blobs, stores attempt-attributed manifests, verifies every blob again before materialization, and retains shared blobs when an unreferenced manifest is reconciled.

<a id="configuration"></a>
## Configuration

- `providerName` is the route selected by a Worker adapter.
- `storeRoot` owns private blobs and manifests; the default is `.sessions/graph-artifacts`.
- `allowedWorkspaceRoots` optionally restricts capture sources to configured absolute roots.
- `maxFiles` and `maxBytes` are Provider hard ceilings and can only lower one request's bounds.

<a id="safety"></a>
## Safety

Paths must be normalized and source-relative. This Provider rejects symlinks and special files because their targets are execution-world-specific. Materialization rejects linked parent directories, verifies stored size and hash, and requires an explicit overwrite policy. Immutable writes use private temporary files and atomic publication; concurrent captures converge on the same content address.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because capture and materialization verify the immutable blob and manifest bytes.

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### Filesystem artifacts

#### What the model sees

The model sees only `artifacts` paths it emitted in structured node output. Filesystem storage roots, blob hashes, absolute paths, and reconciliation evidence remain Host-only.

#### Token effect

No direct request content is added.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- This Provider supports cross-process and cross-Host execution only when every Host shares the same authenticated filesystem mount and path mapping.
- Blob garbage collection is deliberately deferred; deleting one manifest never guesses whether another manifest still references a shared blob.
