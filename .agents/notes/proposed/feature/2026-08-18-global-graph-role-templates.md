# Agent Note: Global Graph role templates with session snapshots

Status: proposed

English | [中文](2026-08-18-global-graph-role-templates.zh.md)

## Problem

Graph role definitions currently live only in each session's durable `GraphModeConfig`. A user who changes role prompts, models, reasoning selectors, or team membership must repeat that editing in every new session. Making sessions read live global settings would remove repetition but would also let a later settings change alter historical session behavior and replay.

## Proposal

The main Settings UI will add a Graph Roles section backed by a versioned `graph-mode` settings namespace. It will edit a reusable template containing the complete ordered role catalog: stable id, label, description, controller flag, enabled state, default provider/model selection, reasoning selector, role prompt, and role parallelism. Exact-model limits that belong to those selections will be edited with the template so its OOM safeguards survive copying.

The editor will support adding, duplicating, reordering, enabling, disabling, and deleting worker roles. It will require exactly one enabled controller and at least one enabled worker, reject duplicate or unsafe ids, and prevent removal of the last controller or worker. The controller remains a role definition rather than a special uneditable form; changing which role is controller must still leave exactly one enabled controller. Model selection uses the shared model directory, while reasoning remains free-form because providers accept different values. A reset action restores the built-in software-engineering team only after explicit confirmation.

Global settings are defaults, not a live parent configuration. When Graph Mode is activated in a session that has no prior `graph/config` event, the Host resolves the current global template, validates it, combines it with built-in scheduler defaults, and appends one complete `GraphModeConfig` snapshot to that session before the controller runs. From that commit onward, the session reads only its own `graph/change` events. Later global edits do not append session events, replace role definitions, change model routing, or affect replay for any session that already owns a snapshot.

The existing session Graph settings remain an explicit override editor for the current session. Applying the latest global template to an existing session, if offered, will require a separate user action that previews role additions, removals, model changes, and references from existing graph revisions before appending a new session configuration. It will never happen as a side effect of opening Settings or editing the global template.

A session created before a global edit but never activated in Graph Mode owns no Graph role history; its first activation may use the then-current template. Once any Graph configuration has been committed, the historical isolation rule applies permanently. Import, replay, and recovery do not require the global settings document to exist because the complete role snapshot remains in the session log.

## Current implementation

The Host owns the versioned `graph-mode` namespace and snapshots a validated template on first activation. The Plugins settings page provides a session-independent graphical editor for role creation, duplication, ordering, editing, enablement, deletion, prompts, model selection, free-form reasoning selection, role and model parallelism, global admission limits, and a two-step built-in-team reset. Writes use the observed namespace revision; a conflict preserves the draft and requires an explicit reload. Component, assembled-client, and Host integration tests cover editor operations, model-directory loading, accepted and conflicting writes, invalid templates, read-only deployments, unavailable settings, and the before/after session snapshot rule. Browser-visible snapshot coverage and stronger confirmation for changing a stable role id remain required before this note can move to implemented.

## Alternatives considered

**Resolve global role settings on every controller request.** This would make global edits immediately visible, but it would silently change the model-visible role catalog and routing of historical sessions without a session event, violating replay and auditability.

**Store roles only in global settings.** A single copy avoids duplication, but exported or restored sessions would depend on mutable machine-local state and could not reconstruct which prompts and models governed earlier work.

**Copy the global template into every newly created session.** This gives strict creation-time defaults, but it writes Graph configuration into sessions that never activate Graph Mode. Snapshotting on first activation preserves historical behavior at the first relevant commit while avoiding unrelated session events.

**Keep a fixed number of built-in roles.** This is simpler to validate, but it prevents domain-specific teams and forces unused roles to remain part of the controller catalog.

## Acceptance criteria

- The main Settings UI contains a Graph Roles section that edits a durable global template independently of any open session.
- The template editor supports role creation, duplication, ordering, enablement, deletion, prompt editing, model selection, free-form reasoning selection, and per-role parallelism.
- Validation requires exactly one enabled controller, at least one enabled worker, stable unique safe ids, non-empty role text, valid model selections, and positive parallel limits.
- First Graph activation without an existing session configuration appends one complete validated snapshot before a controller request can observe Graph Mode.
- A session with a committed Graph configuration never reads or applies later global-template changes automatically.
- Session replay, export, inspection, and recovery reconstruct the role catalog, prompts, models, reasoning selectors, and limits without access to current global settings.
- Current-session editing remains separate from global-template editing; any explicit apply-to-session operation previews changes and appends a durable session event.
- Concurrent settings editors use the settings namespace revision and report conflicts without discarding either editor's draft.
- Product-visible coverage creates sessions before and after a global edit and proves that only a session taking its first Graph snapshot afterward receives the new template.

## Risks

Two visible editors for similar fields can confuse global defaults with current-session overrides; each page must name its scope and show whether a session owns a snapshot. Removing or renaming role ids in the global template can make future imported graph definitions invalid, so ids require stronger confirmation than labels. A configured model may later disappear from the model directory; the settings page must preserve and mark the unavailable value rather than silently replacing it. Copying complete prompts into each participating session increases log size but is required for deterministic replay and historical isolation.
