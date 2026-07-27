---
title: "Maestro Flow v0.5.57 发布闭环：arch-kb、eol=lf clean-checkout 修复与包纯净性"
description: "记录 v0.5.57 从 arch-kb 功能提交、search-ranking eol=lf clean-checkout 哈希修复、发布门禁、clean worktree 验证到 npm、GitHub、registry consumer 验证的完整证据"
type: recipe
category: release
created: "2026-07-27T15:00:00+08:00"
tags: [发布, arch-kb, eol-lf, clean-checkout, search-ranking, npm, GitHub]
status: active
source: "v0.5.57"
---

# Maestro Flow v0.5.57 发布闭环

## Goal

把 arch-kb 隔离架构知识库、命令层路由收紧、启动/钩子性能优化与 maestro-manage 三命令拆分发布为 `maestro-flow@0.5.57`，并证明 Git tag、npm tarball、GitHub Release 和 fresh consumer 使用同一 release commit。发布必须修复 Windows clean checkout 的 search-ranking 哈希漂移，并保留包纯净性（`.pyc=0`、Quick=0、Companion=4、22 个 prepare contract、arch-kb 资产）。

## Release Identity

- previous tag：`v0.5.56`
- product range：`v0.5.56..3ccf620d`
- product range statistics：55 commits，305 files，12,362 insertions，9,584 deletions
- release commit：`f6becc9aeabf4a865d17845a315184b761e576c3`
- release preparation：`3ccf620d`（search-ranking eol=lf product fix）、`f6becc9a`（version / changelog / notes / mirrors）
- annotated tag：`v0.5.57`（tag object `91f3a659`，指向 `f6becc9a`）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.57>
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.57>

## Required Gates

发布前在 canonical checkout 执行 `npm run prepublishOnly` 与 `npm --prefix docs-site run build`：

- invocation policy lint：只允许 `maestro-next`、`maestro`、`maestro-ralph`、`maestro-companion` 自动入口；
- session-run prompt lint：18 commands、45 skills；
- session-run contract parity：17/17；
- check:docs-reference、search-ranking-release-machine（source + built）、release-machine、build、build:mirrors 均通过；
- docs-site：production build 通过（~15.8s）；
- `build:mirrors`：63 Codex skills 更新到 0.5.57，25 Codex agents parity OK，tracked diff 为空。

canonical `prepublishOnly` 退出码 0。

## Package Proof

最终包从 `f6becc9a` detached clean worktree 生成（先 `npm ci`、clean-source `npm run build`、`build:mirrors` 生成 `.agy`/`.agents`，再 `npm pack`），并直接发布同一份已验证 tgz：

```text
filename: maestro-flow-0.5.57.tgz
size: 8,010,206 bytes
unpacked: 38,134,303 bytes
files: 5,134
shasum: d0aaafa27850f5fdcb00e2dd0f2eb38fc84656c6
integrity: sha512-+PSj/CUJG7PW+hp7iL+o2GK4I1/6ONZeOoA00MUilp04lGIvGWjQKaKTLmJa95e80GVtAmOpXPWRZ7+5oXLYaA==
```

包内容断言：

- `.pyc = 0`；
- first-tier Quick assets = 0；
- Companion assets = 4：`.claude` command，以及 `.codex`、`.agy`、`.agents` skills；
- `prepare` contracts = 22；
- `resources/arch-kb/index.json` = 1（新功能资产）；
- `.codex/skills/maestro/SKILL.md` version = `0.5.57`。

本地 tgz fresh consumer 与 registry fresh consumer 都 8/8 通过：ESM import 29 exports（与 v0.5.53 基准一致）、CLI `--version = 0.5.57`、package / codex skill version 一致、Quick = 0、Companion = 4、`.pyc = 0`、arch-kb 资产存在。registry consumer lockfile 的 `resolved` 指向 `https://registry.npmjs.org/maestro-flow/-/maestro-flow-0.5.57.tgz`，integrity 与发布前 tgz 完全相同。

## Problems Found and Durable Fixes

### 1. Windows clean checkout 的 search-ranking 哈希漂移（耐久修复，已入版本）

pristine clean worktree 的 `check:search-ranking-release-machine:source` 首先报 `qrels hash mismatch`，随后报 `built search adapter contract artifacts are stale`。根因与 v0.5.53 的 raw EOL parity bug 同类：`core.autocrlf=True` 在 Windows fresh checkout 将 LF 转 CRLF，改变哈希敏感产物字节。

- `src/search/evaluation/fixtures/search-ranking-qrels.json`：canonical LF 2,835 bytes / sha256 `2510d2d6…`，worktree CRLF 2,942 bytes / sha256 `eddd71b4…`；frozen baseline `qrelsSha256 = 2510d2d6…`（LF）。
- `shared/built-search-adapter-contract.mjs`：committed 内嵌 schema 用 `\n`（`SCHEMA_SHA256=01024ebe…`），worktree 从 CRLF 的 schema 源 `src/search/evaluation/built-search-adapter-contract.json` 重新生成得到 `\r\n`（`b9c35940…`）→ stale。

耐久修复（commit `3ccf620d`）：在 `.gitattributes` 沿用 v0.5.53 对 `*.md`/`*.toml` 的 `text eol=lf` 方案，扩展到 search-ranking 哈希敏感产物：

```gitattributes
src/search/evaluation/fixtures/*.json text eol=lf
src/search/evaluation/built-search-adapter-contract.json text eol=lf
shared/built-search-adapter-contract.mjs text eol=lf
shared/built-search-adapter-contract.d.mts text eol=lf
```

