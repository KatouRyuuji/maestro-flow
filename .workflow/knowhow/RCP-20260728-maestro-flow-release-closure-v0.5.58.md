---
title: "Maestro Flow v0.5.58 发布闭环：知识治理、attestation LF 与 lockfile 版本面"
description: "记录 v0.5.58 从 Maestro Search 加载发布配方、知识治理版本冻结、Windows clean checkout 修复到 npm、GitHub、Pages 和 registry consumer 验证的完整证据"
type: recipe
category: release
created: "2026-07-28T22:00:00+08:00"
tags: [发布, 知识治理, clean-checkout, attestation, eol-lf, lockfile, npm, GitHub]
status: active
source: "v0.5.58"
---

# Maestro Flow v0.5.58 发布闭环

## Goal

把 Run 知识增量、曝光/消费区分、候选保守晋升、确定性审计、安全剪枝、知识协调与 Ralph Run Executor 迁移发布为 `maestro-flow@0.5.58`。发布必须证明 Git tag、npm tarball、GitHub Release、docs-site 和 fresh consumer 使用同一 release commit，并修复 Windows clean checkout 暴露的 attestation bootstrap CRLF 边界问题。

## Release Identity

- previous tag：`v0.5.57`
- product range：`a5fb0597..1cfa6d0b`（`a5fb0597` 是 v0.5.57 发布后 closure，不计入产品统计）
- product statistics：29 commits，99 files，9,367 insertions，412 deletions
- release metadata commit：`265d9e90`
- clean-checkout LF fix：`4ab56fdc`
- root lockfile sync：`be4cf1f8`
- final release commit：`be4cf1f8f7931574c720abe0dc8d813fb29abc21`
- annotated tag：`v0.5.58`（tag object `cfde8681`，指向 `be4cf1f8`）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.58>
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.58>
- Docs workflow：<https://github.com/catlog22/maestro-flow/actions/runs/30364806811>（success，head `be4cf1f8`）

## Knowledge-First Discovery

发布开始时通过 Maestro Search/Load 命中并加载：

- `Maestro-Flow Release 发布流程`；
- `Maestro-Flow 发布闭环：dirty worktree、docsite 与 fresh consumer`；
- `Maestro Flow v0.5.57 发布闭环`。

由最新 recipe 确定流程：冻结产品范围、同步所有版本面、生成 mirrors、从 release commit 建 detached clean worktree、先 clean build、播种 ignored knowhow proof、跑 `prepublishOnly`、发布经过 local consumer 验证的 exact tgz、再做 registry consumer 验证。

## Required Gates

最终从 `be4cf1f8` 创建 pristine detached worktree `D:/maestro2-release-v0.5.58-be4cf1f8`，执行：

1. root/docs-site `npm ci --no-audit --no-fund`；
2. root `npm run build`；
3. docs-site `npm run build`；
4. non-overwriting seed `.workflow/knowhow`；
5. `npm run prepublishOnly`。

结果：

- invocation policy lint 通过；
- session-run prompt lint：18 commands、45 skills；
- docs reference in sync；
- Session/Run contract parity：21 checks；
- search-ranking source tests：root 104 + dashboard 51，155/155 通过；
- built search-ranking attestation 通过；
- Session/Run release-machine parity 通过；
- 25 Codex agents schema/parity 通过；
- mirror lint 覆盖 `.agy`、`.agents`、`.codex` 并通过；
- docs-site production build 通过（仅有既有 >500 kB chunk warning）。

未额外运行全量 `npm test`；发布依据项目定义的 `prepublishOnly` release gates、clean build 和两次 fresh consumer runtime proof。

## Package Proof

最终 tgz 从 `be4cf1f8` clean worktree 生成并直接发布：

```text
filename: maestro-flow-0.5.58.tgz
size: 8,170,588 bytes
unpacked: 39,148,516 bytes
files: 5,194
shasum: 68acd6d361559b5914041466649db597f81d43d4
integrity: sha512-Hs/p/jUiiWb24As4UymuIDkCKEQXoDk+fU6kjP65CFzhKb+DMYdZF0N+NAwQoWH4JZUiJKNDneb326iNPy7Dfg==
```

包内容断言：`.pyc=0`、first-tier Quick=0、Companion=4、prepare contracts=22、`resources/arch-kb/index.json=1`、Codex Maestro skill version=`0.5.58`。

local tgz 与 registry fresh consumer 均验证：package/CLI/skill=`0.5.58`、ESM exports=29、Quick=0、Companion=4、arch-kb 存在。registry lockfile `resolved` 为 `https://registry.npmjs.org/maestro-flow/-/maestro-flow-0.5.58.tgz`，integrity 与发布前完全相同。

