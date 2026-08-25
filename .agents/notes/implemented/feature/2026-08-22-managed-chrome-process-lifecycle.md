# Agent Note: Harness-managed Chrome process lifecycle

Status: implemented

English | [中文](2026-08-22-managed-chrome-process-lifecycle.zh.md)

## Problem

Harness agents need a browser execution path that can operate a developer's local test page, return screenshots to an image-capable model, and expose debugging evidence without making Harness maintain another browser automation protocol. Requiring an operator to start a debugging browser separately leaves startup, failure recovery, and teardown outside the plugin lifecycle. A browser automation process also has powerful ambient authority, so it must not reuse the user's ordinary Chrome profile or become part of Graph's orchestration implementation.

## Decision

`@deepseek-ai/dsh-browser-chrome-devtools` is an optional profile bundle over the generic MCP client. It pins Google's `chrome-devtools-mcp` package, resolves the installed executable from the bundle's dependency tree, and starts it through `process.execPath` without a shell or package-manager lookup. The default `managed` mode lets that MCP child launch stable Chrome lazily on the first browser operation. Headed Chrome starts maximized with an upstream-owned temporary user data directory, and upstream closes the browser and removes that directory when Harness disposes the MCP child.

The optional `external` mode connects the MCP server to a configured HTTP Chrome DevTools Protocol endpoint. Setting `DSH_CHROME_DEBUG_URL` selects that mode in the shipped bundle patch. An attached Chrome process remains operator-owned when Harness stops; this mode exists for persistent test profiles and separately managed environments, not as the default lifecycle.

The bundle enables experimental vision actions and page-id routing because one Harness Host can serve concurrent agents through one MCP server. DOM snapshots and UID actions remain the preferred interaction path; screenshots provide visual evidence and coordinate clicks are a fallback. Delegated or parallel tests create a page with a unique upstream `isolatedContext` and keep subsequent actions on that context's page IDs. The model prompt states those requirements and demands observed page, console, or network evidence before a passing result.

The browser bundle imports no Graph package and owns no Graph run state. Graph workers consume its tools through the ordinary Harness registry. Browser lifecycle, transport, and configuration therefore remain independently replaceable, while Graph is responsible only for deciding when a browser-verification task is required.

The wrapper keeps upstream usage statistics, update checks, performance CrUX requests, unrestricted paths, and unredacted sensitive network headers disabled by default. WebP screenshots and dimension caps bound ordinary model payloads. Every deployment-varying choice is a validated plugin config field, while the profile patch supplies the shipped defaults.

Screenshot content follows the existing MCP image path: the MCP client validates and stores supported image blocks through the attachment service, and the exact selected model receives them only when its route declares image input. The browser wrapper does not infer multimodal support from a model name or endpoint.

## Verification

Package tests pin both process modes, config validation, executable resolution, exact upstream arguments, prompt registration, and bundle manifest parsing. A real-server integration test starts the pinned MCP executable over stdio and verifies that its browser tools register without a shell. The assembled keyless snapshot pins the model-visible isolation instruction and real tool catalog. A local lifecycle smoke invokes the managed server against installed Chrome and verifies that disposing Harness terminates the owned browser process.

## Alternatives considered

**Implement browser actions and process management directly with Playwright or Puppeteer** — rejected because Harness would own navigation, selectors, screenshots, console and network inspection, Chrome discovery, profile cleanup, and protocol compatibility already maintained by the Chrome DevTools team. The wrapper keeps only Harness-specific composition and policy.

**Use `microsoft/playwright-mcp`** — viable for accessibility-tree automation, but the Chrome DevTools server fits the local CDP, console, network, and performance-debugging requirement directly and exposes coordinate tools for a multimodal model. The generic MCP client leaves Playwright MCP available as a separate user composition.

**Run `npx chrome-devtools-mcp@latest` from YAML** — rejected because it requires PATH and shell-platform handling, performs package resolution at each deployment, and allows an upstream release to change the tool catalog between starts. The pinned dependency and `process.execPath` make startup deterministic.

**Keep Chrome permanently operator-owned** — rejected as the default because it makes a routine agent capability depend on an undocumented process, port, profile, and cleanup sequence. External attachment remains explicit for environments that need it.

**Attach to the ordinary Chrome profile** — rejected because the automation process could inspect authenticated personal pages and Chrome 136+ ignores remote-debugging switches against the default data directory. Managed mode uses a disposable profile; external-mode documentation requires a dedicated test profile.

**Put Chrome lifecycle code in Graph Mode** — rejected because ordinary Harness agents need the same browser capability and process ownership is independent of task orchestration. A browser bundle can be installed, replaced, restarted, or omitted without changing Graph.

## Consequences

Harness gains maintained Chrome automation, multimodal screenshot results, and quiescent browser cleanup with a small owned implementation. Users normally start only dsh; the first browser call opens Chrome, while startup failures surface at that lazy operation rather than at MCP tool discovery. The bundle adds the upstream server's dependency weight and exposes a large tool catalog when enabled. One live bundle still shares one Chrome process, so concurrent agents must choose distinct isolated-context names and explicit page IDs. External mode intentionally gives up automatic Chrome cleanup.
