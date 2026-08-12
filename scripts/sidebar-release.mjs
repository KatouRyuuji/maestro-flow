#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_PATTERN = /^sidebar-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REQUIRED_ASSET_TARGETS = [
  "windows-x64",
  "linux-x64",
  "macos-arm64",
  "macos-x64",
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "require-published") {
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (!value) fail(`--${key} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function versionFromTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match)
    fail(`invalid Sidebar release tag: ${tag}; expected sidebar-vX.Y.Z`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function cargoPackageVersion(text, packageName) {
  const blocks = text.split(/\r?\n\[\[package\]\]\r?\n/);
  const block = blocks.find((candidate) =>
    candidate.includes(`name = "${packageName}"`),
  );
  return block?.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
}

export function readSidebarVersions(root = process.cwd()) {
  const packageJson = readJson(resolve(root, "maestro-sidebar/package.json"));
  const packageLock = readJson(
    resolve(root, "maestro-sidebar/package-lock.json"),
  );
  const tauriConfig = readJson(
    resolve(root, "maestro-sidebar/src-tauri/tauri.conf.json"),
  );
  const cargoToml = readFileSync(
    resolve(root, "maestro-sidebar/src-tauri/Cargo.toml"),
    "utf8",
  );
  const cargoLock = readFileSync(
    resolve(root, "maestro-sidebar/src-tauri/Cargo.lock"),
    "utf8",
  );
  const cargoManifestVersion =
    cargoToml.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    'package-lock.json#packages[""]': packageLock.packages?.[""]?.version,
    "tauri.conf.json": tauriConfig.version,
    "Cargo.toml": cargoManifestVersion,
    "Cargo.lock": cargoPackageVersion(cargoLock, "maestro-sidebar"),
  };
}

export function verifyVersionContract(tag, versions) {
  const expected = versionFromTag(tag);
  const mismatches = Object.entries(versions)
    .filter(([, value]) => value !== expected)
    .map(([source, value]) => `${source}=${value ?? "<missing>"}`);
  if (mismatches.length > 0) {
    fail(
      `Sidebar version contract requires ${expected}; mismatched ${mismatches.join(", ")}`,
    );
  }
  return expected;
}

function assetPlatform(name) {
  if (/\.(?:msi|exe)(?:\.zip)?$/i.test(name)) return "Windows";
  if (/\.(?:dmg|pkg)$|\.app\.tar\.gz$/i.test(name)) return "macOS";
  if (/\.(?:appimage|deb|rpm)$/i.test(name)) return "Linux";
  return "Other files";
}

function assetTarget(name) {
  const normalized = name.toLowerCase();
  if (
    /\.(?:msi|exe)(?:\.zip)?$/.test(normalized) &&
    /(x64|x86_64)/.test(normalized)
  ) {
    return "windows-x64";
  }
  if (
    /\.(?:appimage|deb|rpm)$/.test(normalized) &&
    /(amd64|x64|x86_64)/.test(normalized)
  ) {
    return "linux-x64";
  }
  if (/\.(?:dmg|pkg)$|\.app\.tar\.gz$/.test(normalized)) {
    if (/(aarch64|arm64)/.test(normalized)) return "macos-arm64";
    if (/(x64|x86_64)/.test(normalized)) return "macos-x64";
  }
  return null;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return ` (${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]})`;
}

function normalizedAssets(release, tag, options = {}) {
  const allowDraftTag = options.allowDraftTag === true;
  if (
    release.tag_name !== tag &&
    !(
      allowDraftTag &&
      release.draft === true &&
      /^untagged-[0-9a-f]+$/.test(release.tag_name ?? "")
    )
  ) {
    fail(`release tag mismatch: ${release.tag_name ?? "<missing>"}`);
  }
  if (!Array.isArray(release.assets) || release.assets.length === 0) {
    fail(`release ${tag} has no downloadable assets`);
  }
  const assets = release.assets.map((asset) => ({
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    platform: assetPlatform(asset.name ?? ""),
    target: assetTarget(asset.name ?? ""),
  }));
  for (const asset of assets) {
    if (
      !asset.name ||
      !/^https:\/\/github\.com\/.+\/releases\/download\//.test(asset.url ?? "")
    ) {
      fail(
        `release ${tag} contains an invalid asset download URL for ${asset.name ?? "<unnamed>"}`,
      );
    }
  }
  const presentTargets = new Set(
    assets.map((asset) => asset.target).filter(Boolean),
  );
  const missingTargets = REQUIRED_ASSET_TARGETS.filter(
    (target) => !presentTargets.has(target),
  );
  if (missingTargets.length > 0) {
    fail(
      `release ${tag} is missing required assets: ${missingTargets.join(", ")}`,
    );
  }
  return assets.sort(
    (left, right) =>
      left.platform.localeCompare(right.platform) ||
      left.name.localeCompare(right.name),
  );
}

export function renderReleaseNotes({
  release,
  generatedNotes,
  repository,
  tag,
  commit,
}) {
  const version = versionFromTag(tag);
  const assets = normalizedAssets(release, tag, { allowDraftTag: true }).map(
    (asset) => ({
      ...asset,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(asset.name)}`,
    }),
  );
  const groups = new Map();
  for (const asset of assets) {
    const entries = groups.get(asset.platform) ?? [];
    entries.push(asset);
    groups.set(asset.platform, entries);
  }

  const lines = [
    `# Maestro Sidebar v${version}`,
    "",
    "## Downloads",
    "",
    "Choose the installer for your operating system. Every item below is a direct GitHub Release download.",
    "",
  ];
  for (const platform of ["Windows", "macOS", "Linux", "Other files"]) {
    const entries = groups.get(platform);
    if (!entries) continue;
    lines.push(`### ${platform}`, "");
    for (const asset of entries) {
      lines.push(`- [${asset.name}](${asset.url})${formatBytes(asset.size)}`);
    }
    lines.push("");
  }

  lines.push(
    "## Build provenance",
    "",
    `- Source tag: [\`${tag}\`](https://github.com/${repository}/tree/${tag})`,
    `- Commit: [\`${commit.slice(0, 12)}\`](https://github.com/${repository}/commit/${commit})`,
    `- Build workflow: [Publish Maestro Sidebar](https://github.com/${repository}/actions/workflows/publish-sidebar.yml)`,
  );

  const changes = generatedNotes?.body?.trim();
  if (changes) lines.push("", "## Changes", "", changes);
  lines.push("");
  return lines.join("\n");
}

