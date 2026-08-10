---
title: "Maestro Flow v0.5.69 发布闭环：确定性 ObjC/Swift 结构解析 + Windows 规范路径修复 + release-machine 认证图边界"
description: "记录 v0.5.69 发布：PR #23（kg 确定性 ObjC/Swift 结构解析）合入后的全流程发布，含 Windows 11 个测试回归修复（external-surface canonicalPath posix 归一化）、release-machine 认证图拦截（plugin-engine 非字面量动态 import）与 docs-site 版本漂移修正；两轮门禁、tgz 直发 npm 成功"
type: recipe
category: release
created: "2026-08-10T21:30:00+08:00"
tags: [发布, npm, GitHub, provenance, kg, objc, swift, windows, release-machine, E413]
status: active
source: "v0.5.69"
---

# Maestro Flow v0.5.69 发布闭环：确定性 ObjC/Swift 结构解析

## Goal

把 PR #23（`feat(kg): add deterministic Objective-C/Swift structural resolution`，squash `7804f21b`）发布为 `maestro-flow@0.5.69`。发布前修复该分支在 Windows 的 11 个测试回归（含 1 个产品级 bug）与 1 个 release-machine 认证图拦截；发布门禁第二轮一次通过。v0.5.64 的四项修复（build 引号、release-machine node -e 数量、search `--limit` 契约、E413 .cache 排除）持续生效。

## Release Identity

