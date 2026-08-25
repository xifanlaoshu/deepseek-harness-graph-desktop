# Agent Note: Append-only Campaign plan revisions

Status: implemented

English | [中文](2026-08-24-append-only-campaign-plan-revisions.zh.md)

## Problem

A Campaign originally required its complete ordered Batch registry when the first Batch started. Analysis-driven work cannot always know that registry honestly: a bootstrap or inventory Batch may discover the real modules, dependencies, and acceptance scope only after execution. Rejecting later additions forced the controller either to invent speculative initial Batches or to run discovered work as unrelated Graphs, which lost Campaign progress, predecessor evidence, and one-task presentation.

## Decision

Campaign planning uses an immutable accepted prefix with audited suffix additions. The first submission records `planRevision: 1` and an empty extension list. After every registered Batch is `approved` or `approved_with_findings` and no Batch is active, one `intent=new` submission may carry `campaign.planExtension` while starting the extension's first Batch. The extension contains a non-empty ordered Batch suffix; `campaign.batchId` equals its first id.

New Batch ids are unique across the complete Campaign. Each dependency names an existing Batch or an earlier Batch in the same extension. An extension cannot insert, reorder, remove, rename, or replace any accepted Batch definition or execution. Existing ready Batches continue to start with `campaign.batchId` alone, and a Revision of an active Batch omits Campaign fields.

Graph Mode derives the audit record instead of trusting model-authored runtime evidence. The top-level submission reason becomes the extension reason. The last accepted Batch and its latest successful execution provide the source Batch, Run, and confirmed Settlement ids. The Host increments `planRevision`, appends one `GraphCampaignPlanExtension`, appends the Batch definitions, and admits the first new Graph and Run in the same provisional submission lifecycle.

Replay treats a historical Campaign event without plan metadata as revision one with no extensions. Each later Campaign event either preserves the complete plan metadata or advances it by exactly one extension whose `addedBatchIds` match the new contiguous suffix. The accepted prefix and extension history remain byte-stable while ordinary status and latest-execution fields advance under their existing validation rules.

The Campaign track displays the current plan revision and the plan revision that introduced each Batch. An appended Batch tooltip exposes the extension reason and source Batch, Run, and Settlement count without copying child transcripts.

## Verification

Domain coverage accepts a suffix over a historical revision-one Campaign, rejects non-tail history and mutation of prior executions, and validates source evidence. Controller coverage starts an initially complete Campaign, appends two discovered Batches in one plan revision, advances the second appended Batch without resending a plan, rejects extension while registered work remains, and pins the `graph_submit` plan-extension fields. Client coverage renders the plan revision, per-Batch introduction revision, and audit tooltip. The assembled Graph snapshot pins the controller policy through the real Headless composition.

## Alternatives considered

**Keep the full registry permanently immutable.** This protects replay but requires the controller to guess work before the analysis that defines it, or abandon Campaign tracking for discovered work.

**Allow arbitrary plan mutation.** Editing or inserting earlier Batches would change dependency meaning and invalidate accepted execution evidence. Append-only growth preserves the existing identities and ordering.

**Create a continuation Campaign or independent Graphs.** Execution could continue, but one user task would split across progress roots and lose native cross-Batch navigation and settlement lineage.

**Pre-register placeholder Batches.** Placeholder objectives and dependencies are speculative evidence. They also require later semantic edits, which conflict with immutable accepted definitions.

## Consequences

Analysis-driven Campaigns can remain one durable task while their verified scope grows. Replay still rejects every mutation of accepted history, and the extension event provides a stable causal record for UI and recovery. Growth occurs only at a completed registry boundary, so a controller cannot change the plan around pending or failed work; it must finish, repair, or obtain a user decision first. A genuinely unrelated objective still starts a new Campaign rather than extending the current one.
