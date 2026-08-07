---
title: "Maestro Flow v0.5.64 发布闭环：构建脚本引号修复、search --limit 契约恢复与 npm 体积门禁（E413）"
description: "记录 v0.5.64 发布全程：三个发布门禁发现并修复的缺陷（build 脚本 wasm 拷贝引号、release-machine 对 3 个 node -e 的硬编码、parameter-necessity cleanup 误删 search --limit 契约）、npm E413 体积超限（transformers .cache ONNX 235MB 入包）与 files 排除修复，以及完整 provenance 证据"
type: recipe
category: release
created: "2026-08-07T12:40:00+08:00"
tags: [发布, npm, GitHub, provenance, E413, release-machine, 构建]
status: active
source: "v0.5.64"
---

# Maestro Flow v0.5.64 发布闭环

## Goal

把 18 个未提交范围的产品提交（知识流 UX、prompts 质量门禁、kg 基础设施修复等）发布为 `maestro-flow@0.5.64`。本次发布被门禁拦下 4 次，每轮都发现并修复一个真实缺陷：build 脚本引号错误、release-machine 硬编码数量、`search --limit` 契约误删、npm E413 体积超限。发布必须证明 Git tag、npm tarball、GitHub Release 使用同一 release commit，且 registry 下发的 tarball 与本地 pack 字节一致。

## Release Identity

- previous tag：`v0.5.63`
- product range：`v0.5.63..12eb333e`
- product statistics：23 commits，251 files，+17,396 / −1,706
- product commits（18 个原始 + 5 个发布期新增）：
  - 原始：`d41aaed3` fix(kg)、`fca51cef`/`d01e9d0c`/`60863c98` fix(run/session)、`b5acf007` fix(report)、`f674d342` feat(knowledge)、`c3a117f3` refactor(prepare)、`b90084a9`/`36f9928c`/`62181b6d`/`81d0853a` feat(prompts/cli)、`773824a7`/`0e7a0aa8`/`538a2cab`/`2f0d6887`/`b576bcc9` fix(prompts/boundaries/knowledge)、`d16cb9fe`/`bd6563e4` feat(ux)
  - 发布期新增：`c6f4c718` fix(build) 引号修复、`63785e69` chore(bump)、`7f5bdd8c` docs(release notes)、`545af91a` fix(search) `--limit` 契约恢复、`12eb333e` fix(pack) E413 体积排除
- final release commit：`12eb333ecf92236b931a667038a3011e1e54665f`
- annotated tag：`v0.5.64`（remote peeled 指向 `12eb333e`；期间因 pack 修复 force-move 一次，gh release delete --cleanup-tag 后重建 annotated tag）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.64>（Latest，published，非 draft，非 prerelease，publishedAt 2026-08-07T04:26:35Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.64>（latest=0.5.64）

## Knowledge-First Discovery

- `RCP-20260712-maestro-flow-release`（基础流程：版本三处同步 + tag + GH Release + npm publish）；
- `RCP-20260802-maestro-flow-release-closure-v0.5.60`（最新闭环：WIP 先验证构建再提交、`npm version --no-git-tag-version` 同步含 lockfile `packages[""]`、clean worktree 跑 `prepublishOnly`、发布 exact tgz、registry provenance 核对）。

## Problems Found and Durable Fixes（4 轮门禁拦截）

### 1. build 脚本 wasm 拷贝步骤引号损坏（npm run build 直接 SyntaxError）

`d41aaed3`（fix(kg)）向 `package.json#scripts.build` 追加第三个 `node -e`（wasm 拷贝）时，第二段 `node -e` 的收尾 `\"` 丢失，npm 执行时 `&& node -e` 被吃进 JS 代码。**修复**：`c6f4c718` 恢复缺失引号（`}}` 后补 `\"`，并去掉尾部多余 `\"\"` 对）。教训：多段 `node -e` 内联脚本必须逐段核对引号配对；发布前 `npm run build` 首跑。

### 2. release-machine 硬编码 node -e 数量（check-search-ranking-release-machine:source）

`validateActualPackageBuildControls` 硬编码 `inlineNodes.length !== 2`，build 脚本合法增长到 3 个 `node -e` 后源图校验失败。**修复**：`545af91a` 中一并更新为 `!== 3` 并改消息为 "all node -e controls"。教训：release-machine 的构建图断言是「有意识变更证书」，build 脚本形状变更时必须同步更新，无外部 manifest 编码此数量。

### 3. parameter-necessity cleanup 误删 search --limit 契约（check-search-ranking-release-machine:built）

