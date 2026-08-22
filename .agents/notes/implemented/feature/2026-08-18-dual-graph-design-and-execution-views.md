# Agent Note: Dual graph design and execution views

Status: implemented

English | [中文](2026-08-18-dual-graph-design-and-execution-views.zh.md)

## Problem

The Graph panel must distinguish the controller-authored task definition from runtime evidence without rendering the same topology twice in one long workspace. Node evidence and controls are too dense for a permanent sidebar, but hiding them behind child-session navigation makes routine inspection slow.

## Decision

The session Graph workspace has two primary tabs. Design contains only the selected immutable revision as a read-only left-to-right Cytoscape graph. Execution contains the selected run graph on the left and a scrollable node summary list on the right; each summary identifies phase, effective route, concise result, and elapsed time.

Selecting an Execution graph node or summary opens a modal with the complete controller definition, output schema, effective budget and route, attempts, outputs, artifacts, operation journal, Settlements, checkpoints, terminal evidence, child-session navigation, and every state-applicable node control. Task modification, cancellation, retry, resume, skip, assignment override, and substitute-output actions remain inside that modal so the graph retains most of the workspace.

Role configuration is a settings action in the Graph header rather than a third primary tab. Its dialog keeps the existing disposable draft and explicit save semantics. The workspace, graph, summaries, modal, buttons, inputs, selects, and text areas use Harness theme tokens, icon components, control heights, borders, radii, spacing, and focus states.

Only the active tab mounts a Cytoscape instance. Run-evidence and selection updates preserve the active viewport; selecting another immutable revision creates a new layout and fitted viewport. Browser-derived positions remain presentation state and never enter the session log.

## Verification

Client behavior tests pin the two-tab navigation, Design-only graph, Execution split layout, node-modal evidence and controls, settings persistence, stale-command protection, viewport lifetime, and teardown. The assembled Web profile is exercised with a real projected graph to verify both tabs, the node modal, role settings, responsive layout, and Harness-theme rendering.

## Alternatives considered

**Keep two vertically stacked canvases.** This permits simultaneous comparison, but repeats topology, reduces usable graph height, and forces node records and evidence below the fold.

**Keep one decorated canvas.** A single canvas uses less space, but it conflates controller intent with one execution and cannot give design and runtime fields independent visual priority.

**Keep complete node details in a permanent sidebar.** Persistent details avoid a modal transition, but they take width from every graph even when the user is scanning topology. The summary list preserves execution overview while the modal gives dense evidence and controls enough space.

**Copy complete child transcripts into the modal.** Rejected because the child session is the authoritative record for messages and tool events. The modal exposes the child-session link and graph-owned evidence only.

## Consequences

Design intent and runtime state have clear, stable homes, the Execution graph retains most horizontal space, and dense controls no longer compete with topology. Users trade simultaneous Design/Execution comparison for a deliberate tab switch, and opening complete node evidence requires one selection. Cytoscape viewport state is preserved within a tab lifetime but is not mirrored across tabs.