## Problems Found and Durable Fixes

### 1. Attestation bootstrap 在 Windows fresh checkout 失去字节边界

首次 clean `prepublishOnly` 的 source tests 和 build 通过，但 built gate 报：

```text
certified bootstrap byte boundaries are invalid
```

`scripts/search-ranking-module-attestation.mjs` 内嵌可执行 bootstrap，并用带 `\n` 的精确 byte delimiters 提取。canonical 文件为 LF（CR=0），Windows fresh checkout 因 `core.autocrlf` 变为 CRLF（CR=1,724），导致 delimiter 不存在。

耐久修复 `4ab56fdc`：

```gitattributes
scripts/search-ranking-module-attestation.mjs text eol=lf
```

删除旧 worktree 后从修复 commit 创建全新 checkout，确认该文件 CR=0，再完整跑过 built gate。不能在失败 worktree 手工归一化后宣称 clean proof。

### 2. Root package-lock 版本面长期漂移

release metadata 已同步 root package、docsite package/lock 和 changelog，但最终检查发现 root `package-lock.json` 顶层及 `packages[""]` 仍为 `0.5.54`。根因是常规 `rg --files` 受 ignore 规则影响没有列出该 tracked 文件，而基础 recipe 明确要求同步 lockfile。

修复 `be4cf1f8`：两处统一到 `0.5.58`，重新创建第三个 pristine worktree，从 `npm ci`、build、prepublish、pack、consumer 全部重跑。发布前版本面检查必须使用明确路径或 `git ls-files package-lock.json`，不能只依赖 ignore-aware 文件枚举。

### 3. 所有命令必须显式绑定 clean worktree cwd

首次并行 `npm ci` 未绑定 cwd，误在 canonical checkout 执行并被 Windows node_modules 文件锁拒绝。随后统一使用支持 `cwd` 的执行入口；由该误操作产生的 lockfile diff 经核验后转化为真实版本面修复。发布自动化应将 cwd 作为命令身份的一部分并在执行前输出 `git rev-parse --show-toplevel`。

### 4. Knowhow seed 必须 non-overwriting

完整复制 canonical `.workflow/knowhow` 会覆盖 clean checkout 中已 tracked 的 closure 文件并造成 dirty status。正确方式是 non-overwriting seed（`cp -Rn source/. target/`），只补缺失的 ignored proof artifacts，保留 release commit 的 tracked bytes。

## Publish and Verification

顺序：

1. push `master` 到 `be4cf1f8`；
2. 创建并 push annotated tag `v0.5.58`；
3. 用 `.release-notes-v0.5.58.md` 创建 GitHub Release；
4. `npm publish ./maestro-flow-0.5.58.tgz --access public`；
5. 验证 npm latest/version/shasum/integrity/tarball；
6. 验证 remote master/tag peeled commit、GitHub Release、Docs workflow；
7. 从 registry 新建 consumer 并核对 lockfile provenance。

发布后结果：npm `latest=0.5.58`；remote master、tag peeled commit 均为 `be4cf1f8`；GitHub Release published、非 draft、非 prerelease；Docs workflow success；registry consumer 完整通过。

本 closure knowhow 作为 release tag 之后的独立 commit force-add 到 `master`，不移动 `v0.5.58`。

## Reusable Checklist

1. 明确先用 Maestro Search/Load 获取 release recipe，再以文件读取核验证据。
2. 版本面显式枚举 root package/lock、docsite package/lock、changelog、release notes 和 generated mirrors。
3. 对嵌入代码、hash、byte delimiter 敏感文件，在 Windows pristine checkout 检查 CR 数和 `.gitattributes`。
4. 每次 release-preparation fix 后都删除旧 worktree，从新 commit 重建 pristine checkout并重跑全部 gates。
5. 所有 clean commands 显式绑定 cwd；播种 ignored proof 时禁止覆盖 tracked 文件。
6. 只发布经过 package audit 与 local fresh consumer 验证的 exact tgz。
7. 发布后核对 registry lockfile `resolved`/integrity、remote peeled tag、Release 和 Docs workflow。
8. closure knowhow 独立提交，不移动 release tag。

## Related

- `[[knowhow-rcp-20260727-maestro-flow-release-closure-v0-5-57]]`
- `[[knowhow-rcp-20260720-maestro-flow-release-closure-v0-5-53]]`
- Release notes：`.release-notes-v0.5.58.md`
