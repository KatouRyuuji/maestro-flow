import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderReleaseNotes,
  verifyDraft,
  verifyRelease,
  verifyVersionContract,
} from "../sidebar-release.mjs";

const versions = {
  "package.json": "0.1.0",
  "package-lock.json": "0.1.0",
  'package-lock.json#packages[""]': "0.1.0",
  "tauri.conf.json": "0.1.0",
  "Cargo.toml": "0.1.0",
  "Cargo.lock": "0.1.0",
};

const release = {
  tag_name: "sidebar-v0.1.0",
  draft: true,
  body: "",
  assets: [
    {
      name: "Maestro-Sidebar_0.1.0_x64_en-US.msi",
      browser_download_url:
        "https://github.com/catlog22/maestro-flow/releases/download/sidebar-v0.1.0/Maestro-Sidebar_0.1.0_x64_en-US.msi",
      size: 3_756_032,
    },
    {
      name: "Maestro-Sidebar_0.1.0_x64-setup.exe",
      browser_download_url:
        "https://github.com/catlog22/maestro-flow/releases/download/sidebar-v0.1.0/Maestro-Sidebar_0.1.0_x64-setup.exe",
      size: 2_483_304,
    },
    {
      name: "Maestro-Sidebar_0.1.0_amd64.AppImage",
      browser_download_url:
        "https://github.com/catlog22/maestro-flow/releases/download/sidebar-v0.1.0/Maestro-Sidebar_0.1.0_amd64.AppImage",
      size: 18_874_368,
    },
    {
      name: "Maestro-Sidebar_0.1.0_aarch64.dmg",
      browser_download_url:
        "https://github.com/catlog22/maestro-flow/releases/download/sidebar-v0.1.0/Maestro-Sidebar_0.1.0_aarch64.dmg",
      size: 20_971_520,
    },
    {
      name: "Maestro-Sidebar_0.1.0_x64.dmg",
      browser_download_url:
        "https://github.com/catlog22/maestro-flow/releases/download/sidebar-v0.1.0/Maestro-Sidebar_0.1.0_x64.dmg",
      size: 21_495_808,
    },
  ],
};

