---
title: "Maestro Flow v0.5.66 发布闭环：行分隔产物元数据（.ndjson/.jsonl）发布与零门禁拦截的持续验证"
description: "记录 v0.5.66 发布：run 产物元数据对 .ndjson/.jsonl 行分隔格式的支持修复（首行 _meta、BOM 剥离、skipArtifactMetadataValidation 降级选项）全流程发布，门禁一次通过、无新缺陷、无 E413"
type: recipe
category: release
created: "2026-08-08T13:30:00+08:00"
tags: [发布, npm, GitHub, provenance, artifact-metadata, ndjson, E413]
status: active
source: "v0.5.66"
---

# Maestro Flow v0.5.66 发布闭环

## Goal

把 run 产物元数据对行分隔格式的支持修复（`.ndjson` / `.jsonl` 首行 `_meta` 解析 + UTF-8 BOM 剥离 + `skipArtifactMetadataValidation` 降级选项）发布为 `maestro-flow@0.5.66`。本次发布门禁一次通过、零拦截：v0.5.64 的四个修复（build 引号、release-machine node -e 数量、search `--limit` 契约、E413 .cache 排除）与 v0.5.65 的发布流程在本次全部持续生效。

## Release Identity

- previous tag：`v0.5.65`（`349506c6`）
- product range：`v0.5.65..0b4c1ed7`
- product statistics：1 commit，7 files，+283 / −39（`55ae1acd` 为 v0.5.65 closure knowhow 补录，不计入产品统计）
- product commits：
  - `02aacc17` fix(run): support line-delimited artifact metadata
- 版本期提交：`17aaf0d6` chore(bump 0.5.66)、`0b4c1ed7` docs(release notes)
- final release commit：`0b4c1ed702a6595e37314327b42f5c6186c48e8c`
- annotated tag：`v0.5.66`（remote peeled 指向 `0b4c1ed7`，一次推送成功，无 force-move）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.66>（Latest，published，非 draft，非 prerelease，publishedAt 2026-08-08T05:20:04Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.66>（latest=0.5.66）

## Knowledge-First Discovery

- `RCP-20260807-maestro-flow-release-closure-v0.5.65`（最新闭环：transcript evidence 发布 + E413 排除持续验证 + 发布一次成功无需 force-move）；
- `RCP-20260807-maestro-flow-release-closure-v0.5.64`（4 轮门禁拦截记录：build 引号、release-machine 硬编码、search --limit 契约、E413 排除）；
- `RCP-20260712-maestro-flow-release`（基础流程）。

## Required Gates

clean worktree 跑 `npm run prepublishOnly`，exit 0（一次通过，零拦截）：
- invocation policy lint ✓；session-run prompt lint（18 commands、14 skills）✓
- docs reference in sync ✓；Session/Run contract parity 22 checks ✓
- search-ranking source tests（root 104 + dashboard 51 = 155）+ built attestation（recall@20，`--limit` 契约持续生效）✓
- Session/Run release-machine parity ✓；mirrors：32 Codex skills 版本戳=0.5.66、25 agents ✓

## Package Proof

tgz 从 release commit `0b4c1ed7` 的 worktree 生成并直接发布（E413 排除持续生效）：

```text
filename: maestro-flow-0.5.66.tgz
size: 18,964,468 B（约 19 MB）
unpacked: 91.4 MB（91,421,442 B）
files: 5,276
shasum: 0e4a1ab1701e89184cb36c9c510e459a006be6aa
integrity: sha512-8toM0NpDP+YkuLwLQBhzRvSuRqFBhGpDa8St3lNA5R0Yc6bbOc1RdNppc6isE41+XwFtwtCUHE3s+quIWtKP6w==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、`.cache=0`（235MB ONNX 模型排除持续生效）、32/32 codex skill 版本戳=0.5.66。

## Publish and Verification

顺序：

1. push `master`（`349506c6..0b4c1ed7`，含 v0.5.65 closure knowhow 55ae1acd）；
2. annotated tag `v0.5.66` 一次创建并推送成功；
3. `git ls-remote origin refs/tags/v0.5.66^{}` = `0b4c1ed7` 核验 remote peeled = release commit；
4. `gh release create v0.5.66 --notes-file .release-notes-v0.5.66.md`；
5. `npm publish ./maestro-flow-0.5.66.tgz --access public`（一次成功，无 E413）；
6. 验证 npm `version=0.5.66`、`dist.shasum=0e4a1ab1...`/`dist.integrity=sha512-8toM0Np...` 与本地 pack 字节级一致；GH Release Latest、published、非 draft、非 prerelease。

## Problems Found and Durable Fixes

无新问题。v0.5.64 的四项修复与 v0.5.65 的发布顺序在本次全部持续生效：build 脚本引号（npm run build 一次通过）、release-machine `inlineNodes.length !== 3`、search `--limit` 契约（built attestation recall@20 通过）、files `!dashboard/vendor/transformers/.cache`（unpacked 91.4MB 与上版同量级，无 413）。

## Reusable Checklist（沿用 v0.5.65 + 本次增量）

1. 沿用 v0.5.65 完整清单（WIP 先 build/测试、六处版本面、clean worktree prepublishOnly、exact tgz、ls-remote 核验、registry provenance 核对）。
2. E413 排除修复后，每次 pack 核对 unpackedSize 与上版同量级（本次 91.4MB ≈ 上版 91.4MB）与 `.cache=0`，验证排除持续生效。
3. 产品范围含上一版 closure knowhow 补录时，在 Release Note 标注其不计入产品统计。
4. 发布一次成功时无需 force-move tag；保留「tag force-move 后重建 annotated tag」的应急步骤备用。
5. 门禁后 `resources/arch-kb` 会再生成（builtAt + 行尾差异），pack 前 `git checkout -- resources/arch-kb` 恢复，保持 tgz 自 release commit（本次同样触发并恢复）。

## Related

- `[[knowhow-rcp-20260807-maestro-flow-release-closure-v0-5-65]]`
- `[[knowhow-rcp-20260807-maestro-flow-release-closure-v0-5-64]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.66.md`
