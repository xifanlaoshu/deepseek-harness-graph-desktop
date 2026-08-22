# @deepseek-ai/dsh-graph-resources-local

English | [中文](README.zh.md)

Local Provider for [`dsh-graph-resources`](../graph-resources/README.md). It turns configured exact model routes into leased concurrency and weight reservations, then uses runtime OOM and rate-limit outcomes to reduce eligibility for a bounded interval.

## Configuration

- `providerName` registers the resource route; default `local-resources`.
- `routes` declares exact provider/model ids, concurrency and optional weight ceilings, plus optional context, output, and memory-class planning facts.
- `observationTtlMs`, `leaseMs`, `retryMs`, and `oomBackoffMs` bound observations, ownership, waiting, and OOM degradation.

## Contract

Static Graph role and model limits remain hard ceilings. The Provider may lower effective concurrency or weight, reject an impossible request, delay during a live lease, recent OOM, or rate limit, and return an expiring snapshot. Reservations use stable operation identity and monotonic fencing. An active operation replay must match its frozen route, work, weight, and hard ceilings; after release or expiry, a replacement keeps the stable reservation id but receives a newer fencing token. Repeated identical runtime outcomes are idempotent; missing, stale, or conflicting outcomes fail.

The Provider contains no device API and exposes no device identity. A deployment that can observe GPU memory or model-server queues should use another `dsh-graph-resources` Provider with the same reservation protocol.

## Model Experience

### Local capacity evidence

#### What the model sees

Graph planning checkpoints and resource-wait evidence may include a bounded `GraphResourceSnapshot` status. Route capacities are not added to ordinary worker prompts.

#### Token effect

No direct request content is added. A later controller checkpoint may include one bounded status summary.

#### KV Cache effect

No direct effect; any status summary varies with current capacity.

## Known Limitations and Deferred Work

- Active capacity is process-local. A Provider restart drops outstanding leases, so recovery confirms the exact old reservation as `absent`; deployments that must preserve capacity ownership across process loss require a durable Provider.
- Recent OOM and rate-limit backoff comes from Worker outcomes, not direct model-server telemetry.
