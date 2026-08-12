---
title: Maestro Sidebar 多平台编译发布与 Release Note 下载链接门禁
type: recipe
explicitId: rcp-20260812-maestro-sidebar-release
created: 2026-08-12T15:32:54.439Z
---

## Goal

以可复现、可审计的方式编译并发布 Maestro Sidebar 的 Windows、Linux、macOS arm64 与 macOS x64 安装包。GitHub Release Note 必须包含每个真实上传资产的直接下载链接；只有 Release Note 链接完整且 Release 已退出 draft 状态，发布才算完成。

## Source of Truth

- Workflow: `.github/workflows/publish-sidebar.yml`
- Release helper: `scripts/sidebar-release.mjs`
- Operational runbook: `maestro-sidebar/docs/RELEASE.md`
- Product manifest: `maestro-sidebar/package.json`
- Tauri config: `maestro-sidebar/src-tauri/tauri.conf.json`
- Rust manifest: `maestro-sidebar/src-tauri/Cargo.toml`

## Version Contract

Sidebar 使用独立 tag `sidebar-vX.Y.Z`。以下六个版本面必须全部等于 `X.Y.Z`：

1. `maestro-sidebar/package.json#version`
2. `maestro-sidebar/package-lock.json#version`
3. `maestro-sidebar/package-lock.json#packages[""]#version`
4. `maestro-sidebar/src-tauri/tauri.conf.json#version`
5. `maestro-sidebar/src-tauri/Cargo.toml` package version
6. `maestro-sidebar/src-tauri/Cargo.lock` 中 `maestro-sidebar` package version

发布前运行：

```bash
node scripts/sidebar-release.mjs check-version --tag sidebar-vX.Y.Z
```

任何版本漂移都必须阻断 tag 发布，不能依赖 Tauri 构建时隐式选择版本。

## Local Build and Verification

```bash
cd maestro-sidebar
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cd ..
node scripts/sidebar-release.mjs check-version --tag sidebar-vX.Y.Z
npx vitest run scripts/__tests__/sidebar-release.test.mjs
```

`npm run build` 调用 `tauri build`，本机产物位于 `maestro-sidebar/src-tauri/target/release/bundle/`。本地构建只证明当前宿主平台；四平台正式资产以 GitHub Actions 为准。

## Tag and CI Sequence

```bash
git push origin master
git tag -a sidebar-vX.Y.Z -m "Maestro Sidebar vX.Y.Z"
git push origin sidebar-vX.Y.Z
```

`Publish Maestro Sidebar` workflow 的固定顺序：

1. `prepare`：显式 checkout `refs/tags/sidebar-vX.Y.Z`，证明 tag commit 等于 `HEAD`，验证六处版本一致；输出 immutable full commit SHA；创建或复用且仅复用一个 draft Release，输出 numeric `release-id`。
2. `build`：全部按 prepare 输出的 SHA checkout；Windows x64、Linux x64、macOS arm64、macOS x64 并行执行 Tauri build，所有矩阵 leg 都把同一个 `releaseId` 传给 `tauri-action`。per-tag concurrency 禁止 tag push 与手动重跑并发修改同一 draft。
3. `finalize`：同样按 prepare SHA checkout 并把该 SHA 写入 Release Note；通过 `GET /releases/{release_id}` 读取 draft 的实际 assets；draft 不能依赖 `/releases/tags/{tag}` 查找。draft asset API 的 `browser_download_url` 可能包含临时 `untagged-*`，所以只信任真实 asset name，并据 canonical tag 生成最终 URL。
4. `render-notes`：按平台分组，把每个 asset 生成为 `https://github.com/<repo>/releases/download/<canonical-tag>/<encoded-asset-name>`。
5. `verify-release`：要求 Windows x64、Linux x64、macOS arm64、macOS x64 全部存在，每个 URL 合法，Release Note 包含每个资产 URL。
6. publish：再次读取远端 tag 并确认仍指向 prepare SHA；用一次 PATCH 同时提交 canonical `tag_name`、`target_commitish`、title、完整 body、`draft=false`、`prerelease=false`、`make_latest="false"`，避免正文 PATCH 把 draft tag 临时化或留下正文/状态半提交。
7. post-publish verify：验证 PATCH 返回的 Release 已非 draft 且所有链接仍存在。

稳定发布只接受严格 `sidebar-vX.Y.Z`，不接受 prerelease suffix 或带前导零的版本段。

## Release Note Download-Link Gate

Release Note 不能只写“从下方下载”或依赖 GitHub 页面自动展示资产。正文必须有 `## Downloads`，并显式列出每个真实上传资产的 Markdown 直链：

```text
https://github.com/catlog22/maestro-flow/releases/download/sidebar-vX.Y.Z/<asset-name>
```

直链必须由 GitHub Release API 返回的真实 asset name 与 canonical tag 组合生成。draft 的 `browser_download_url` 可能指向临时 `untagged-*`，不能直接写入最终 Release Note。不要硬编码 Tauri 文件名，因为 bundle 名称、架构后缀和扩展名可能随 target 或 Tauri 版本变化。

## Post-Release Verification

```bash
TAG=sidebar-vX.Y.Z
gh run list --workflow publish-sidebar.yml --limit 5
gh release view "$TAG"
gh api "repos/catlog22/maestro-flow/releases/tags/$TAG" \
  --jq '{draft,html_url,assets:[.assets[]|{name,browser_download_url}]}'
```

验收标准：workflow 为 success；`draft=false`；Windows x64、Linux x64、macOS arm64、macOS x64 安装包全部存在；Release Note 的 Downloads 区包含每个 API 返回的 `browser_download_url`；至少实际打开一个目标平台链接验证可以下载。

## Failure Recovery

- build/finalize 失败时同一个 numeric release ID 对应的 Release 保持 draft；禁止手动发布仍带 assembly placeholder 的 draft。
- 若 shipped bytes 会变化，修复后必须使用新版本和新 tag，不移动已发布 tag。
- 若只是 CI 临时上传失败且 tag/源码正确，可删除不完整 draft，保留 tag，再用 workflow_dispatch 输入原 tag 重跑：

```bash
gh release delete sidebar-vX.Y.Z --yes
```

- 下载链接校验失败时，应补齐缺失资产或修复生成逻辑；不得绕过 verify-release 手动公开。
- 当前 workflow 未配置 macOS signing/notarization；未配置前不得声称产物已签名或公证。

## Why This Matters

Tauri 的矩阵 job 可以成功上传资产，但静态 Release body 不知道最终文件名。若四个 job 各自按 tag 发现或创建 draft，还会产生并发竞态；draft 也不能可靠通过 REST tag endpoint 获取，而且 draft 下载地址可能使用临时 `untagged-*`。因此必须先创建唯一 draft 并把 numeric release ID 传给所有 build/finalize 步骤，最终按真实 asset name 生成 canonical tag URL，并用单次 PATCH 原子公开。若没有 finalize 阶段，Release Note 很容易只有泛化文案，用户必须自己寻找 Assets，且自动化无法证明四平台与链接完整。
