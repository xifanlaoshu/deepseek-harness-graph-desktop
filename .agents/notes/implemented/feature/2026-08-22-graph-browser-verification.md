# Agent Note: Graph Browser Verification

Status: implemented

English | [中文](2026-08-22-graph-browser-verification.zh.md)

## Problem

The optional [Chrome DevTools browser bundle](2026-08-22-managed-chrome-process-lifecycle.md) gives a Harness agent page, screenshot, console, and network tools, but Graph planning does not identify browser acceptance as a distinct responsibility. A controller can omit live UI verification, assign it before an integrated build exists, or leave a general Verifier without the target origin and visual evidence requirements. Concurrent browser workers can also interfere through the shared debugging browser even though page-id routing prevents implicit page selection.

## Decision

The default Graph team includes an enabled `browser-tester` role with a parallel limit of one. Its prompt restricts work to the assigned target origin and acceptance criteria, requires one explicit page id, prefers page snapshots and element identifiers for ordinary actions, and uses screenshots for visual assertions when the selected model route declares image input. It inspects relevant console errors and failed network requests after critical actions and publishes a schema-valid verification decision with actionable issues. It never enters real secrets, performs destructive production actions, or closes a page it did not create.

The controller policy places browser verification after the integrated runnable build for user-facing Web work and explicit browser-test requests. Each browser node receives the exact target origin, critical flows, viewport and locale assumptions, and measurable DOM and visual assertions. A reachable target supplied by the user is treated as existing test infrastructure rather than a reason to schedule an environment mutation. An unreachable target is reported as an environment blocker instead of a product defect.

Graph Mode does not implement another browser protocol. A browser Worker inherits tools from the session composition. With `@deepseek-ai/dsh-browser-chrome-devtools` enabled, detailed page, console, and network evidence remains in the durable child session; screenshot results follow the existing attachment path to an image-capable model; and only the structured accepted result returns to the parent Graph run.

File evidence uses paths relative to the browser Worker's session workspace. The generic MCP bridge canonicalizes every configured browser filesystem-path argument, checks it against that exact workspace, and sends the same canonical target to prevent process-cwd drift and post-check symlink resolution. Missing caller context, outside paths, and symlink escapes fail before dispatch. The pinned real-server catalog test requires every discovered path-like tool argument to be guarded. An isolated Graph workspace captures those files as artifacts and materializes them through the integration flow, so a Worker never writes through an absolute source-workspace path.

## Alternatives considered

**Implement browser actions inside Graph Mode.** Rejected because navigation, selectors, screenshots, console observation, network observation, and Chrome lifecycle already belong to the maintained DevTools MCP capability.

**Fold browser testing into the generic Verifier role.** Rejected because browser work needs explicit target, visual, origin-safety, and page-ownership instructions as well as a tighter concurrency limit.

**Let the controller operate the browser directly.** Rejected because raw test evidence would enter the parent controller trajectory, bypass node-level retries and decisions, and couple intent classification to a long-running test flow.

## Consequences

New Graph sessions can schedule an auditable browser acceptance node without changing the durable task vocabulary. DOM-only checks remain available to text models, while screenshot understanding requires an exact model route that declares image input. Screenshot files remain durable project evidence after isolated-workspace artifact integration without granting cross-session filesystem access. The role-level parallel limit prevents concurrent default browser workers inside one Graph configuration but does not provide cross-session page ownership; deployments with concurrent Graph sessions still need isolated browser processes or an external allocation policy. Operators remain responsible for enabling the browser bundle and securing its target Chrome and test accounts.