describe("Sidebar release contract", () => {
  it("requires every version surface to match a stable sidebar tag", () => {
    expect(verifyVersionContract("sidebar-v0.1.0", versions)).toBe("0.1.0");
    expect(() => verifyVersionContract("sidebar-v0.1.1", versions)).toThrow(
      /mismatched/,
    );
    for (const tag of ["v0.1.0", "sidebar-v0.1.0-rc.1", "sidebar-v01.1.0"]) {
      expect(() => verifyVersionContract(tag, versions)).toThrow(
        /invalid Sidebar release tag/,
      );
    }
  });

  it("binds the shared draft to the exact tag and commit", () => {
    const draft = {
      id: 42,
      tag_name: "sidebar-v0.1.0",
      target_commitish: "1234567890abcdef",
      draft: true,
      prerelease: false,
    };
    expect(
      verifyDraft({
        release: draft,
        tag: "sidebar-v0.1.0",
        commit: "1234567890abcdef",
      }),
    ).toEqual({
      releaseId: 42,
      tag: "sidebar-v0.1.0",
      commit: "1234567890abcdef",
    });
    expect(() =>
      verifyDraft({
        release: draft,
        tag: "sidebar-v0.1.0",
        commit: "different",
      }),
    ).toThrow(/target commit mismatch/);
    expect(() =>
      verifyDraft({
        release: { ...draft, draft: false },
        tag: "sidebar-v0.1.0",
        commit: "1234567890abcdef",
      }),
    ).toThrow(/is not a draft/);
  });

  it("renders every real asset as a direct download link", () => {
    const body = renderReleaseNotes({
      release,
      generatedNotes: {
        body: "## What changed\n\n- Added release automation.",
      },
      repository: "catlog22/maestro-flow",
      tag: "sidebar-v0.1.0",
      commit: "1234567890abcdef",
    });
    expect(body).toContain("## Downloads");
    for (const asset of release.assets) {
      expect(body).toContain(asset.browser_download_url);
    }
    expect(body).toContain("### Windows");
    expect(body).toContain("### macOS");
    expect(body).toContain("### Linux");
    expect(body).toContain("## Changes");
  });

  it("renders canonical tag downloads from temporary draft asset URLs", () => {
    const draftRelease = {
      ...release,
      tag_name: "untagged-a898e95cb01673682b52",
      assets: release.assets.map((asset) => ({
        ...asset,
        browser_download_url: asset.browser_download_url.replace(
          "/sidebar-v0.1.0/",
          "/untagged-a898e95cb01673682b52/",
        ),
      })),
    };
    const body = renderReleaseNotes({
      release: draftRelease,
      generatedNotes: null,
      repository: "catlog22/maestro-flow",
      tag: "sidebar-v0.1.0",
      commit: "1234567890abcdef",
    });
    expect(body).not.toContain("untagged-a898e95cb01673682b52");
    for (const asset of release.assets) {
      expect(body).toContain(asset.browser_download_url);
    }
  });

  it("fails when assets, target coverage, or release-note links are missing", () => {
    expect(() =>
      renderReleaseNotes({
        release: { ...release, assets: [] },
        generatedNotes: null,
        repository: "catlog22/maestro-flow",
        tag: "sidebar-v0.1.0",
        commit: "1234567890abcdef",
      }),
    ).toThrow(/no downloadable assets/);

    for (const missingNames of [
      [
        "Maestro-Sidebar_0.1.0_x64_en-US.msi",
        "Maestro-Sidebar_0.1.0_x64-setup.exe",
      ],
      ["Maestro-Sidebar_0.1.0_amd64.AppImage"],
      ["Maestro-Sidebar_0.1.0_aarch64.dmg"],
      ["Maestro-Sidebar_0.1.0_x64.dmg"],
    ]) {
      expect(() =>
        renderReleaseNotes({
          release: {
            ...release,
            assets: release.assets.filter(
              (asset) => !missingNames.includes(asset.name),
            ),
          },
          generatedNotes: null,
          repository: "catlog22/maestro-flow",
          tag: "sidebar-v0.1.0",
          commit: "1234567890abcdef",
        }),
      ).toThrow(/missing required assets/);
    }

    expect(() => verifyRelease({ release, tag: "sidebar-v0.1.0" })).toThrow(
      /no Downloads section/,
    );
    expect(() =>
      verifyRelease({
        release: { ...release, body: "## Downloads\n\nNo links yet." },
        tag: "sidebar-v0.1.0",
      }),
    ).toThrow(/omit download links/);
  });

  it("requires a non-draft release for the final published check", () => {
    const body = renderReleaseNotes({
      release,
      generatedNotes: null,
      repository: "catlog22/maestro-flow",
      tag: "sidebar-v0.1.0",
      commit: "1234567890abcdef",
    });
    expect(() =>
      verifyRelease({
        release: { ...release, body },
        tag: "sidebar-v0.1.0",
        requirePublished: true,
      }),
    ).toThrow(/still a draft/);
    expect(
      verifyRelease({
        release: { ...release, body, draft: false },
        tag: "sidebar-v0.1.0",
        requirePublished: true,
      }),
    ).toEqual({ assets: 5, published: true });
  });

  it("keeps one exact-tag draft, link verification, and publication ordered in CI", () => {
    const workflow = readFileSync(
      ".github/workflows/publish-sidebar.yml",
      "utf8",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("format('refs/tags/{0}', inputs.tag)");
    expect(workflow).toContain(
      "release-id: ${{ steps.release.outputs.release-id }}",
    );
    expect(workflow).toContain("commit: ${{ steps.release.outputs.commit }}");
    expect(
      workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}/g),
    ).toHaveLength(2);
    expect(workflow).toContain('--commit "$SIDEBAR_COMMIT"');
    expect(workflow).toContain('test "$remote_commit" = "$SIDEBAR_COMMIT"');
    expect(workflow).toContain(
      "releaseId: ${{ needs.prepare.outputs.release-id }}",
    );
    expect(workflow).toContain("releases/$RELEASE_ID");
    expect(workflow).toContain("scripts/sidebar-release.mjs verify-draft");
    expect(workflow).toContain("releaseDraft: true");
    expect(workflow).toContain("needs: [prepare, build]");
    expect(workflow).toContain("scripts/sidebar-release.mjs render-notes");
    expect(workflow).toContain("--rawfile body release-notes.md");
    expect(workflow).toContain(
      "'{tag_name:$tag,target_commitish:$commit,name:$name,body:$body,draft:false,prerelease:false,make_latest:\"false\"}'",
    );
    expect(workflow).toContain("--require-published");

    const publication = workflow.indexOf("--rawfile body release-notes.md");
    const publishedVerification = workflow.indexOf("--require-published");
    expect(publication).toBeGreaterThan(-1);
    expect(publication).toBeLessThan(publishedVerification);
  });
});
