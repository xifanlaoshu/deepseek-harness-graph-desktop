# Agent Note: Local Chrome automation through a pinned DevTools MCP bundle

Status: implemented

English | [中文](2026-08-22-local-chrome-devtools-browser-bundle.zh.md)

## Problem

Harness agents need a browser execution path that can operate a developer's local test page, return screenshots to an image-capable model, and expose debugging evidence without making the Harness own a second browser automation protocol. A local debugging browser also contains powerful ambient authority, so the composition must keep it separate from the user's ordinary Chrome profile and avoid silently widening data or filesystem access.

## Decision

`@deepseek-ai/dsh-browser-chrome-devtools` is an optional profile bundle over the generic MCP client. It pins Google's `chrome-devtools-mcp` package, resolves the installed executable from the bundle's dependency tree, and starts it through `process.execPath` without a shell or package-manager lookup. The server connects to a configured HTTP Chrome DevTools Protocol endpoint; the default is loopback port 9222.

The bundle enables experimental vision actions and page-id routing because one Harness Host can serve concurrent agents through one MCP server. DOM snapshots and UID actions remain the preferred interaction path; screenshots provide visual evidence and coordinate clicks are a fallback. The model prompt names that ordering and requires observed page, console, or network evidence before a passing result.

The wrapper keeps upstream usage statistics, update checks, performance CrUX requests, unrestricted paths, and unredacted sensitive network headers disabled by default. WebP screenshots and dimension caps bound ordinary model payloads. Every deployment-varying choice is a validated plugin config field, while the profile patch supplies the shipped defaults.

Chrome runs outside the Harness lifecycle in a dedicated user data directory. The Windows launcher binds its debugging endpoint to `127.0.0.1` and never reuses the default Chrome profile. The MCP server is a child of its Cordis plugin and is disposed with it; Chrome remains operator-owned.

Screenshot content follows the existing MCP image path: the MCP client validates and stores supported image blocks through the attachment service, and the exact selected model receives them only when its route declares image input. The browser wrapper does not infer multimodal support from a model name or endpoint.

## Verification

Package tests pin config validation, executable resolution, exact upstream arguments, prompt registration, and bundle manifest parsing. A real-server integration test starts the pinned MCP executable over stdio and verifies that its browser tools register without a shell. The existing MCP image suites pin conversion of image results into durable attachments and text-only model diagnostics.

## Alternatives considered

**Implement browser actions directly with Playwright or Puppeteer** — rejected because Harness would own navigation, selector, screenshot, console, network, lifecycle, and protocol compatibility code already maintained by the Chrome DevTools team. The wrapper keeps only Harness-specific composition and policy.

**Use `microsoft/playwright-mcp`** — viable for accessibility-tree automation, but the Chrome DevTools server fits the local CDP, console, network, and performance-debugging requirement directly and exposes coordinate tools for a multimodal model. The generic MCP client leaves Playwright MCP available as a separate user composition.

**Run `npx chrome-devtools-mcp@latest` from YAML** — rejected because it requires PATH and shell-platform handling, performs package resolution at each deployment, and allows an upstream release to change the tool catalog between starts. The pinned dependency and `process.execPath` make startup deterministic.

**Attach to the ordinary Chrome profile** — rejected because the debugging process could inspect authenticated personal pages and Chrome 136+ ignores remote-debugging switches against the default data directory. A dedicated profile makes the authority explicit and disposable.

## Consequences

The Harness gains maintained Chrome automation and multimodal screenshot results with a small owned implementation. The bundle adds the upstream server's dependency weight and exposes a large tool catalog when enabled. Operators must start and secure Chrome separately, declare image capability for local vision models, and coordinate tab ownership across concurrent agents even though page-id routing prevents implicit global-page selection.
