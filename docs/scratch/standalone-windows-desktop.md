---
description: "Proposed migration and qualification plan for a self-contained Windows Graph desktop distribution."
owner: "Desktop fork maintainers"
created: "2026-09-29"
expires: "2026-10-29"
promotion-target: "apps/desktop/README.md and component-owned READMEs"
---

# Standalone Windows Graph desktop plan

English | [中文](standalone-windows-desktop.zh.md)

## Summary

This proposed distribution lets users install Graph orchestration and browser testing without a separate development environment. The installer contains the application runtime, native LoopX control plane, and an isolated automation browser. Model access still requires a configured service or compatible local hardware and model weights. This document defines development and qualification work; it does not assert that an installer has passed acceptance.

## Table of Contents

- [Delivery scope](#delivery-scope)
- [Migration ownership](#migration-ownership)
- [Runtime composition](#runtime-composition)
- [Lifecycle and security](#lifecycle-and-security)
- [Development sequence](#development-sequence)
- [Acceptance](#acceptance)
- [Dev Note](#dev-note)

<a id="delivery-scope"></a>
## Delivery scope

The first qualification target is Windows 11 x64. Windows 10 22H2 x64 needs a separate compatibility run and does not regain operating-system security support through this application. Windows 7/8, 32-bit Windows, ARM emulation, Server, S mode, and unrestricted enterprise-policy compatibility are not promised.

The proposed default requires no user installation of WSL, Node, Python, pnpm, LoopX, or Chrome. Build tools belong to the developer machine, not the installed application. Git operations, Docker workloads, Maven projects, and local inference servers remain distinct capabilities: their runtimes must be bundled and qualified or declared explicitly before tasks require them. A desktop installer cannot provide every project's arbitrary external environment.

<a id="migration-ownership"></a>
## Migration ownership

The integration uses the official [desktop release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) and preserves the complete local fork, including unpushed Session-format work. A dedicated worktree separates development from the running Web service. An existing repository fork is not renamed or overwritten without a user choice.

| Owner | Required preserved behavior |
|---|---|
| Graph and Client | Role templates, model and reasoning settings, global child limits, controller resilience, campaign batches, revision relationships, node evidence, and child-session navigation |
| Coordination | Stable work identity, activation isolation, eight protocol operations, current fencing tokens, terminal-result reuse, idempotent progress, and restart reconciliation |
| Session | Released historical schemas remain immutable; the current format and adjacent migrations retain explicit version ownership |
| Workers and resources | Workspace isolation, artifact transport, concurrency limits, model capacity observations, backoff, and scheduler ownership |
| Browser and MCP | Continuous actions, multimodal screenshots, evidence path validation, timeout policy, and owned browser cleanup |
| Learning material | Existing bilingual course and documentation pairing records |

Committed changes and the remaining working-tree diff are inventoried separately. Credentials, signing material, machine endpoints, sessions, LoopX databases, browser profiles, caches, and model weights are excluded from source migration and distributable defaults. Existing user data is imported only through an explicit backup-and-migration operation, never by copying active leases into a new runtime.

<a id="runtime-composition"></a>
## Runtime composition

The [desktop runtime](../../apps/desktop/README.md) already contains Electron and primary Node/Python/pnpm payloads. Packaging adds locked components to this existing mechanism rather than introducing a second application launcher. All application launches continue through supported `dsh` profiles.

| Component | Proposed packaging and qualification |
|---|---|
| Harness and Graph | Production dependency closure includes every profile plugin; first activation works without npm downloads |
| LoopX | Fixed native Windows version, private module resources, absolute bundled interpreter paths, and complete registry provisioning; no WSL fallback |
| Browser | Fixed Chrome for Testing or qualified redistributable Chromium build, explicit executable path, private profile, and no first-use download |
| MCP | Pinned server dependency and tools supplied from the application closure, preserving existing screenshot and workspace restrictions |
| Mutable data | Separate fork home for sessions, settings, LoopX registry, evidence, and imported workspaces; not inside installed resources |

The [LoopX installation guide](https://github.com/loopx-project/loopx/blob/main/docs/guides/installing-loopx.md) describes native Windows installation. That does not qualify the chosen release against the Harness CLI protocol. Real native tests must establish compatibility before bundling it. A local-only SQLite coordinator is an explicit alternative product mode, not an automatic fallback or a replacement for all LoopX capabilities.

<a id="lifecycle-and-security"></a>
## Lifecycle and security

Each control-plane process and automation browser has an application owner. Cancellation, shutdown, and failed startup wait for owned process-tree termination; unrelated user browsers remain running. Browser automation cannot access the privileged Electron application through a global debugging endpoint. Evidence remains constrained to approved workspace roots.

The fork has its own app identity, installation directory, protocol scheme, home, cache, signing publisher, update feed, and mandatory-update policy. An official update must never replace custom Graph code. Locked component versions, hashes, source references, SBOM, licenses, and required NOTICE files accompany the distribution. Component self-updaters remain disabled; application releases update qualified components together.

LoopX goal and peer identifiers are created idempotently for the user's project. Startup health checks expose component failures before a graph starts. A failed coordinator does not silently become a different provider. Crash recovery reconciles durable work before dispatching children; it never infers success from a missing process.

<a id="development-sequence"></a>
## Development sequence

Development is split into bounded modules for lower-tier agents, with Astra reviewing architecture and safety decisions. Each module includes its owning documentation and focused valid and invalid cases.

1. Preserve the local fork and merge the pinned official release. Review format lineage and regenerate catalogs without rewriting committed historical generations.
2. Add an explicit bundled-browser executable setting and fork update-source validation. Validate the two modules independently.
3. Qualify a fixed native LoopX release against the shared coordination suite, then implement payload preparation, provisioning, and owned process-tree cleanup.
4. Lock and prepare the browser payload with redistribution notices. Add both payloads to package inventory, signing, integrity checks, and offline activation.
5. Wire a dedicated desktop profile and independent data identity. Validate model routing, Graph UI, controller fallback, compaction, and historical browsing.
6. Build the confirmed complete installer version and run clean-machine acceptance. Publish only after signing, licensing, and update ownership are resolved.

<a id="acceptance"></a>
## Acceptance

Qualification uses a fresh ordinary-user Windows VM without WSL, developer Node/Python/pnpm, or an installed Chrome. Build-host tests alone cannot establish this result.

- Offline installation, startup, component health, local browser actions, and screenshot evidence succeed without downloading dependencies. Cloud model calls still need network access and user credentials.
- Graph creates and executes a real plan, honors a child limit of one, preserves revision and batch relationships, and resumes correctly after restart.
- Native coordination rejects stale fencing tokens, reuses accepted terminal results, reconciles expired leases, and contains broker crash, cancellation, and repeated settlement.
- Browser tests cover normal and failing workflows, console/network evidence, Chinese and spaced paths, port conflicts, and process cleanup.
- Data tests cover historical-session import, adjacent migration, child-session browsing, and immutable source history. Existing sessions are tested on backups.
- Installer tests cover install, upgrade failure, rollback, uninstall, low disk, integrity rejection, and absence of secret material. Uninstall and update policies explicitly preserve or remove the documented data sets.

<a id="dev-note"></a>
## Dev Note

This proposal expires on 2026-10-29. The user confirmed `xifanlaoshu/deepseek-harness-graph-desktop` as the repository and `0.2.0-rc.2-graph.1` as the complete installer version on 2026-09-30. Product identity, signing, browser redistribution, native LoopX compatibility, and clean-VM results remain release decisions or qualification requirements. The current Web service is outside this development worktree and must not be restarted by migration tasks.
