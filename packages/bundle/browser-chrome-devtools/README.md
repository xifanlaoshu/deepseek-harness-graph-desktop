---
description: "Browser automation profile bundle for users enabling Chrome DevTools MCP, visual testing, and workspace-scoped screenshot evidence."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-browser-chrome-devtools`

English | [中文](README.zh.md)

## Summary

An optional profile bundle that gives dsh agents local Chrome automation through Google's official [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). The package pins the upstream server, starts it as a child process without a shell, lets that server launch and reap an isolated Chrome process, and exposes its tools through [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.md).

The default configuration supports DOM snapshots and UID-based actions, screenshots returned as image blocks, coordinate clicks for vision models, console and network inspection, performance traces, and explicit `pageId` routing for concurrent agents. Tool names use the `mcp__chrome__*` namespace.

## Table of Contents

- [Install and start](#install-and-start)
- [Enable Qwen image input](#enable-qwen-image-input)
- [Config](#config)
- [Graph and concurrent agents](#graph-and-concurrent-agents)
- [Security](#security)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="install-and-start"></a>
## Install and start

Install the bundle into the Web profile from a published package:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-browser-chrome-devtools
```

From this repository checkout, install the workspace package instead:

```sh
pnpm dsh plugin --profile web add ./packages/bundle/browser-chrome-devtools
```

Start the Web profile after installation:

```sh
dsh web
```

No separate Chrome command is required in the default `managed` mode. The first browser tool call launches stable Chrome in a maximized visible window with a temporary profile. Disposing or restarting the bundle closes that Chrome process and removes the profile through the upstream MCP lifecycle. To select a specific installed browser executable, set `DSH_CHROME_EXECUTABLE_PATH` to its absolute file path before starting dsh; the bundle validates the path and does not fall back to a channel if it is invalid.

Set `DSH_CHROME_DEBUG_URL` before starting dsh to select `external` mode and attach to an operator-owned debugging endpoint instead. Chrome 136 and later require remote debugging to use a non-default user data directory. On Windows, the package includes a launcher for this optional mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\bundle\browser-chrome-devtools\scripts\start-chrome-debug.ps1
```

The equivalent direct launch is:

```powershell
& "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:LOCALAPPDATA\dsh\chrome-debug-profile" --no-first-run --no-default-browser-check
```

The external Chrome process remains operator-owned when the bundle stops. An installed profile may also override the `browser-chrome-devtools` row in its `cordis.patch.yml`; patch replacement requires restating the complete config.

<a id="enable-qwen-image-input"></a>
## Enable Qwen image input

Browser screenshots reach the selected model only when that exact model route declares image input. The Web provider form does not expose this field; add `input: [text, image]` to the existing Qwen model in `$DSH_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    local-qwen:
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      models:
        - id: qwen
          input: [text, image]
```

Keep the provider id, model id, endpoint, credential reference, capacity, and reasoning fields from the existing entry. A text-only declaration produces a model-capability diagnostic instead of silently discarding the screenshot. The llama.cpp server must also expose an OpenAI-compatible vision request path backed by the loaded multimodal projector.

<a id="config"></a>
## Config

[`cordis.patch.yml`](cordis.patch.yml) mounts this package with conservative local defaults. Every value is a validated plugin field:

| Field | Default | Behavior |
|---|---:|---|
| `serverName` | `chrome` | MCP tool namespace |
| `browserMode` | `managed` | Launch an owned Chrome process, or attach to `external` Chrome |
| `browserUrl` | `http://127.0.0.1:9222` | Chrome debugging endpoint used only in `external` mode |
| `chromeChannel` | `stable` | Installed Chrome channel selected in `managed` mode when `chromeExecutablePath` is empty |
| `chromeExecutablePath` | empty | Optional absolute path to an existing Chrome executable in `managed` mode; overrides the channel and is rejected in `external` mode |
| `headless` | `false` | Hide the managed Chrome window |
| `isolatedProfile` | `true` | Use a temporary profile that is removed after managed Chrome closes |
| `startMaximized` | `true` | Maximize the initial headed managed Chrome window |
| `toolCallTimeoutMs` | `120000` | Harness-side deadline for one browser call |
| `failOnStartupError` | `true` | Refuse activation when server startup or tool discovery fails |
| `experimentalVision` | `true` | Expose screenshot-coordinate actions |
| `pageIdRouting` | `true` | Require page-scoped calls to identify their tab |
| `performanceCrux` | `false` | Keep trace URLs away from the Google CrUX service |
| `usageStatistics` | `false` | Disable upstream usage reporting |
| `redactNetworkHeaders` | `true` | Redact sensitive response headers |
| `screenshotFormat` | `webp` | Reduce image bytes and model context cost |
| `screenshotQuality` | `80` | Default JPEG/WebP quality |
| `screenshotMaxWidth` | `1600` | Proportional screenshot width cap |
| `screenshotMaxHeight` | `1200` | Proportional screenshot height cap |

