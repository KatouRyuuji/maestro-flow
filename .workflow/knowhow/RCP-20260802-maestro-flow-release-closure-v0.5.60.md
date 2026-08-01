---
title: "Maestro Flow v0.5.60 发布闭环：安装器 Pi 平台移除、arch-kb 命令面精简与存储标识符加固"
description: "记录 v0.5.60 从未提交 WIP（安装器 Pi 平台移除 + i18n/TUI 提示）的构建验证、版本面同步、prepublishOnly 全门禁、npm/GitHub 发布到 registry provenance 验证的完整证据"
type: recipe
category: release
created: "2026-08-02T01:10:00+08:00"
tags: [发布, 安装器, arch-kb, 存储标识符, npm, GitHub, provenance]
status: active
source: "v0.5.60"
---

# Maestro Flow v0.5.60 发布闭环

## Goal

把一次未提交的安装器变更（移除 Pi 平台、改由官方 `pi-maestro-flow` 插件接入）、`arch-kb` 命令面精简（search/show/list）与一批存储标识符边界加固发布为 `maestro-flow@0.5.60`。发布必须证明 Git tag、npm tarball、GitHub Release 使用同一 release commit，且 registry 下发的 tarball 与本地 pack 字节一致。

## Release Identity

- previous tag：`v0.5.59`（指向 `ef797e7a`）
- closure boundary：`52a4778c`（v0.5.59 发布后的 closure knowhow 补录，不计入产品统计）
- product range：`52a4778c..a1f64fe4`
- product statistics：5 commits，101 files，557 insertions，375 deletions
- product commits：
  - `2601a3a3` fix: harden storage identifier boundaries
  - `bf1ee7b1` refactor(arch-kb): 精简命令面为 search/show/list
  - `1f2d0e49` feat(install): remove Pi platform from installer; direct users to pi-maestro-flow plugin
  - `ed75e1f7` chore: bump version to 0.5.60
  - `a1f64fe4` docs: add v0.5.60 release notes
- final release commit：`a1f64fe44e80d13f9f72f3d98252bbf23724408d`
- annotated tag：`v0.5.60`（remote peeled 指向 `a1f64fe4`）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.60>（published，非 draft，非 prerelease，publishedAt 2026-08-01T17:09:00Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.60>（latest=0.5.60）

## Knowledge-First Discovery

发布开始时加载并核验最新配方：

- `RCP-20260712-maestro-flow-release`（基础发布流程：版本三处同步 + tag + GitHub Release + npm publish）；
- `RCP-20260730-maestro-flow-release-closure-v0.5.59`（最新闭环：WIP 先验证构建再提交、`npm version --no-git-tag-version` 同步含 lockfile `packages[""]` 的版本面、clean worktree 跑 `prepublishOnly`、发布 exact tgz、registry provenance 核对）。

## Pre-Release WIP Verification

起始 worktree 非 clean：9 个未提交文件（安装器 Pi 平台移除 + i18n `piPluginReminder` + TUI 选择器/结果页提示 + 安装指南 + hub `commands-entry` 去重）。决策为「commit 所有并发布」，发布前先证明可构建：

- `npm run build` exit 0（5 个 lifecycle native binaries verified，dashboard tsc + root tsc 通过）。
- 改动面测试 5 个文件 81/81 通过：`install-executor.test.ts`、`reinstall-workflows.test.ts`、`skill-converter.test.ts`、`ComponentGrid.logic.test.ts`、`BlueprintPreview.logic.test.ts`。
- 确认 `skill-converter.ts` 的 `buildPiSkills/buildPiAgents` 导出保留（仅移除 component-defs 调用点），既有测试不受影响。

验证通过后才提交 WIP（`1f2d0e49`），再做版本 bump。

## Required Gates

从 clean worktree（bump 与 release notes 提交后 status 为空）执行 `npm run prepublishOnly`，exit 0：

- invocation policy lint 通过；
- session-run prompt lint：18 commands、45 skills；
- docs reference in sync；
- Session/Run contract parity：21 checks；
- search-ranking source tests：root 104 + dashboard 51 = 155/155，0 failures；
- built search-ranking attestation 通过（bootstrap byte boundaries valid，LF 边界修复持续生效）；
- Session/Run release-machine parity 通过；
- 25 Codex agents schema/parity 通过；
- mirror lint 覆盖 `.agy`、`.agents`、`.codex` 并通过；63 Codex skills 版本戳更新为 `0.5.60`。

## Package Proof

最终 tgz 从 release commit `a1f64fe4` 的 clean worktree 生成并直接发布：

```text
filename: maestro-flow-0.5.60.tgz
size: 8.9 MB（8,882,607 量级）
unpacked: 44.4 MB
files: 6,000
shasum: c75cf1c9ee6da0725eccc00ef2078773692aeeb2
integrity: sha512-S8eppBXPEJhjfnyitw/2F4pLtGx5IHII6cyUhA6Ur9sYolziqkdQFsULEGSfHzXAcxRtuvEcG2zLsqCArvrT0g==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、package/skill mirror 版本戳=`0.5.60`、ESM exports=29（与 v0.5.59 一致）。

## Publish and Verification

顺序：

1. push `master`（`bf1ee7b1..a1f64fe4`）；
2. 创建并 push annotated tag `v0.5.60`（一次成功，无 TLS 重试）；
3. `git ls-remote origin refs/tags/v0.5.60^{}` 核验 remote peeled commit = `a1f64fe4`；
4. 用 `.release-notes-v0.5.60.md` 创建 GitHub Release（title `v0.5.60`）；
5. `npm publish ./maestro-flow-0.5.60.tgz --access public`（发布预打包 tgz 不重跑 lifecycle，发布字节即验证字节）；
6. 验证 npm `version=0.5.60`、`dist.shasum`/`dist.integrity` 与本地 pack 完全相同（字节级 provenance 一致）；GH Release published、非 draft、非 prerelease。

## Problems Found and Durable Fixes

本次发布无异常：起始 WIP 构建与测试一次通过，版本面同步用 `npm version --no-git-tag-version`（root + docs-site）消除 lockfile 漂移，门禁全绿，tag push 无瞬时 TLS 失败。沿用 v0.5.59 闭环清单即可覆盖。

## Reusable Checklist

1. 起始 worktree 非 clean 时，先跑 `npm run build` + 改动面测试证明可构建，再提交为产品 commit，最后才跑 release 门禁。
2. 移除平台类变更要确认 converter 导出与既有测试的保留边界（本次 `buildPiSkills/buildPiAgents` 保留，仅删调用点）。
3. 版本 bump 用 `npm version <ver> --no-git-tag-version`（root + docs-site），核验六处版本面（root/docs-site 的 package.json、package-lock.json、lockfile `packages[""]`）+ ChangelogPage 条目 + mirrors。
4. 从 clean worktree 跑 `npm run prepublishOnly` 作为 release gate。
5. 只发布经过 audit 的 exact tgz（pyc=0、arch-kb=1、bin/dist 存在、版本戳、ESM exports=29）；发布预打包 tgz 不重跑 lifecycle。
6. tag push 后用 `git ls-remote ... ^{}` 核验 remote peeled commit。
7. 发布后核对 registry `dist.shasum`/`dist.integrity` 与本地 pack 一致（字节级 provenance）、GH Release 状态。
8. closure knowhow 独立 force-add 提交，不移动 release tag；tgz 产物保持 untracked。

## Related

- `[[knowhow-rcp-20260730-maestro-flow-release-closure-v0-5-59]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.60.md`