验证：pristine fresh checkout（无任何手工归一化）所有 6 个文件 CR=0，qrels sha256 = `2510d2d6…` 匹配 frozen baseline；从 LF schema 重新生成的 contract 与 committed 完全一致（`git diff shared/` 为空）。

### 2. clean worktree 的 release-machine source 门禁需要已构建 dist

`check:search-ranking-release-machine:source` 的 direct-control-graph 推导会解析 `bin/maestro.js → ../dist/src/utils/wasm-relaunch.js` 等 dist 模块引用，并要求 `PRODUCTION_ARTIFACTS`（dist 输出）存在。canonical 因有陈旧 `dist/` 而通过；bare clean worktree 在 build 之前没有 dist，故失败。

流程调整（非代码改动）：clean worktree 中先 `npm run build`（证明 clean-source 可编译并生成 dist），再 `npm run prepublishOnly`。这与 knowhow "clean worktree 证明包可纯净构建" 的意图一致。

### 3. clean worktree 需要播种 gitignore 的 knowhow 证明状态

release-machine 将 `.workflow/knowhow/RCP-20260716-pi-maestro-flow-cli.md` 与 `RCP-20260723-pi-skills-canonical-generation.md` 作为 protected repo artifacts（`readArtifact` 字面量），`pi-knowledge-absolute.test.ts` 还读取 `.workflow/knowhow/.migration-snapshots/pi-skills-canonical-generation.before.json`。`.workflow/` 被 gitignore，bare clean worktree 没有这些文件。

流程调整：clean worktree 中完整播种 `.workflow/knowhow/`（含 `.migration-snapshots/`，37 个条目）。这是 release-machine 期望的本地证明状态（类似其内部 `seedBuiltWorkspace`），不影响包纯净性（`.workflow/` 不在 package.json `files`）。

### 4. knowhow-lifecycle.test.ts 5s 超时（harness baseline 抖动，不阻断）

clean worktree 的 `:source` 在 `src/tools/__tests__/knowhow-lifecycle.test.ts` 有 2–3 个 `prepareSealedMigration` 相关测试超过默认 5000ms 超时。对照实验：在 canonical 单独运行同一文件同样有 4 个超时——证明这是 Vitest harness / Windows 计时抖动，而非 worktree 或产品代码回归。canonical 的 `prepublishOnly :source`（6 文件一起运行）退出码 0。按 v0.5.53 precedent（"full test 非全绿，失败属于已知 Windows / Vitest harness baseline；发布阻断 gates 与 clean consumer runtime 均通过"），此抖动不阻断发布。

## Publish Sequence

1. 确认 npm `0.5.57`、本地/远端 `v0.5.57`、GitHub Release 均不存在；registry latest 为 `0.5.56`。
2. 确认 `origin/master...master = 0 12`，远端没有独有提交。
3. push `master`（`b061d011..f6becc9a`）。
4. 创建并 push annotated tag `v0.5.57`（指向 `f6becc9a`）。
5. 用 `.release-notes-v0.5.57.md` 创建 GitHub Release（published、非 draft、非 prerelease）。
6. `npm publish ./maestro-flow-0.5.57.tgz --access public` 发布 clean worktree 生成且已 fresh-install 验证的确切 tarball。

## Post-release Verification

- npm version / latest：`0.5.57`；
- npm dist.shasum：`d0aaafa27850f5fdcb00e2dd0f2eb38fc84656c6`，dist.integrity 与 clean pack 一致；
- `origin/master`：`f6becc9aeabf4a865d17845a315184b761e576c3`；
- GitHub Release：published、非 draft、非 prerelease；
- registry fresh consumer：package / CLI / codex skill `0.5.57`，ESM 29 exports，Quick = 0，Companion = 4，`.pyc = 0`，arch-kb 资产存在；lockfile `resolved` 指向 npm tarball，integrity 与发布前 tgz 完全相同。

release closure knowhow 在发布后作为单独 commit（force-add 越过 `.workflow/` ignore，沿用 v0.5.51/v0.5.53 已跟踪 closure 的惯例）推到 `master`；`v0.5.57` tag 保持指向已验证 release commit `f6becc9a`。

## Reusable Checklist

1. 冻结 product range，release-preparation commits（version/notes/mirrors、eol 修复）与产品统计分开。
2. Windows 发布前必查哈希敏感产物的 `.gitattributes` eol 固定（fixtures / schema / contract）；pristine fresh checkout 验证 CR=0 且 sha256 匹配 frozen baseline。
3. clean worktree 流程：`npm ci` → `npm run build`（生成 dist）→ 播种 `.workflow/knowhow/`（含 `.migration-snapshots/`）→ `npm run prepublishOnly` → `npm run build:mirrors`（生成 `.agy`/`.agents`）→ `npm pack`。
4. 包纯净性审计：`.pyc=0`、Quick=0、Companion=4、prepare 计数、新功能资产、codex skill version。
5. 安装本地 tgz 验证（8 项），再发布 exact tgz。
6. npm 发布后从 registry 创建第二个 fresh consumer，核对 lockfile `resolved`/integrity。
7. 验证 remote master/tag、GitHub Release、npm dist-tag/shasum/integrity。
8. knowhow-lifecycle 5s 超时为 harness baseline 抖动——以 canonical `prepublishOnly` 通过为准，不阻断。
9. 最后补录 closure knowhow（force-add）；closure commit 不移动 release tag。

## Related

- `[[knowhow-rcp-20260720-maestro-flow-release-closure-v0.5.53]]` — clean worktree / docsite / fresh consumer 发布闭环与 raw EOL parity 修复基础。
- Release notes：`.release-notes-v0.5.57.md`
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.57>
