# Agent Note: Graph controller resilience and session-owned compaction routing

Status: implemented

English | [中文](2026-08-26-graph-controller-resilience-and-compaction-routing.zh.md)

## Problem

Graph Mode routes every human input through one controller role. A controller model can reject a configured reasoning effort, exceed its context window, lose a stream after provider retries, or fail another request capability before it can classify the input. Retrying the same route indefinitely cannot recover a capability mismatch, while changing the process-wide selected model would also change unrelated sessions and would not reliably route the direct `ctx.llm.stream()` call used for compaction.

Global Graph role templates and session Graph settings already have different ownership: a global template is copied on first Graph activation, and the session log owns the complete snapshot afterward. Controller recovery and compaction routing need the same historical isolation. They must also preserve the compaction guarantee that `llmStreamCall: true` describes one reconstructable successful auxiliary call; silent multi-model summary attempts would create unlogged calls that replay cannot reproduce.

## Decision

`GraphModeConfig.controllerResilience` is an optional session-owned policy. New defaults enable the policy with no advanced routes. Omission preserves historical routing. The policy stores an ordered list of explicit provider/model routes, independent controller and compaction purpose flags, optional reasoning selectors, exact retryable failure codes, a positive per-turn fallback limit, and compaction threshold, retention, output-token, and reasoning settings.

The Graph controller's `agent/request-error` listener calls `next()` first. Existing provider retry and context-overflow compaction therefore retain priority. Only an unhandled configured failure code can select the next controller route and return `{ kind: 'retry' }`. The route index is scoped to the current turn, bounded by both the configured route count and `maxFallbackAttemptsPerTurn`, and cleared when a later turn requests a route. Cancellation never changes recovery state or requests another attempt. The controller's normal role model remains the primary route.

Compaction gains a backend-independent `compaction/policy` waterfall in the Service Definition. `BasicCompactionEngine` resolves its normal exact-target policy, then lets scoped policy plugins replace the complete pressure, retention, output-token, and single summary-target decision. Graph Mode selects the first route marked for compaction, or the primary controller route when none is configured. It does not attempt multiple summary models inside one transaction: the stored `compaction/summary` continues to identify exactly one local LLM call and complete output.

The Plugins Graph settings page and the current-session Graph settings page share one editor for these values. Global writes remain revision-fenced settings and affect only sessions taking their first Graph snapshot afterward. A session save appends one validated `graph/config` replacement and affects only that session. Legacy settings documents are normalized in the editor without an update loop and acquire the new defaults only when saved.

## Alternatives considered

**Change the process-wide model after a controller failure.** Rejected because the failure belongs to one Graph turn, while a process selection affects unrelated sessions and does not route direct compaction calls.

**Retry every controller failure on an advanced model.** Rejected because user cancellation, malformed application output, permission failures, and unknown errors do not prove that another model is safe or useful. Exact failure-code admission and a turn-local ceiling keep escalation bounded.

**Try the primary and every compaction fallback inside one summary transaction.** Rejected because only the successful `compaction/summary` is durable. Failed auxiliary calls would be invisible to log replay, token accounting, and snapshot reconstruction. Graph therefore selects one advanced compaction route before the reconstructable call.

**Read live global resilience settings on each request.** Rejected because a later settings edit would change historical controller and compaction behavior without a session event.

## Consequences

Controller capability failures can recover on a stronger model without changing worker assignments or later human turns. Compaction can use a dedicated high-context model and lower pressure threshold even when the controller's primary model remains local. Deployments must explicitly choose routes from their model directory and declare supported reasoning efforts; Graph does not infer that a larger model exists.

The policy extends the foundational [session Graph Mode](2026-08-17-session-graph-mode.md) and [compaction capability seam](2026-06-18-compaction-capability-seam.md) decisions without superseding their durable graph, concurrency, surface-replacement, or one-call reconstruction rules. The proposed [global Graph role templates](../../proposed/feature/2026-08-18-global-graph-role-templates.md) note remains active because its broader role-id confirmation and product-snapshot acceptance work is independent of this policy extension.

## Verification

Graph-domain tests reject invalid attempts, duplicate or purposeless routes, and invalid compaction ratios while accepting legacy omission. Controller tests prove downstream recovery precedence, turn-local escalation, return to the primary route on a later turn, exact compaction routing, and first-activation template snapshotting. Compaction-basic tests prove the session policy changes the single recorded summary route and generation settings. Client tests prove legacy settings normalization and revision-fenced persistence of fallback and compaction values.
