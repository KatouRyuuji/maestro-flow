---
title: "Maestro Flow v0.5.67 发布闭环：chain 参数穿透与 session 投影/剪枝修复"
description: "记录 v0.5.67 发布：--arg 穿透 chain 且失败 session canonical 可达、chain-file 步骤参数与显式 topic 保留、全路径投影注册 + 枚举参数校验 + session prune 三个产品提交的全流程发布，门禁一次通过、无新缺陷、无 E413，docsite lockfile 漂移一并修正"
type: recipe
category: release
created: "2026-08-08T15:58:00+08:00"
tags: [发布, npm, GitHub, provenance, chain, session, E413]
status: active
source: "v0.5.67"
---

# Maestro Flow v0.5.67 发布闭环：chain 参数穿透与 session 投影/剪枝修复

## Goal

把 run 链式调度与 session 生命周期的三个产品提交（`--arg` 穿透 chain 且失败 session canonical 可达、chain-file 步骤参数与显式 topic 保留、全路径投影注册 + 枚举参数校验 + session prune）发布为 `maestro-flow@0.5.67`。本次发布门禁一次通过、零拦截：v0.5.64 的四项修复（build 引号、release-machine node -e 数量、search `--limit` 契约、E413 .cache 排除）与 v0.5.65/66 的发布流程持续生效。

## Release Identity

- previous tag：`v0.5.66`（`0b4c1ed7`）
- product range：`v0.5.66..bb55c71d`
- product statistics：3 commits，7 files，+218 / −25（`2ca4966b` 为 v0.5.66 closure knowhow 补录，不计入产品统计）
- product commits：
  - `d2f828a7` fix(run): pass --arg through chain dispatch and keep failed sessions canonical-reachable
  - `4ba291b7` fix(run): preserve chain-file step args and explicit topic in chain start
  - `ebd38837` fix(run): register projections on all session creation paths, validate enum args, add session prune
- 版本期提交：`60060d69` chore(bump 0.5.67)、`bb55c71d` docs(release notes)
- final release commit：`bb55c71dd261c71c080eb4e41a815c6ea00c16fa`
- annotated tag：`v0.5.67`（remote peeled 指向 `bb55c71d`，一次推送成功，无 force-move）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.67>（Latest，published，非 draft，非 prerelease，publishedAt 2026-08-08T15:51:04Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.67>（latest=0.5.67）

## Knowledge-First Discovery

- `RCP-20260808-maestro-flow-release-closure-v0.5.66`（最新闭环：行分隔产物元数据发布 + 零门禁拦截持续验证）；
- `RCP-20260807-maestro-flow-release-closure-v0.5.64`（4 轮门禁拦截记录：build 引号、release-machine 硬编码、search --limit 契约、E413 排除）；
- `RCP-20260712-maestro-flow-release`（基础流程：版本三处同步 + tag + GH Release + npm publish）。

## Required Gates

clean worktree 跑 `npm run prepublishOnly`，exit 0（一次通过，零拦截）：
- invocation policy lint ✓；session-run prompt lint（18 commands、14 skills）✓
- docs reference in sync ✓；Session/Run contract parity 22 PASS ✓
- search-ranking source tests（root 104 + dashboard 51 = 155，0 failures）+ built attestation（recall@20=1、exactMrrAt10=1，`--limit` 契约持续生效）✓
- Session/Run release-machine parity ✓；mirrors：32 Codex skills 版本戳=0.5.67、25 agents schema/parity ✓

## Package Proof

tgz 从 release commit `bb55c71d` 的 worktree 生成并直接发布（E413 排除持续生效）：

```text
filename: maestro-flow-0.5.67.tgz
size: 18,972,298 B（约 19 MB）
unpacked: 91,459,542 B（约 91.5 MB）
files: 5,276
shasum: e5880355af8a89449e372cd539c4da92a8b5278b
integrity: sha512-wallvnnRB2x87032a0n2cto4UqqzmuggAsN6fvBbbK2NZIWZoZj0FdhRwVfWNaZIAUCFMpcciWgJzLkWioOitA==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、`.cache=0`（E413 排除持续生效）、32/32 codex skill 版本戳=0.5.67。

## Publish and Verification

顺序：

1. push `master`（`2ca4966b..bb55c71d`，含 v0.5.66 closure knowhow 2ca4966b）；
2. annotated tag `v0.5.67` 一次创建并推送成功；
3. `git ls-remote origin refs/tags/v0.5.67^{}` = `bb55c71d` 核验 remote peeled = release commit；
4. `gh release create v0.5.67 --title v0.5.67 --notes-file .release-notes-v0.5.67.md`；
5. `npm publish ./maestro-flow-0.5.67.tgz --access public`（一次成功，无 E413）；
6. 验证 npm `version=0.5.67`、`dist.shasum=e5880355...`/`dist.integrity=sha512-wallv...` 与本地 pack 字节级一致；dist-tags latest=0.5.67；GH Release Latest、published、非 draft、非 prerelease。

## Problems Found and Durable Fixes

无新问题。v0.5.64 的四项修复与 v0.5.65/66 的发布顺序在本次全部持续生效：build 脚本引号（npm run build 一次通过）、release-machine `inlineNodes.length !== 3`、search `--limit` 契约（built attestation recall@20 通过）、files `!dashboard/vendor/transformers/.cache`（unpacked 91.5MB 与上版同量级，无 413）。

## Reusable Checklist（沿用 v0.5.66 + 本次增量）

1. 沿用 v0.5.66 完整清单（WIP 先 build/测试、六处版本面、clean worktree prepublishOnly、exact tgz、ls-remote 核验、registry provenance 核对）。
2. E413 排除修复后，每次 pack 核对 unpackedSize 与上版同量级（本次 91.5MB ≈ 上版 91.4MB）与 `.cache=0`，验证排除持续生效。
3. 产品范围含上一版 closure knowhow 补录时，在 Release Note 标注其不计入产品统计。
4. 发布一次成功时无需 force-move tag；保留「tag force-move 后重建 annotated tag」的应急步骤备用。
5. 门禁后 `resources/arch-kb` 会再生成（builtAt + 行尾差异），pack 前 `git checkout -- resources/arch-kb` 恢复，保持 tgz 自 release commit（本次同样触发并恢复）。
6. 本次新增：docs-site/package-lock.json 在 v0.5.66 未同步（停于 0.5.65），本次在 docs-site 目录内执行 `npm version 0.5.67 --no-git-tag-version` 一并修正，消除 lockfile 漂移。

## Related

- `[[knowhow-rcp-20260808-maestro-flow-release-closure-v0-5-66]]`
- `[[knowhow-rcp-20260807-maestro-flow-release-closure-v0-5-65]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.67.md`