export function verifyDraft({ release, tag, commit }) {
  versionFromTag(tag);
  if (release.tag_name !== tag) {
    fail(`release tag mismatch: ${release.tag_name ?? "<missing>"}`);
  }
  if (release.draft !== true) fail(`release ${tag} is not a draft`);
  if (release.prerelease !== false)
    fail(`release ${tag} must not be a prerelease`);
  if (release.target_commitish !== commit) {
    fail(
      `release ${tag} target commit mismatch: ${release.target_commitish ?? "<missing>"}`,
    );
  }
  return { releaseId: release.id, tag, commit };
}

export function verifyRelease({ release, tag, requirePublished = false }) {
  const assets = normalizedAssets(release, tag);
  const body = release.body ?? "";
  if (!body.includes("## Downloads"))
    fail(`release ${tag} has no Downloads section`);
  const missing = assets.filter((asset) => !body.includes(asset.url));
  if (missing.length > 0) {
    fail(
      `release ${tag} notes omit download links: ${missing.map((asset) => asset.name).join(", ")}`,
    );
  }
  if (requirePublished && release.draft !== false)
    fail(`release ${tag} is still a draft`);
  return { assets: assets.length, published: release.draft === false };
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "check-version") {
    const tag = required(options, "tag");
    const version = verifyVersionContract(tag, readSidebarVersions());
    console.log(
      `Sidebar release version contract passed: ${tag} -> ${version}`,
    );
    return;
  }
  if (command === "render-notes") {
    const tag = required(options, "tag");
    const output = required(options, "output");
    const notes = renderReleaseNotes({
      tag,
      repository: required(options, "repository"),
      commit: required(options, "commit"),
      release: readJson(required(options, "release-json")),
      generatedNotes: options["generated-notes-json"]
        ? readJson(options["generated-notes-json"])
        : null,
    });
    writeFileSync(resolve(output), notes, "utf8");
    console.log(`Sidebar release notes written: ${output}`);
    return;
  }
  if (command === "verify-draft") {
    const result = verifyDraft({
      tag: required(options, "tag"),
      commit: required(options, "commit"),
      release: readJson(required(options, "release-json")),
    });
    console.log(
      `Sidebar draft verified: ${result.releaseId} -> ${result.commit}`,
    );
    return;
  }
  if (command === "verify-release") {
    const result = verifyRelease({
      tag: required(options, "tag"),
      release: readJson(required(options, "release-json")),
      requirePublished: options["require-published"] === true,
    });
    console.log(
      `Sidebar release verified: ${result.assets} assets, published=${result.published}`,
    );
    return;
  }
  fail(
    "usage: sidebar-release.mjs check-version|verify-draft|render-notes|verify-release [options]",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`sidebar release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