The wrapper also disables the upstream update check. Managed Chrome starts lazily on the first browser operation; MCP tool discovery does not open a window. Upgrades are explicit dependency changes, so the tool schema cannot change between local starts without a reviewed package update.

<a id="graph-and-concurrent-agents"></a>
## Graph and concurrent agents

The browser bundle has no Graph package dependency and owns no Graph run state. Graph workers receive the same browser tools through the ordinary Harness tool registry, so browser process startup, shutdown, and configuration remain replaceable independently of Graph Mode.

One live bundle serves its agents through one managed Chrome process. A delegated or parallel test must call `new_page` with a unique `isolatedContext` and then keep every action on page IDs returned for that context. Different isolated contexts do not share cookies or Web Storage; explicit `pageId` routing avoids the server's global selected-page state.

Browser tools that preserve file evidence accept a path relative to the calling agent's session workspace, such as `test-evidence/run-01/login.png`. A Graph worker in an isolated copy writes there and publishes the image through the existing artifact integration; it must not target the source workspace through an absolute path.

<a id="security"></a>
## Security

Use managed Chrome only for test accounts and test data. Its temporary profile is isolated from the ordinary Chrome profile, but browser tool results can still contain page text, console output, request data, and screenshots. In `external` mode, any local process that can reach the debugging port can control that Chrome instance; the launcher binds to `127.0.0.1`, and the plugin does not add authentication to a non-loopback endpoint.

The upstream MCP process receives its unrestricted-path option because one connection is shared by several agents and therefore cannot safely advertise a single static MCP root. The Harness MCP bridge confines every browser filesystem-path argument to the exact calling agent's canonical session workspace and sends that same checked target, so relative paths use the agent workspace and cannot be re-resolved through a swapped symlink. It rejects missing caller context, outside paths, and symlink escapes before dispatch. A real-server test compares the pinned discovered tool schemas with the guarded argument list, so a newly exposed path argument fails verification. The upstream process never receives a rejected path.

<a id="dev-note"></a>
## Dev Note
No invariant companion is published because Cordis owns prompt-registration and MCP-child disposal, while the registries own runtime checks.

None.

<a id="model-experience"></a>
## Model Experience

### Browser automation context

#### What the model sees

The model receives the discovered `mcp__chrome__*` tool schemas, a short system-prompt section, and browser tool results retained in conversation history. The prompt directs delegated or parallel work to create a unique isolated context, prefer accessibility snapshots and stable element UIDs, use screenshots for visual assertions, save file evidence through workspace-relative paths, preserve explicit page identity, inspect relevant console or network failures, and claim success only from observed evidence. The generic MCP client stores supported screenshot blocks as durable Harness image attachments before the next model request.

#### Token effect

The full discovered tool catalog and the short guidance section are present on every request while the bundle is active. Snapshot text, tool arguments, text results, and durable image references remain in history until compaction; WebP and screenshot dimension caps reduce dynamic image payloads.

#### KV Cache effect

The system-prompt section is stable for one `serverName`, and the tool catalog stays prefix-stable while the pinned server advertises unchanged schemas. Newly appended browser results follow the reusable prefix; changing the server namespace or upgrading the pinned server may invalidate reuse from the first changed prompt or schema token.

## Known Limitations and Deferred Work

- **Managed startup is lazy** — dsh activation proves the pinned MCP server and tool catalog are available; Chrome installation or launch failures surface on the first browser operation.
- **Concurrent agents still choose their context names** — isolated contexts and `pageIdRouting` provide the mechanism, but the upstream server does not allocate names or serialize conflicting actions for Harness agents.
- **Visual accuracy belongs to the selected model** — screenshots provide pixels, while coordinate selection and visual assertions depend on the local Qwen projector, quantization, prompt, and image budget.
- **Chrome DevTools MCP officially supports Google Chrome and Chrome for Testing** — other Chromium browsers may work but are outside the upstream support promise.
