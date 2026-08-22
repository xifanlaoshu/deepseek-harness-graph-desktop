# @deepseek-ai/dsh-graph-worker

English | [中文](README.zh.md)

`ctx.graphWorkers` is the Service Definition for assigning one fenced Graph node attempt to a named local or remote Worker Provider. It validates protocol and capability requirements, while Providers own workspace allocation, child execution, cancellation, artifact staging, and terminal resource classification.

## Contract

- An assignment freezes the Graph work, operation, attempt, run generation, owner epoch, fencing token, role, node, prompt, output schema, workspace policy, deadline, and tool policy before a Provider accepts it.
- Providers advertise supported workspace modes and whether they support remote execution, structured output, tool filtering, artifact manifests, progress, and cancellation. Unsupported requirements fail before dispatch.
- A published run owns one workspace allocation, cooperative cancellation, and one terminal result. Outcomes distinguish model completion, cancellation, infrastructure failure, token exhaustion, capacity rejection, OOM, and route unavailability.
- Recovery addresses the exact prior Worker and workspace through `reconcile()`. The Provider returns `canceled`, `deleted`, `retained`, `absent`, or `quarantined`; deletion requires an explicit scheduler proof that replay is idempotent plus a compatible cleanup policy.
- Artifact manifests are content-addressed provider references; a Provider must validate relative paths, hashes, modes, sizes, and attempt attribution before publishing them.
- The Service Definition does not choose a Provider, allocate resources, interpret model output, or integrate artifacts. Those responsibilities belong to Graph Mode, a resource Consumer, and an integration node.
- Every Provider runs the shared Worker conformance suite. It verifies advertised capabilities, pre-terminal Worker and workspace references, one completed or aborted terminal result, cooperative cancellation, and exact active-Worker reconciliation with mismatched workspace rejection.

## Model Experience

### Worker evidence

#### What the model sees

Graph Mode may select bounded public `GraphWorkerResult` evidence. Worker ids, workspace paths, and artifact transport remain Host-only unless a controller or node schema explicitly selects a field.

#### Token effect

This seam adds no request content; Graph Mode owns worker prompts and any selected evidence.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- This package is provider-neutral and does not make a shared workspace isolated. A concrete Provider must advertise only the modes it can enforce.
- Arbitrary external effects cannot be made exactly-once by this seam; a quarantined or unreachable Worker remains uncertain and requires Graph policy or human adjudication.
