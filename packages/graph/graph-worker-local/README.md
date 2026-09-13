# @deepseek-ai/dsh-graph-worker-local

English | [中文](README.zh.md)

Local Worker Provider for [`dsh-graph-worker`](../graph-worker/README.md). It can run a Graph attempt in the shared session workspace, an isolated copy, or a read-only snapshot, delegates model work through a configured subagent provider, detects undeclared writes in isolated allocations, and publishes a bounded content-addressed artifact manifest.

## Configuration

- `providerName` registers the Graph Worker route; default `local`.
- `subagentProvider` selects the existing subagent backend; default `spawn`.
- `isolationRoot` optionally selects the allocation parent directory.
- `exclude` omits private runtime state and generated directories from copies and mutation scans. A single-segment entry matches that directory name at any depth; the defaults therefore exclude nested `node_modules` and `.npm-cache` trees so dependency installations and package-manager caches cannot become source artifacts.
- `maxArtifactFiles` and `maxArtifactBytes` bound one manifest.
- `artifactProvider` optionally captures changed files into durable `ctx.graphArtifacts` storage before allocation cleanup. The Web composition uses `fs-artifacts`.

## Contract

`isolated-copy` copies the source workspace into a deterministic Provider-owned allocation before starting the child and passes that absolute path through the subagent activation request. The request caps an in-process child's sandbox mode at `workspace-write`, so a parent switched to `danger-full-access` cannot authorize writes outside the allocation. When the assignment carries `activeSubagentLimit`, the request also gives the child the Run-scoped capacity id `graph-run:<runId>` and that ceiling; descendants inherit it through the subagent service. An allocation that fails initial snapshot validation or child startup is unpublished and is deleted regardless of the later settlement cleanup policy. After settlement, every changed path must belong to a declared write root. A changed symlink may not escape the allocation. Each artifact entry contains its result hash and its source hash, or null for a newly created file, so Graph integration can detect source drift before replacement. Isolated deletion is rejected because an absent blob cannot prove an intended source deletion; an explicit integration task must own it. Deletion and undeclared-write results are non-retryable because dispatching the unchanged node cannot satisfy its ownership declaration. The Provider attributes the manifest to the exact attempt and follows the assignment cleanup policy. Recovery derives the exact allocation path from its opaque allocation id; it cancels an attached Worker and deletes only an idempotent orphan whose recorded cleanup policy permits deletion.

`read-only-snapshot` uses the same deterministic copy, caps an in-process child's sandbox mode at `read-only`, and accepts no changed path because its write-root list is empty. It is intended for analysis, review, and verification nodes that need a stable filesystem view without source mutation.

`shared` preserves compatibility but cannot attribute concurrent external changes and therefore publishes no mutation manifest. Graph planning must serialize overlapping shared write roots.

## Model Experience

### Local assignment

#### What the model sees

The child receives the role prompt, node prompt, selected model, structured-output schema, tool policy, and its `workspaceCwd`. Allocation paths and file hashes remain Host evidence.

#### Token effect

This Provider adds no content beyond the Graph-owned role, node, schema, and tool-policy request.

#### KV Cache effect

Role and node prompts are owned by Graph Mode; this Provider adds no model-visible prefix.

## Known Limitations and Deferred Work

- Sandbox-mode caps require an in-process subagent provider and the sandbox-policy plus enforcing filesystem or process Providers. The local Worker still relies on its post-run mutation scan for attribution and rejects providers that cannot honor the requested cap.
- This Worker never writes an isolated result into the source workspace itself. Graph Mode validates and materializes each completed manifest before publishing node success; explicit Integration nodes still own cross-node conflict resolution, verification, and deletion.
