---
title: "Maestro Flow v0.5.59 发布闭环：wouter 路由迁移、依赖升级与 registry provenance 验证"
description: "记录 v0.5.59 从未提交 WIP（react-router-dom→wouter 路由迁移 + 依赖 major 升级）的构建验证、版本面同步、prepublishOnly 全门禁、npm/GitHub/Pages 发布到 local + registry 双 consumer provenance 验证的完整证据"
type: recipe
category: release
created: "2026-07-30T14:40:00+08:00"
tags: [发布, wouter, 路由迁移, 依赖升级, clean-checkout, npm, GitHub, provenance]
status: active
source: "v0.5.59"
---

# Maestro Flow v0.5.59 发布闭环

## Goal

把一次未提交的客户端路由迁移（`react-router-dom` → `wouter`）、dashboard 体验增强（可调节面板、右键菜单、KaTeX 数学渲染）、核心依赖 major 升级（`@hono/node-server` 2.x、`@modelcontextprotocol/sdk` 1.30）以及 schema 版本兼容修复发布为 `maestro-flow@0.5.59`。发布必须证明 Git tag、npm tarball、GitHub Release、docs-site 与 fresh consumer 使用同一 release commit，且 registry 下发的 tarball 与本地 consumer 验证过的字节完全一致。

## Release Identity

- previous tag：`v0.5.58`（指向 `be4cf1f8`）
- closure boundary：`5375fb58`（v0.5.58 发布后的 closure knowhow 补录，不计入产品统计）
- product range：`5375fb58..ef797e7a`
- product statistics：4 commits，91 files，2,328 insertions，1,167 deletions
- product commits：
  - `060b0988` fix(schema): forward-compatible version handling to prevent silent state.json downgrade
  - `3ab38e97` feat(dashboard,docs-site): migrate client routing from react-router-dom to wouter
  - `fb551951` chore: bump version to 0.5.59
  - `ef797e7a` docs: add v0.5.59 release notes
- final release commit：`ef797e7a445e169d245fe9f9b38ab2118419a956`
- annotated tag：`v0.5.59`（tag object `c83f80aa`，peeled 指向 `ef797e7a`）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.59>（published，非 draft，非 prerelease，publishedAt 2026-07-30T06:32:33Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.59>（latest=0.5.59）
- Docs workflow：<https://github.com/catlog22/maestro-flow/actions/runs/30519862985>（success，head `ef797e7a`）

## Knowledge-First Discovery

发布开始时通过文件读取加载并核验最新配方：

- `RCP-20260712-maestro-flow-release`（基础发布流程：版本三处同步 + tag + GitHub Release + npm publish）；
- `RCP-20260728-maestro-flow-release-closure-v0.5.58`（最新闭环：clean worktree、版本面显式枚举、lockfile `packages[""]` 漂移修复、attestation LF 边界、双 consumer provenance）。

由最新 closure 确定流程：先验证未提交 WIP 可构建、冻结产品范围、用 `npm version --no-git-tag-version` 同步所有版本面（含 lockfile `packages[""]`）、生成 mirrors、从 clean worktree 跑 `prepublishOnly`、发布经过 local consumer 验证的 exact tgz、再做 registry consumer provenance 验证。

## Pre-Release WIP Verification

起始 worktree 非 clean：含一套未提交的客户端路由迁移 + 依赖升级 + dashboard 新功能（16 modified + 2 new `router.tsx`）。决策为「commit 所有并发布」，但发布前先证明可构建：

- 路由迁移采用**别名 shim** 方案：新增 `src/client/router.tsx`（wouter 实现，导出 `BrowserRouter/Navigate/Route/Switch/Link/NavLink/useParams/useNavigate/useLocation`），通过 `vite.config.ts` 的 `resolve.alias` 与 `tsconfig.json` 的 `paths` 把 `react-router-dom` 透明转发到 shim，28 个源文件导入语句零改动。
- 先 materialize 新依赖（wouter 3.10.0、@hono/node-server 2.0.12、MCP SDK 1.30.0、hono 4.12.32），再依次跑 root `npm run build`、dashboard `vite build && tsc -p tsconfig.node.json`、docs-site `tsc && vite build`，三者均 exit 0；改动测试 `issue-mcp-server.test.ts` 18/18 通过。
- 确认 major 依赖升级未破坏 `src/`（root build 通过，5 个 lifecycle native binaries verified）。

