# Agent Note: User-operated Graph cancellation

Status: proposed

English | [中文](2026-08-18-user-operated-graph-cancellation.zh.md)

## Problem

The Graph scheduler runs outside the controller turn. The parent composer Stop action therefore owns only the controller's current turn, Graph-created one-shot child sessions are read-only, and `/graph off` changes later input routing without stopping an active run. A user cannot stop one hung or unnecessarily expensive worker, or cancel the whole run, without replacing the graph revision or shutting down the Host.

Graph Mode already aborts work when a revision supersedes a run or the plugin is disposed, but it exposes no user-addressed control operation. Reusing a child-session interrupt without Graph ownership would also report the interruption as an attempt failure; the retry policy could immediately create another worker and defeat the user's intent.

## Proposal

Graph Mode will expose one Host-owned control operation shared by the Graph panel, Graph-origin child-session view, human command path, and controller tool. Every request will address the parent session, graph id, revision, and run id. A node request will also carry the node id, attempt id, and observed attempt state so a stale page cannot cancel newer work.

The operation will support `cancel-run` and `cancel-node`. `cancel-run` will abort every active attempt, prevent queued or pending nodes from starting, mark all nonterminal nodes canceled, and finish the run as canceled. `cancel-node` will abort only the addressed active attempt, mark that node canceled by the user, apply the existing dependency rules to its successors, and allow independent branches to finish. Required descendants will cancel, conditional descendants without satisfied inputs will skip, and the run will finish as canceled after remaining independent work settles.

The controller may invoke the same operation only after classifying an explicit human request as `control`; an ordinary requirement adjustment continues to create a graph revision. Cancellation never creates a replacement graph or retries work by itself. A later retry, repair, or replan requires another explicit user input and a new immutable revision so the canceled run remains inspectable.

## Cancellation ownership and evidence

Graph Mode, rather than the generic session runtime, will own aborting the child, releasing admission permits, changing node and run phases, and settling external coordination. A canceled attempt will record a distinct user-cancellation result with its time, entry point, and optional public-safe reason. It will not become `ready`, consume the automatic failure-retry path, or enqueue another worker under `maxAttempts`.

If the attempt already claimed LoopX work, Graph Mode will write non-executable blocker evidence with a terminal-settlement signal that outlives the worker abort. A successful control response waits for child disposal, permit release, the terminal run snapshot, and attempted coordination settlement. A settlement failure remains durable evidence and never turns the canceled node back into executable work.

Cancellation and completion may race. The first accepted terminal transition wins: a late cancellation returns an already-terminal result without overwriting a completed output, while a cancellation accepted first prevents a late child result from reviving the attempt. Repeating the same addressed operation is idempotent.

The session event stream will retain the control request and resulting run snapshot. The Graph projection, exported session, and replay will therefore show who or what initiated cancellation, when it happened, the addressed attempt, and any LoopX settlement error without depending on process-local abort state.

## Browser controls

The active-run header in the Graph panel will provide a confirmed Stop run action with the run identity and active-attempt count. A running execution node will provide Cancel node in the node dialog described by the [dual graph design and execution views decision](../../implemented/feature/2026-08-18-dual-graph-design-and-execution-views.md). Buttons become disabled as soon as a request starts and settle to the authoritative projected result rather than optimistic local state.

A Graph-origin one-shot child session will remain transcript-read-only, but its header will expose Cancel node while the exact parent run and attempt are still active. That action will address the parent Graph control operation; it will not call generic `session.cancel` or pretend that the one-shot child supports follow-up messages. Ordinary continuable-subagent Stop behavior remains unchanged.

## Alternatives considered

**Call generic session cancellation from both pages.** This could stop a model request, but it bypasses Graph ownership of retries, admission permits, run phases, successor outcomes, and LoopX settlement.

**Treat `/graph off` as cancellation.** Mode activation controls how future human input is routed. Coupling it to execution cancellation would make a settings action destructively stop work and would still provide no node-level operation.

**Submit an empty or replacement revision to stop work.** Revision replacement already aborts an older run, but it also starts new work, requires controller participation, and records a design change where the user requested an execution control action.

**Map a stopped child to ordinary attempt failure.** Existing retry policy may immediately start another child. User cancellation requires a distinct terminal cause that suppresses automatic retries.

## Acceptance criteria

- A user can cancel the active Graph run from the parent session's Graph panel without restarting the Host or submitting a replacement revision.
- A user can cancel the exact running node from both its execution evidence drawer and its Graph-origin child-session page.
- Every entry point reaches one Graph-owned, precisely addressed, idempotent control operation and reports stale or already-terminal targets without affecting newer attempts.
- Run cancellation prevents every nonterminal node from starting again and records one terminal canceled run.
- Node cancellation stops only the addressed attempt, applies durable successor outcomes through the existing dependency rules, and permits independent branches to settle.
- User cancellation has a distinct recorded cause and never enters the automatic failure retry path, regardless of remaining `maxAttempts`.
- A completion/cancellation race preserves exactly one terminal outcome and never replaces successful output after completion wins.
- Every claimed LoopX item receives attempted terminal blocker settlement before cancellation reports completion; settlement failure remains visible in durable Graph evidence.
- Replay, export, the Graph projection, and the child-session link retain the cancellation source, time, target, and resulting node and run phases.
- Product-visible coverage exercises run cancellation, node cancellation from both browser surfaces, stale controls, completion races, retry suppression, dependent-node outcomes, independent branches, and LoopX compensation through the assembled Web application.

## Risks

Cancellation cannot roll back filesystem writes, subprocess side effects, or external mutations already performed by a child, so the UI must describe it as stopping future execution rather than undoing completed effects. An unresponsive provider or failed LoopX writeback can delay full settlement and requires a bounded error state rather than a false success. Durable control events and addressed Host operations add schema and authorization surface; stale child pages, controller mistakes, and repeated gestures must not gain authority over a newer run.