`81d0853a`（"parameter necessity cleanup"）删除了 `maestro search` 的 `--keyword/--all/--diversity/--limit` 四个选项并硬编码 `limit=20`，但 built attestation 依赖 `search <q> --wiki-only --no-emb --limit 20 --json --read-only-probe` 测量 recall@20。**修复**：`545af91a` 恢复 `--limit <n>`（默认 '20'，`Math.min(500, opts.limit>0 ? trunc : 20)`），其余三个选项确认无消费方后不恢复。教训：删除 CLI 选项前必须 grep release-machine / attestation / 契约脚本对该选项的引用；built attestation 是全量回放真实二进制。

### 4. npm E413 Payload Too Large（239.6MB tgz）

`dashboard/vendor/transformers/.cache/.../multilingual-e5-small/onnx/model_fp16.onnx`（235MB，运行时下载的 embedding 模型缓存）被 `files: ["dashboard/vendor"]` 卷入包内；tgz 239.6MB / unpacked 343.8MB，registry PUT 返回 413（v0.5.63 为 85MB unpacked 正常）。**修复**：`12eb333e` 在 files 中追加否定项 `"!dashboard/vendor/transformers/.cache"`，重打包后 unpacked 91.4MB / 5272 files。教训：`files` 目录通配会吞掉 gitignored 的运行时缓存；发布前核对 unpackedSize 与上一版本量级，超 2 倍即怀疑入包污染。

## Required Gates

clean worktree 跑 `npm run prepublishOnly`，exit 0（搜索 --limit 恢复后全绿）：
- invocation policy lint ✓；session-run prompt lint（18 commands、14 skills）✓
- docs reference in sync ✓；Session/Run contract parity 22 checks ✓
- search-ranking source tests：root 104 + dashboard 51 = 155/155，0 failures ✓；built attestation（含 recall@20 契约）✓
- Session/Run release-machine parity ✓；mirrors：32 Codex skills 版本戳=0.5.64、25 agents schema/parity ✓

## Package Proof

最终 tgz 从 release commit `12eb333e` 的 worktree 生成（files 排除后重打包）并直接发布：

```text
filename: maestro-flow-0.5.64.tgz
size: 约 90 MB 量级（unpacked 91,371,653 B）
unpacked: 91.4 MB
files: 5,272
shasum: 82fcbb0e030bd4f0eeec37850696651f763e790f
integrity: sha512-5Zuqthb17Jr8DFtOaVdFsC3+vzpaqWFRo4AhIBsjqjDix9kvAqTPMfjo48zP42hHs+WuAUVSK0SHxhI5Rqb4Ww==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、`.cache=0`（235MB ONNX 已排除）、transformers vendored dist=18 文件、32/32 codex skill 版本戳=0.5.64。

## Publish and Verification

顺序：

1. push `master`（`545af91a..12eb333e` 两轮）；
2. annotated tag `v0.5.64` → push；因 pack 修复 force-move 一次（`709a4642`→`12eb333e`），`gh release delete --cleanup-tag` 后重建 annotated tag 并 force push；
3. `git ls-remote origin refs/tags/v0.5.64^{}` = `12eb333e` 核验 remote peeled = release commit；
4. 用 `.release-notes-v0.5.64.md` 创建 GitHub Release（title `v0.5.64`，Latest）；
5. `npm publish ./maestro-flow-0.5.64.tgz --access public`（发布预打包 tgz 不重跑 lifecycle）；首次 E413 失败 → files 排除后重打包成功；
6. 验证 npm `version=0.5.64`、`dist.shasum=82fcbb0e...`/`dist.integrity=sha512-5Zuqthb...` 与本地 pack 字节级一致；GH Release Latest、published、非 draft、非 prerelease。

## Reusable Checklist（v0.5.64 增量）

1. 版本 bump 后必须跑一次 `npm run build`——本次即拦下 `d41aaed3` 的引号损坏；多段 `node -e` 脚本引号逐段核对。
2. build 脚本的 node -e 数量变化时，同步更新 `check-search-ranking-release-machine.mjs` 的 `validateActualPackageBuildControls`（`inlineNodes.length !== N`）。
3. 删 CLI 选项前 grep 全部 `check:*release-machine` 脚本与 attestation 对 `--option` 的引用；`search --limit` 是 recall@20 契约，不可删。
4. `npm pack` 后核对 unpackedSize 与上一版本同量级；`files` 目录通配会吞 gitignored 运行时缓存（transformers `.cache`），用 `!` 否定排除。
5. 门禁与 pack 会再生成 `resources/arch-kb`（builtAt + 行尾差异），发布前 `git checkout -- resources/arch-kb` 恢复，保持 tgz 自 release commit。
6. tag force-move 后：核验 `ls-remote ...^{}`、`gh release delete --cleanup-tag` 重建 annotated tag（gh 会删本地 tag 引用）、重发 GH Release。
7. 发布后核对 registry `dist.shasum`/`dist.integrity` 与本地 pack 一致；tgz 产物保持 untracked。

## Related

- `[[knowhow-rcp-20260802-maestro-flow-release-closure-v0-5-60]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.64.md`
