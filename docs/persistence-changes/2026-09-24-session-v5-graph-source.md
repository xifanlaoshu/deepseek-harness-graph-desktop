---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-session-v5-graph-source

English | [中文](2026-09-24-session-v5-graph-source.zh.md)

## Summary

Advances the Session writer to V5 for Graph-owned message attribution and records the accompanying Graph event and subagent-capacity additions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-session-v5-graph-source
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "24a14b470420c6d7a396efce26e45a98e5ae0324c5b5894568f41ecab167568d"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "6a56f79c9ce197c5358c30de62cdd4592506847ea8b495ae753e20ddfcedd47d"
    decision: version-bump
  - root: "event:graph/campaign"
    previous: null
    after: "70f4785863b253a92003884deee8f0cf342ca2ea1722e795362b16646129c294"
    decision: version-bump
  - root: "event:graph/change"
    previous: null
    after: "8698d3246ccebd1be01307664e4c3ad4df0df4b09573e7903aba74304c435d87"
    decision: version-bump
  - root: "event:graph/checkpoint"
    previous: null
    after: "6efb244ab32d11ce1c1a7461b08bf33d156b91cc14a0eaa62d9e1adea9b11b77"
    decision: version-bump
  - root: "event:graph/control"
    previous: null
    after: "e80ec87a15d1c4862b9e28b92d5ae5f3cd8da01e2252d1eca7001bf90a7875fc"
    decision: version-bump
  - root: "event:graph/operation"
    previous: null
    after: "d01e4b0f57209207ef330957146071c4840bba1fe76ab04e1e01ba7e78dd91b5"
    decision: version-bump
  - root: "event:graph/run"
    previous: null
    after: "9cd7a2629cb234af9e2ed1a8e3f6346808e1b6b0747dd59a0336feecc1e46896"
    decision: version-bump
  - root: "event:graph/run-update"
    previous: null
    after: "862b3fce7bf0f9c405b9a69fb7930b21f9bec5194d83580a2b34713adb356567"
    decision: version-bump
  - root: "event:graph/settlement"
    previous: null
    after: "fd05aecf7ee7a3fe61470a39f11573c287b8259956df2204a50453a580447d3c"
    decision: version-bump
  - root: "event:graph/submission"
    previous: null
    after: "4c277b1c1cfc2fa0934326ef4129f4126e39d282cd304dd2910c24ee83d15626"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "3ad933ed2ec7a59e5cd8b4e7bae916eb8ed6118ce0ba18fa00260a07d80acf3e"
    decision: version-bump
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "f0d8c1a2a894bc3807870ef73668d03768754110647b48f031e5faa16cf68ecc"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "d1c55b1ed092372f3e6bc09b12ddfaac8aff5d1db6e29fa024321a3687c5241f"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V4 files remain immutable. The adjacent V4-to-V5 migration validates the V4 header, changes only its version, preserves every event and inherited cut, and publishes a separate V5 successor only through the persistence owner. V5 native validation accepts Graph message attribution and the new event vocabulary; older readers may refuse V5 rather than interpreting it as V4. Optional capacity remains absent on older descriptors.

<a id="verification"></a>
## Verification

Focused V4-to-V5 migration, catalog, and JSONL persistence tests exercise header conversion, seeded cuts, delivery ownership, and historical child reads. Catalog and persistence-format generators validate the adjacent chain and archived V4 schema.

<a id="dev-note"></a>
## Dev Note

None.
