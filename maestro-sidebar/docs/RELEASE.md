# Maestro Sidebar Build and Release

This runbook covers local validation, multi-platform packaging, GitHub Release publication, and post-release verification for `maestro-sidebar`.

## Release Contract

- Release tags use `sidebar-vX.Y.Z` and must already exist before a manual workflow dispatch.
- The same `X.Y.Z` must appear in `maestro-sidebar/package.json`, `package-lock.json` (root and `packages[""]`), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `maestro-sidebar` package in `src-tauri/Cargo.lock`.
- `.github/workflows/publish-sidebar.yml` builds Windows x64, Linux x64, macOS arm64, and macOS x64 bundles.
- The prepare job proves that the exact `refs/tags/sidebar-vX.Y.Z` commit is checked out, exports that immutable full commit SHA, then creates or reuses exactly one draft GitHub Release and exposes its numeric release ID.
- Every matrix build checks out the exported commit SHA and uploads into that shared numeric release ID. The finalizer also checks out and records the same SHA, then revalidates the remote tag immediately before publication. Per-tag workflow concurrency prevents a tag push and manual rerun from mutating the same draft simultaneously.
- The finalizer reads the draft by numeric release ID, not by the draft-incompatible tag endpoint. Draft asset API URLs may contain a temporary `untagged-*` segment, so the final note derives canonical URLs from the real asset names and `sidebar-vX.Y.Z`. One atomic publish PATCH restores the canonical tag/commit/title, writes the complete note, and sets `draft=false`; only that returned representation is verified.
- A Sidebar release is published with `latest=false`, so it does not replace the main `maestro-flow` release as the repository's Latest release.
- Missing Windows x64, Linux x64, macOS arm64, or macOS x64 assets; invalid asset URLs; missing Release Note links; or a remaining draft state fail the workflow.

## 1. Choose and Synchronize the Version

Use semantic versioning independently from the root `maestro-flow` package.

```bash
cd maestro-sidebar
npm version X.Y.Z --no-git-tag-version
```

Then update `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same version. Refresh the Rust lockfile through Cargo, then return to the repository root:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cd ..
node scripts/sidebar-release.mjs check-version --tag sidebar-vX.Y.Z
```

Do not create the tag until the version contract passes.

## 2. Validate Locally

```bash
cd maestro-sidebar
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cd ..
node scripts/sidebar-release.mjs check-version --tag sidebar-vX.Y.Z
npx vitest run scripts/__tests__/sidebar-release.test.mjs
```

`npm run build` invokes `tauri build` and places native bundles under `maestro-sidebar/src-tauri/target/release/bundle/`. Local builds validate the current host only; GitHub Actions is authoritative for the four-platform release asset set.

## 3. Commit, Tag, and Trigger

Commit all intended Sidebar source and version changes before tagging. The tag must point at the exact tested commit.

```bash
git status --short
git push origin master
git tag -a sidebar-vX.Y.Z -m "Maestro Sidebar vX.Y.Z"
git push origin sidebar-vX.Y.Z
```

The tag push starts the `Publish Maestro Sidebar` workflow. To rerun an existing tag manually, open that workflow and provide the exact `sidebar-vX.Y.Z` tag. The prepare job checks out `refs/tags/<tag>`, proves that it resolves to `HEAD`, and rejects version drift before compilation. Stable releases accept only the strict `sidebar-vX.Y.Z` form; prerelease suffixes are rejected.

## 4. Build and Publication Sequence

The workflow performs these stages:

1. `prepare`: verify the exact tag commit and all six version surfaces; export the immutable full commit SHA; create or reuse one draft Release and output its numeric ID.
2. `build`: check out that exported SHA, run four Tauri builds, and pass the same `releaseId` to every matrix leg.
3. `finalize`: check out and record the same SHA; read the draft with `GET /releases/{release_id}` and validate the actual asset names and target coverage. Draft `browser_download_url` values may use `untagged-*`, so generate final links as `https://github.com/<repo>/releases/download/<canonical-tag>/<encoded-asset-name>`.
4. `publish`: verify the remote tag still points to the prepared SHA, then use one PATCH containing canonical `tag_name`, `target_commitish`, title, complete body, `draft=false`, `prerelease=false`, and `make_latest="false"`.
5. `verify`: require Windows x64, Linux x64, macOS arm64, and macOS x64 coverage; require a `Downloads` section and every canonical published asset URL in the returned Release representation.

The finalizer derives links from actual GitHub asset names. Draft `browser_download_url` values are not suitable for the final note because GitHub may expose them under a temporary `untagged-*` path until publication. Do not hard-code Tauri filenames or copy temporary draft URLs: bundle names and extensions may change with Tauri, target, or packaging configuration.

## 5. Verify the Published Release

```bash
TAG=sidebar-vX.Y.Z
gh run list --workflow publish-sidebar.yml --limit 5
gh release view "$TAG"
gh api "repos/catlog22/maestro-flow/releases/tags/$TAG" \
  --jq '{draft,html_url,assets:[.assets[]|{name,browser_download_url}]}'
```

Acceptance criteria:

- Workflow conclusion is `success`.
- `draft` is `false`.
- The release has Windows x64, Linux x64, macOS arm64, and macOS x64 installers.
- The Release Note has a `Downloads` section with clickable direct links for every returned asset.
- Opening at least one relevant `browser_download_url` downloads the expected installer.

Canonical release page:

```text
https://github.com/catlog22/maestro-flow/releases/tag/sidebar-vX.Y.Z
```

Canonical direct asset URL shape:

```text
https://github.com/catlog22/maestro-flow/releases/download/sidebar-vX.Y.Z/<asset-name>
```

## 6. Failure Recovery

- A build or finalization failure leaves the single shared release as a draft. Do not manually publish a draft whose notes still contain the assembly placeholder.
- Fix the source on a new commit and use a new version/tag when shipped bytes would change. Do not move an already published tag.
- If the tag is correct and only a transient CI upload failed, delete the incomplete draft release while keeping the tag, then manually dispatch the workflow for that existing tag:

```bash
gh release delete sidebar-vX.Y.Z --yes
```

- If finalization reports missing links, inspect the release asset JSON. The correct fix is to restore/upload the missing asset or repair the note generator; never bypass the verification step by publishing manually.
- macOS signing and notarization are not configured in this workflow. Until signing secrets are added, document platform warnings rather than claiming signed/notarized distribution.