- previous tag：`v0.5.68`（`bc89ecf7`）
- product range：`v0.5.68..5589165b`
- product statistics：2 commits，78 files，+15418 / −1212（bump `a222a80b` 与 release notes `c4d27bbd` 为版本期提交，不计入产品统计）
- product commits：
  - `7804f21b` feat(kg): add Objective-C cross-language resolution (#23)（squash，78 files）
  - `8b5b1ed1` fix(kg): normalize external-surface canonical paths and test expectations to posix on Windows
  - `5589165b` fix(kg): keep plugin-engine out of the certified release-machine graph
- 版本期提交：`a222a80b` chore(bump 0.5.69)（37 files：六处版本面 + 32 mirrors）、`c4d27bbd` docs(release notes)
- final release commit：`5589165bf9166eb2e90df7a78d1a02e58ed27a9d`
- annotated tag：`v0.5.69`（remote peeled 指向 `5589165b`，一次推送成功，无 force-move）
- GitHub Release：<https://github.com/catlog22/maestro-flow/releases/tag/v0.5.69>（Latest，published，非 draft，非 prerelease，publishedAt 2026-08-10T13:12:12Z）
- npm：<https://www.npmjs.com/package/maestro-flow/v/0.5.69>（latest=0.5.69）

## Knowledge-First Discovery

- `RCP-20260808-maestro-flow-release-closure-v0.5.67`（最新闭环：chain 参数穿透发布 + docs-site lockfile 漂移修正手法 + 六处版本面清单）；
- `RCP-20260807-maestro-flow-release-closure-v0.5.64`（4 轮门禁拦截记录：build 引号、release-machine 硬编码、search --limit 契约、E413 排除）；
- `RCP-20260712-maestro-flow-release`（基础流程）。

## Windows 回归修复（发布前置）

PR #23 在 macOS/Linux 验证通过，但 canonical identity path 设计（全平台 posix 形式）在 win32 有 11 个测试失败（基线 v0.5.68 在 Windows 全绿 139 passed，可证为 PR 引入）：

1. **产品级 bug（6 测试）**：`collectExactFile` 的 `canonicalPath` 直接取 `realpathSync`（win32 反斜杠），与 `canonicalizeCodeFilePath` 的 posix 规范身份不一致 → `stageStructuralReferences` 校验抛 `Invalid StructuralReference: origin.filePath must be a canonical absolute`，Windows 上含 external-surface 的 kg sync 直接失败。修复：external-surface-manifest.ts 返回前归一化 `canonicalPath`（win32 仅替换反斜杠，POSIX 不动以保留合法文件名字节）。
2. **测试期望漂移（4 测试）**：orchestrator / code-extractor-streaming / exact-external-file-scan / cross-language-e2e / structural-resolution-integration / external-surface-manifest 六处断言用 `realpathSync`/`join` 原生分隔符与规范身份路径直接比较。修复：各测试文件加 `toPosixPath`（win32 条件替换）归一化期望；e2e 的 `LIKE` 模式与 `externalFiles` 数组同样归一化；onProgress 回调内比较用 posix、renameSync 仍用原生路径。
3. **超时（1 测试）**：7,515-file Pods 用例在 Windows 建文件耗时 >5s 默认超时。修复：`it(..., 30_000)` 放宽（测试语义正确，非递归泄漏）。

## Required Gates

clean worktree 跑 `npm run prepublishOnly`：

- **第一轮被拦截**：`check:search-ranking-release-machine:built` 报 `NONLITERAL_DYNAMIC_IMPORT: every dynamic import must have one literal specifier`，`caller=dist/src/graph/kg/extraction/code/plugin-engine.js:347`（`import(pathToFileURL(fullPath).href)` 加载用户插件脚本）。
  - 根因：PR #23 让 `engine.ts` import code-extractor 的 `prepareExternalSurfaceScan`（kg init freshness 预检），把 plugin-engine 拖入 search-ranking release-machine 认证图；v0.5.68 时该 import 不存在，认证图不含 plugin-engine，门禁通过。
  - 修复：`prepareExternalSurfaceScan` + `PreparedExternalSurface{File,Scan}` 迁到轻量 `external/external-surface-manifest.ts`（仅 node:fs/crypto/path），engine.ts / orchestrator.ts / kg-sync-hook.ts 改指，code-extractor.ts 重导出兼容（本地使用仍需 import，re-export 不提供局部作用域名）。
  - 排查手法：临时给 check 脚本的 UNEXPECTED 分支加 `details` 输出（错误被非 ReleaseMachineError 包装丢失 details），复跑 `node scripts/check-search-ranking-release-machine.mjs --built` 拿到 caller/line/expression。
- **第二轮 exit 0 全过**：invocation policy lint ✓；session-run prompt lint（18 commands、14 skills）✓；docs reference in sync ✓；Session/Run contract parity 22 PASS ✓；search-ranking source tests + built attestation ✓；Session/Run release-machine parity ✓；mirrors 32/32 Codex skills 版本戳=0.5.69、25 agents schema/parity ✓。kg 全量 `npm run test:kg`（= vitest run src/graph）562 passed / 1 skipped。

## Package Proof

tgz 从 release commit `5589165b` 的 worktree 生成并直接发布（E413 排除持续生效）：

```text
filename: maestro-flow-0.5.69.tgz
size: 19,118,043 B（约 19 MB）
unpacked: 92,451,270 B（约 92.5 MB，v0.5.68 为 91.5 MB，同量级）
files: 5,336
shasum: 75d0984373cbd2d11338d7082f03754524a29887
integrity: sha512-78OsDE3BS+Yg1TtaO7HpjxQhEtA1WNkcPwKmk8WspFEp+XepyU+vFvliASafh3wOpPNOcp/IZQSUvLfqKextxg==
```

包内容断言：`.pyc=0`、`.cache=0`（E413 排除持续生效）、`resources/arch-kb/index.json=1`、`dist/src/index.js` 与 `bin/maestro.js` 存在、32/32 codex skill 版本戳=0.5.69（tgz 内解包核对）。

## Publish and Verification

顺序：

1. push `master`（`7804f21b..5589165b`，含两个产品修复提交与版本期提交）；
2. annotated tag `v0.5.69` 一次创建并推送成功；
3. `git ls-remote origin refs/tags/v0.5.69^{}` = `5589165b` 核验 remote peeled = release commit；
4. `gh release create v0.5.69 --title v0.5.69 --notes-file .release-notes-v0.5.69.md`；`gh api .../releases/latest` = v0.5.69；
5. `npm publish ./maestro-flow-0.5.69.tgz --access public`（一次成功，无 E413）；
6. 验证 npm `version=0.5.69`、`dist.shasum=75d09843...`/`dist.integrity=sha512-78OsDE3...`/`unpackedSize=92451270` 与本地 pack 字节级一致；dist-tags latest=0.5.69；GH Release Latest、published、非 draft、非 prerelease。
   - 注意：publish 成功后 `npm view` 立即查询会 404（registry 传播延迟，`_npmOperationalInternal` 已可见），等 ~8s 重查即正常。

## Problems Found and Durable Fixes

1. **PR 跨平台验证缺口**：PR #23 只验证 macOS（TMPDIR=/private/tmp），Windows 上 canonical identity path（全平台 posix 设计）与 `realpathSync` 原生分隔符混用导致 11 个失败。**清单增量：PR 合入后、发布前在 Windows 跑一次 `npm run test:kg` 基线对比（v0.5.68 全绿 139 passed vs PR 后 11 failed），用 git worktree + node_modules junction 快速验证基线**。
2. **release-machine 认证图边界**：认证图随静态 import 链变化；新增 engine→code-extractor 的 import 会把含非字面量动态 import 的模块拖入并拦截门禁。**清单增量：任何把 kg 重模块挂到 engine/commands/search 的改动，跑 built 阶段核对；`prepareExternalSurfaceScan` 这类轻量预检函数应放在 fs/crypto 级模块，避免拖入 tree-sitter/plugin-engine**。
3. **docs-site 版本漂移复发**：v0.5.68 bump 遗漏 docs-site（停于 0.5.67），本次按 v0.5.67 手法在 docs-site 目录 `npm version 0.5.69 --no-git-tag-version` 一并修正。**清单增量：bump 后核对 docs-site/package.json + package-lock.json 与根版本一致（六处版本面检查含此项）**。

## Reusable Checklist（沿用 v0.5.67 + 本次增量）

1. 沿用 v0.5.67 完整清单（WIP 先 build/测试、六处版本面、clean worktree prepublishOnly、exact tgz、ls-remote 核验、registry provenance 核对）。
2. E413 排除修复后，每次 pack 核对 unpackedSize 与上版同量级（本次 92.5MB ≈ 上版 91.5MB）与 `.cache=0`。
3. 门禁后 `resources/arch-kb` 会再生成（builtAt + 行尾差异），pack 前 `git checkout -- resources/arch-kb` 恢复，保持 tgz 自 release commit。
4. **新增**：PR 合入后先在 Windows 跑 `npm run test:kg`，与基线 tag 对比（git worktree + mklink node_modules）；发现 canonical path 断言失败时用「win32 条件 posix 归一化」统一期望，不改产品分隔符语义（产品规范身份 = posix）。
5. **新增**：`check:search-ranking-release-machine:built` 拦截时，临时给 UNEXPECTED 分支补 `details` 输出定位 caller/line；修复方向是切断认证图路径（轻模块迁移），而非放宽非字面量动态 import 检查。
6. **新增**：bump 时核对 docs-site/package.json 与 package-lock.json 是否停在旧版（v0.5.68 复发过一次）；`npm version` 只更新 package.json，lockfile 同命令内同步。
7. npm publish 后 `npm view` 404 属传播延迟，等数秒重查，不要重复 publish。

## Related

- `[[knowhow-rcp-20260808-maestro-flow-release-closure-v0-5-67]]`
- `[[knowhow-rcp-20260808-maestro-flow-release-closure-v0-5-66]]`
- `[[knowhow-rcp-20260712-maestro-flow-release]]`
- Release notes：`.release-notes-v0.5.69.md`
