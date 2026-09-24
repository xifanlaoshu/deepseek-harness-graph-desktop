---
description: "Session V4-to-V5 migration and native V5 admission."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

This library advances stored V4 Sessions to the V5 writer without changing their event bodies or overwriting V4 files. V5 admits the Graph-owned message source in current Session validation. The V4 physical codec and validation remain available for historical reads.

No runtime invariant companion is published because the codec and migration validate each detached artifact at restoration; this package owns no independent mutable observation to compare.

## Table of Contents

- [Conversion](#conversion)
- [Native admission](#native-admission)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Conversion

`sessionFormatV4ToV5` validates the V4 logical header and changes only `version` from 4 to 5. It preserves header identity, parent, creation time, and all optional fields. Events, compact runs, sequence numbers, timestamps, sources, payloads, and inherited-event coordinates are emitted unchanged. The last inherited end-seed event determines the cut for seeded Sessions; unseeded Sessions use zero. The source V4 codec owns physical decoding and earlier migration stages own their own transformations. A missing inherited marker or disagreement with an already known source cut is rejected.

## Native admission

`releasedV5SessionFormatCodec` retains V4 physical row framing. V5 headers retain V4 fields with version 5. Current-row admission retains the V4 structural checks; installed Session validation accepts the Graph message source and current event vocabulary. Complete restoration checks V4 relationships and validates V5 delivery markers against their event sequence and Session owner. Historical V4 delivery markers retain their V4 meaning and are not relabeled.

## Dev Note

None.

## Model Experience

### Historical restoration

#### What the model sees

The migration has no model-visible tool or prompt. It restores recorded messages before a resumed agent request; the installed Session reader determines which `user/message` and other recorded content reaches the model.

#### Token effect

The V4-to-V5 edge preserves message content and adds no token-bearing text.

#### KV Cache effect

The edge preserves the recorded request prefix. Provider cache availability and eviction remain outside this library.

## Known Limitations and Deferred Work

- This edge does not repair invalid V4 data, rewrite committed generations, or synthesize Graph state. The catalog and JSONL persistence service own migration scheduling and successor publication.
- Restoring a historical V4 body that requires V3 child facts still needs the catalog's child-evidence binding.
