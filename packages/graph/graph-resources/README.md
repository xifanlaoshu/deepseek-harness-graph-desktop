# @deepseek-ai/dsh-graph-resources

English | [中文](README.zh.md)

`ctx.graphResources` is the Service Definition for expiring model-resource observations, fenced reservations, and runtime capacity outcomes used by Graph admission. Static Graph configuration remains the hard ceiling; Provider telemetry can only reduce or delay eligibility.

## Contract

- A snapshot identifies one exact provider/model route and may report route status, active requests, queue depth, concurrency and weight limits, context/output capacity, memory class, available device memory, recent OOM, and rate-limit expiry. Unknown fields remain absent.
- Every snapshot expires. Graph cannot use an expired observation as proof of availability.
- A reservation request carries stable Graph work and operation ids, owner epoch, weight, hard ceilings, and deadline. A Provider returns `granted`, a typed wait with retry time, or a terminal route rejection.
- Reservations carry their own fencing token and expiry. Runtime outcomes release capacity or report capacity, OOM, rate-limit, or worker-loss evidence under that exact fencing identity.
- Recovery calls `reconcile()` with the exact reservation and fencing identity. A Provider confirms `released`, `already-released`, `absent`, or `conflict`, so a crash between Provider release and Graph settlement does not require a blind second release.
- Telemetry never authorizes an unconfigured model, raises a configured parallel or weight limit, or proves an external effect completed.
- Every Provider runs the shared resource conformance suite. It verifies stable reservation replay, conflicting-request rejection, monotonic replacement fencing, stale-write rejection, capacity waiting, idempotent release and recovery, and OOM backoff.

## Model Experience

### Resource evidence

#### What the model sees

Planning checkpoints and Graph execution evidence may include a bounded `GraphResourceSnapshot` summary. Raw device identifiers and private Provider diagnostics remain Host-only.

#### Token effect

No direct request content is added. A controller checkpoint may add one bounded resource summary to a later request.

#### KV Cache effect

No direct effect; any checkpoint summary is variable execution evidence.

## Known Limitations and Deferred Work

- Providers may publish stale or incomplete measurements before expiry; hard ceilings and worker fencing remain authoritative.
- This package does not poll a particular model server or GPU API. Deployment Providers own those integrations.
