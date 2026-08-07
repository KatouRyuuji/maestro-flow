---
title: "Maestro Flow v0.5.65 发布闭环：transcript evidence 证据快照发布与 E413 排除的持续验证"
description: "记录 v0.5.65 发布：K12–K17 窗口证据流 + transcript evidence snapshots 两个产品提交的全流程发布，重点验证上版 E413 修复（transformers .cache 排除）与 release-machine --limit 契约在发布期的持续生效，无新缺陷"
type: recipe
category: release
created: "2026-08-07T17:30:00+08:00"
tags: [发布, npm, GitHub, provenance, transcript-evidence, E413]
status: active
source: "v0.5.65"
---

# Maestro Flow v0.5.65 发布闭环

## Goal

把知识生命周期的「对话记录证据」两个产品提交（transcript evidence snapshots + run-mode K12–K17 窗口证据流）发布为 `maestro-flow@0.5.65`。本次发布无新缺陷：v0.5.64 的四个门禁发现（build 引号、release-machine node -e 数量、search `--limit` 契约、E413 .cache 排除）在本次全部持续生效，验证闭环修复的可复用性。

## Release Identity

- previous tag：`v0.5.64`（`12eb333e`）
- product range：`v0.5.64..349506c6`
- product statistics：2 commits，11 files，+1,213 / −21（b866aa4e 为 v0.5.64 closure knowhow 补录，不计入产品统计）
- product commits：
  - `d2e70584` feat(knowledge): capture transcript evidence snapshots
  - `6bab5026` feat(prompts): teach run-mode and harvest the K12–K17 window evidence flow
- 版本期提交：`78bcbfcc` chore(bump 0.5.65)、`349506c6` docs(release notes)
- final release commit：`349506c6409d1286f1eae3d04122ee8736706dab`
- annotated tag：`v0.5.65`（remote peeled 指向 `349506c6`，一次推送成功，无 force-move）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.65>（Latest，published，非 draft，非 prerelease，publishedAt 2026-08-07T09:21:45Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.65>（latest=0.5.65）

## Knowledge-First Discovery

- `RCP-20260807-maestro-flow-release-closure-v0.5.64`（最新闭环：4 轮门禁拦截记录 + E413 修复 + search --limit 契约 + build 引号修复）；
- `RCP-20260712-maestro-flow-release`（基础流程）。

## Required Gates

clean worktree 跑 `npm run prepublishOnly`，exit 0：
- invocation policy lint ✓；session-run prompt lint（18 commands、14 skills）✓
- docs reference in sync ✓；Session/Run contract parity 22 checks ✓
- search-ranking source tests（root 104 + dashboard 51 = 155）+ built attestation（recall@20，`--limit` 契约持续生效）✓
- Session/Run release-machine parity ✓；mirrors：32 Codex skills 版本戳=0.5.65、25 agents ✓

## Package Proof

tgz 从 release commit `349506c6` 生成并直接发布（E413 排除持续生效）：

```text
filename: maestro-flow-0.5.65.tgz
size: 18,962,754 B（约 19 MB）
unpacked: 91.4 MB（91,411,296 B）
files: 5,276
shasum: 6074f180c5e57cb7b1cbb2fae9d9abdaea39329c
integrity: sha512-AlSot0e8NrFKROiPdID9l62Mm1EGgLgNgXN+FAo0fSQVpl3vmCCBCqfZWaL/pGMO3XXWaa1p5Oi+rZ5Gs5CoCA==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、`.cache=0`（235MB ONNX 模型排除持续生效）、32/32 codex skill 版本戳=0.5.65。

## Publish and Verification

顺序：

1. push `master`（`12eb333e..349506c6`，含 v0.5.64 closure knowhow b866aa4e）；
2. annotated tag `v0.5.65` 一次创建并推送成功；
3. `git ls-remote origin refs/tags/v0.5.65^{}` = `349506c6` 核验 remote peeled = release commit；
4. `gh release create v0.5.65 --notes-file .release-notes-v0.5.65.md`；
5. `npm publish ./maestro-flow-0.5.65.tgz --access public`（一次成功，无 E413）；
6. 验证 npm `version=0.5.65`、`dist.shasum=6074f180...`/`dist.integrity=sha512-AlSot0e...` 与本地 pack 字节级一致；GH Release Latest、published、非 draft、非 prerelease。

## Problems Found and Durable Fixes

无新问题。v0.5.64 的四项修复在本次发布全部持续生效：build 脚本引号（npm run build 一次通过）、release-machine `inlineNodes.length !== 3`、search `--limit` 契约（built attestation recall@20 通过）、files `!dashboard/vendor/transformers/.cache`（unpacked 91.4MB 与上版同量级，无 413）。

## Reusable Checklist（沿用 v0.5.64 + 本次增量）

1. 沿用 v0.5.64 完整清单（WIP 先 build/测试、六处版本面、clean worktree prepublishOnly、exact tgz、ls-remote 核验、registry provenance 核对）。
2. E413 排除修复后，每次 pack 核对 unpackedSize 与上版同量级（本次 91.4MB ≈ 上版 91.4MB）与 `.cache=0`，验证排除持续生效。
3. 产品范围含上一版 closure knowhow 补录时，在 Release Note 标注其不计入产品统计。
4. 发布一次成功时无需 force-move tag；保留「tag force-move 后重建 annotated tag」的应急步骤备用。

## Related

- `[[knowhow-rcp-20260807-maestro-flow-release-closure-v0-5-64]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.65.md`
