# Agent Note: Structured Graph control flow and bounded subgraphs

Status: proposed

English | [中文](2026-08-18-structured-graph-control-flow-and-subgraphs.zh.md)

## Problem

Graph edges currently combine dependency order with a small set of predicates over unversioned worker JSON. All incoming conditional edges are conjunctive, so the controller cannot declare exactly-one, any, all, or activated branch semantics. Review rejection is prose that the controller must interpret, broad work cannot expand into validated dynamic nodes or nested subgraphs, and retry counts do not define a project-level convergence or termination policy.

## Proposal

Every executable node will declare an `outputSchema` with a stable schema id, version, JSON Schema subset, and byte limit. The Host validates structured output before it can activate an edge, satisfy an acceptance rule, publish progress, or become reusable evidence. A schema mismatch is a typed attempt outcome and cannot fall back to parsing summary text. Gate and review nodes will use dedicated result types with a closed decision discriminant, issue ownership, evidence references, and optional proposed repair scope.

Edges will reference named branch groups. A group declares one of four deterministic activation modes:

| Mode | Activation rule |
| --- | --- |
| `all` | Every member predicate is true. |
| `any` | At least one member predicate is true. |
| `exactly-one` | Exactly one member predicate is true; zero or several is a branch error. |
| `activated` | Every member whose predecessor ran and produced a compatible output must be true; members whose predecessor was not activated do not veto the group. |

A node may require multiple groups, which are combined with `all`. Predicates remain declarative path/operator/value records over validated outputs. Predicate evaluation records each member's value, boolean result, activation reason, and schema version so replay does not depend on later code or model interpretation.

## Dynamic expansion and nested subgraphs

A controller-authored expansion node may return a typed `GraphExpansionProposal` containing candidate nodes, edges, branch groups, output schemas, ownership declarations, and budgets. The scheduler never inserts those records into a running revision. The Host validates ids, role references, schemas, acyclicity, depth, node count, writable ownership, model compatibility, and policy limits, then asks the controller to commit a new immutable revision.

A subgraph node references a child `GraphId`, the exact child revision selected for execution, an input mapping, and an output mapping. The parent waits on the child run's aggregate terminal record rather than importing every child event. Child logs remain authoritative for internal evidence. Subgraph depth, total expanded nodes, concurrent children, and serialized output size are validated settings. Recursive graph references and ancestry cycles are rejected even though each individual revision is a DAG.

Dynamic fan-out uses a bounded map declaration over a schema-validated array. Each item receives a deterministic child-node id derived from the expansion node and item key; duplicate or unstable keys fail before work starts. Dynamic fan-in is an ordinary node over the materialized child outputs and declares whether partial terminal outcomes are accepted.

## Review repair and termination

Review and verification nodes publish `approved`, `rejected`, or `needs-user` decisions. `rejected` produces a [planning checkpoint](2026-08-18-progressive-graph-planning-checkpoints.md) with structured issues and ownership. The controller may commit a repair revision that changes the affected nodes and invalidates their complete successor closure. It cannot reopen the completed run or add a reverse edge.

Each graph carries a validated termination policy covering maximum graph revisions, automatic repair revisions, dynamic expansions, subgraph depth, attempts per node, runtime-limit continuations, wall time, and optional token or cost budget. A no-progress detector compares issue ids, output hashes, and changed-node closure across repair iterations. Repeated equivalent rejection reaches `exhausted` or `awaiting_user` instead of starting another automatic revision.

Terminal evaluation is deterministic and records one of `succeeded`, `failed`, `canceled`, `exhausted`, or `awaiting_user`, plus the policy rule that ended the run. Provider retry, same-session max-token continuation, repair revision, and user retry use separate counters and cannot consume one another's budget.

## Alternatives considered

**Ask the controller to describe branch behavior in prompts.** Text cannot prove exactly-one activation, replay a historical decision, or reject ambiguous outputs before successors start.

**Allow executable predicates.** JavaScript or model-authored expressions would make durable graph data code-bearing, complicate sandboxing, and make replay depend on runtime implementation details. The declarative predicate set can grow through versioned operators.

**Permit cycles inside one revision.** Cycles obscure which evidence belongs to each iteration and make downstream invalidation ambiguous. New revisions and run generations represent feedback while each revision remains acyclic.

**Let workers mutate the active graph directly.** A partially accepted expansion could race scheduler admission and leave evidence without an attributable design. Typed proposals followed by Host validation and controller commit preserve one revision authority.

## Acceptance criteria

- Node output is validated against its logged schema version before any branch, reuse, settlement, or acceptance decision consumes it.
- `all`, `any`, `exactly-one`, and `activated` groups have deterministic unit, replay, and assembled-application coverage, including ambiguous and inactive inputs.
- Dynamic map expansion and nested subgraphs enforce stable ids, acyclicity across ancestry, configured depth and size limits, ownership validation, and immutable revision creation.
- Structured review rejection creates a repair checkpoint and a replacement revision that reruns the exact invalidated successor closure.
- Separate configured budgets limit attempts, continuations, repairs, expansions, subgraph depth, elapsed time, and resource use; hitting a limit records `exhausted` or `awaiting_user` without another automatic loop.
- The Graph UI displays schemas, branch groups, chosen paths, subgraph identity, iteration count, and the terminal policy rule in both design and execution evidence.

## Risks

JSON Schema and branch-group versioning add durable compatibility obligations, while dynamic expansion can grow state and UI cost faster than static DAGs. Conservative defaults and fail-loud validation may reject useful model output until controllers learn the schemas. No-progress comparison cannot prove semantic equivalence; it is a bounded safety signal, not a correctness judgment. Nested subgraphs also make cross-graph cancellation and resource accounting more complex and therefore depend on the shared durable identity and recovery design.
