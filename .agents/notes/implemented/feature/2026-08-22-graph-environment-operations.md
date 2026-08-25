# Agent Note: Graph Environment Operations

Status: implemented

English | [中文](2026-08-22-graph-environment-operations.zh.md)

## Problem

An engineering Worker normally runs with workspace-scoped write authority. Installing Maven, changing Docker resources, or acquiring a Host-level prerequisite may need network access, writes outside the workspace, or authority that the Worker allocation must not inherit. Treating that need as an ordinary implementation task either makes the task fail under `workspace-write` or grants a model an open-ended privileged Shell turn. The Graph also needs durable evidence that a human approved the exact effect which later nodes depend on.

## Decision

Graph adds an immutable `environment` task kind and a default non-controller Environment Operator role. An environment node names unique required capabilities from `network`, `host-package-install`, and `docker`; selects `workspace-write` or `danger-full-access`; and carries one to sixteen ordered operations. Every operation has a stable id, normalized description, exact command, and optional documentary rollback command. The node always resolves to a retained shared workspace, `manual` effect policy, and one attempt.

Graph Mode owns deployment admission through `environmentEnabled`, `environmentCapabilities`, and `environmentDangerFullAccess`. The controller policy first prefers repository-local wrappers and existing toolchains. When a Host prerequisite remains necessary, it creates one bounded environment node before every dependent engineering node, states measurable verification criteria, scopes Docker or package-manager effects to the project, and never hides environment mutation inside an engineer assignment.

The scheduler stops a ready environment node at a durable `environment` checkpoint. Its reason contains a stable JSON rendering of the complete capabilities, sandbox mode, commands, and rollback commands. An `approve-checkpoint` control resolves the checkpoint and authorizes only the next execution generation; a retry or later generation cannot reuse that authority. Rejection cancels the run. The controller follow-up presents the plan and waits without submitting a revision, executing commands, or claiming approval.

An approved environment node runs the immutable commands directly through `ctx.shell`, so no child model receives privileged interactive tools. Before each command Graph persists a stable external reference and pending Settlement, then flushes the session before the Shell call. Terminal evidence records exit, signal, timeout, abort, sandbox, truncation, and output byte counts without copying stdout or stderr into the parent log. A known nonzero result fails the node without retry. A missing or conflicting terminal observation stops for manual reconciliation. Rollback is never automatic and requires a separately approved environment node.

## Alternatives considered

**Inherit the parent sandbox into an environment Worker.** Rejected because the delegated model could choose commands other than the plan the user reviewed, and an isolated Worker must not escape its allocation.

**Use a generic approval prompt emitted by the child Shell tool.** Rejected because continuable children are non-interactive, the approval would live in the wrong session, and the immutable Graph would not carry the prerequisite that downstream work depends on.

**Install missing tools automatically during an engineer attempt.** Rejected because hidden Host mutation is neither replayable nor safely attributable after a crash.

**Run rollback automatically after failure.** Rejected because rollback is another external effect whose safety and current applicability require fresh human review.

## Consequences

Environment prerequisites become visible DAG nodes with exact human-approved effects and stable evidence. Ordinary analysis, engineering, review, and verification Workers remain confined by their declared workspace policy. Approval cannot be reused after generation changes, and uncertain effects cannot be silently repeated. Deployments must mount a Shell Provider and explicitly choose allowed capabilities; package-manager elevation, interactive installers, Docker daemon health, cross-platform command syntax, secret handling inside external commands, and rollback correctness remain Host or operator responsibilities.