验证通过后才提交 WIP（`3ab38e97`），再做版本 bump。

## Required Gates

从 clean worktree（Phase 2-4 提交后 status 为空）执行 `npm run prepublishOnly`，exit 0：

- invocation policy lint 通过（maestro-next/maestro/maestro-ralph/maestro-companion 为唯一自动入口）；
- session-run prompt lint：18 commands、45 skills；
- docs reference in sync（`reference.md` ✓）；
- Session/Run contract parity：21 checks；
- search-ranking source tests：root 104 + dashboard 51 = 155/155，0 failures；
- built search-ranking attestation：`{"ok":true,"mode":"built"}`（bootstrap byte boundaries valid，v0.5.58 的 `.gitattributes eol=lf` 修复持续生效）；
- Session/Run release-machine parity：accept-reuse applied/replayed/usage 与 mutations rejection 通过；
- 25 Codex agents schema/parity 通过；
- mirror lint 覆盖 `.agy`、`.agents`、`.codex` 并通过；63 Codex skills 版本戳更新为 `0.5.59`。

未额外运行全量 `npm test`；发布依据项目定义的 `prepublishOnly` release gates、clean build 与两次 fresh consumer runtime proof（local tgz + registry）。

## Package Proof

最终 tgz 从 release commit `ef797e7a` 的 clean worktree 生成并直接发布：

```text
filename: maestro-flow-0.5.59.tgz
size: 8,882,607 bytes
unpacked: 44,359,867 bytes
files: 5,990
shasum: 38cf45dca09403d206b12e5cc100d88453b39aea
integrity: sha512-ai1eKBf2w2h6d+z/DKc5K2L0T1mSiBG09WMQ9LAh/zph1CcSuoskdPTF5rD55EVozWcSEE175ZjGX2xS4u7oFw==
```

包内容断言：`.pyc=0`、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、package/CLI/skill=`0.5.59`、ESM exports=29。

local tgz fresh consumer 与 registry fresh consumer 均验证：installed version=`0.5.59`、arch-kb 存在、ESM exports=29 可加载。registry consumer 的 lockfile `resolved` 为 `https://registry.npmjs.org/maestro-flow/-/maestro-flow-0.5.59.tgz`，`integrity` 与发布前本地 pack 完全相同（字节级 provenance 一致）。

## Problems Found and Durable Fixes

### 1. 起始 worktree 非 clean，含未提交路由迁移

基础 recipe 要求 clean worktree。本次起始有 18 个未提交文件（路由迁移 + 依赖 major 升级 + dashboard 新功能）。正确处理：先 materialize 依赖并跑三套构建 + 改动测试证明可构建，再提交为产品 commit，使 worktree 在跑 `prepublishOnly` 前恢复 clean。不能在未验证构建的情况下把半成品路由迁移直接推上不可逆的 npm 发布。

### 2. 路由迁移完整性须看别名而非导入语句

初看 28 个源文件仍 `import ... from 'react-router-dom'` 而该依赖已从 package.json 移除，疑似迁移未完成、构建将崩。核验 `vite.config.ts`/`tsconfig.json` diff 后确认：二者均把 `react-router-dom` 别名到本地 `router.tsx` shim，导入语句无需改动。教训：判断别名化迁移完整性要检查 bundler alias + tsconfig paths，而非仅 grep 导入语句；最终以真实 build 为准。

### 3. 用 `npm version --no-git-tag-version` 规避 lockfile 漂移

v0.5.58 曾漏同步 root `package-lock.json` 的 `packages[""]`。本次直接用 `npm version 0.5.59 --no-git-tag-version`（root + docs-site），它会同时更新 `package.json` 与 `package-lock.json` 的 top-level 及 `packages[""].version`，从机制上消除手改漏项。验证四处版本面均为 `0.5.59`，dashboard/tui 保持 `0.1.0`。

### 4. tag push 遭遇瞬时 schannel TLS 握手失败

`git push origin v0.5.59` 首次报 `schannel: failed to receive handshake, SSL/TLS connection failed`（exit 128），master push 已成功。本地 tag 已建，直接重试 `git push origin v0.5.59` 成功。教训：Windows schannel 的瞬时 TLS 失败可重试；每次 push 后用 `git ls-remote origin refs/tags/<tag>^{}` 核验 remote peeled commit，确认 tag 真正落到远端且指向正确 release commit。

### 5. canonical clean checkout 跑门禁（非独立 pristine worktree）

v0.5.58 为证明 clean-checkout 可复现性使用了独立 detached worktree。本次在 Phase 2-4 提交后 canonical checkout 已 clean，且 `.gitattributes` 的 LF 修复持续生效（built attestation 通过），故直接在 canonical checkout 跑 `prepublishOnly`，`build:mirrors` 确定性再生成未产生 diff（status 保持 clean）。tgz 产物 `maestro-flow-0.5.59.tgz` 未被 gitignore，保持 untracked、不提交。

## Publish and Verification

顺序：

1. push `master`（`5375fb58..ef797e7a`）；
2. 创建并 push annotated tag `v0.5.59`（首次 TLS 失败，重试成功）；
3. 用 `.release-notes-v0.5.59.md` 创建 GitHub Release；
4. `npm publish ./maestro-flow-0.5.59.tgz --access public`（发布预打包 tgz 不重跑 lifecycle，发布字节即验证字节）；
5. 验证 npm latest/version/shasum/integrity/tarball；
6. 验证 remote master/tag peeled commit、GitHub Release、Docs workflow；
7. 从 registry 新建 consumer 并核对 lockfile provenance。

发布后结果：npm `latest=0.5.59`，registry shasum/integrity 与本地 pack 完全一致；remote master 与 tag peeled commit 均为 `ef797e7a`；GitHub Release published、非 draft、非 prerelease；Docs workflow success（head `ef797e7a`）；registry consumer 完整通过。

本 closure knowhow 作为 release tag 之后的独立 commit force-add 到 `master`，不移动 `v0.5.59`。

## Reusable Checklist

1. 起始 worktree 非 clean 时，先 materialize 依赖 + 跑全部构建与改动测试证明可构建，再提交为产品 commit，最后才跑 release 门禁。
2. 别名化迁移（alias shim）的完整性看 bundler alias + tsconfig paths，并以真实 build 为准，不要只 grep 导入语句。
3. 版本 bump 用 `npm version <ver> --no-git-tag-version` 同步 package.json + package-lock.json（含 `packages[""]`），再显式核验 root/docs-site 四处版本面 + changelog + mirrors。
4. 从 clean worktree 跑 `npm run prepublishOnly` 作为 release gate；built attestation 通过即证明 LF 边界修复持续有效。
5. 只发布经过 package audit 与 local fresh consumer 验证的 exact tgz；发布预打包 tgz 不重跑 lifecycle。
6. tag push 遇瞬时 TLS 失败直接重试，并用 `git ls-remote ... ^{}` 核验 remote peeled commit。
7. 发布后核对 registry lockfile `resolved`/integrity 与本地 pack 一致（字节级 provenance）、remote peeled tag、Release 与 Docs workflow。
8. closure knowhow 独立 force-add 提交，不移动 release tag；tgz 产物保持 untracked。

## Related

- `[[knowhow-rcp-20260728-maestro-flow-release-closure-v0-5-58]]`
- `[[knowhow-rcp-20260727-maestro-flow-release-closure-v0-5-57]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.59.md`
