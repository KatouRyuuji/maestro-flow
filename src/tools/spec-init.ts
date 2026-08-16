/**
 * Spec Init
 *
 * Initialize .workflow/specs/ directory with frontmatter-enabled seed documents.
 * Idempotent: creates missing files, and migrates existing files that lack a
 * YAML frontmatter block by prepending the seed's frontmatter (body preserved).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { updateFileAtomic } from '../utils/atomic-write.js';
import { type SpecScope, resolveSpecDir } from './spec-loader.js';
import {
  SPEC_SEED_DOCS,
  formatSeedFrontmatter,
  hasFrontmatter,
  renderSeedContent,
  findSeedByFilename,
  getPresetSeeds,
  type SpecSeedDoc,
} from './spec-seeds.js';

// ============================================================================
// Types
// ============================================================================

export interface InitResult {
  created: string[];
  migrated: string[];
  skipped: string[];
  directories: string[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the spec system directory structure and seed documents.
 * - Creates the specs directory if missing.
 * - Writes seed files that don't exist.
 * - Migrates existing seed files that lack a YAML frontmatter block by
 *   prepending the canonical frontmatter (body content untouched).
 *
 * @param scope   Target scope: 'project' (default), 'global', 'team', or 'personal'.
 * @param uid     Required when scope is 'personal'.
 * @param preset  Named preset for additional seed docs (e.g. 'academic').
 */
export function initSpecSystem(projectPath: string, scope: SpecScope = 'project', uid?: string, preset?: string): InitResult {
  const result: InitResult = { created: [], migrated: [], skipped: [], directories: [] };

  const specsDir = resolveSpecDir(projectPath, scope, uid);

  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
    result.directories.push(specsDir);
  }

  const allDocs = preset
    ? [...SPEC_SEED_DOCS, ...getPresetSeeds(preset)]
    : SPEC_SEED_DOCS;

  for (const doc of allDocs) {
    const filePath = join(specsDir, doc.filename);

    if (existsSync(filePath)) {
      if (migrateMissingFrontmatter(filePath, doc)) {
        result.migrated.push(filePath);
      } else {
        result.skipped.push(filePath);
      }
      continue;
    }

    let created = false;
    updateFileAtomic(filePath, current => {
      if (current !== null) return current;
      created = true;
      return renderSeedContent(doc);
    });
    if (created) result.created.push(filePath);
    else result.skipped.push(filePath);
  }

  return result;
}

/**
 * Ensure a single spec file exists in `specsDir` with the correct YAML
 * frontmatter + body for its filename. No-op if the file already exists
 * with a frontmatter block. If it exists without one, prepends frontmatter.
 *
 * Returns true when the file was created or migrated, false when it was
 * already in good shape or the filename has no registered seed.
 */
export function ensureSpecFile(specsDir: string, filename: string): boolean {
  const doc = findSeedByFilename(filename);
  if (!doc) return false;

  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
  }

  const filePath = join(specsDir, filename);
  if (!existsSync(filePath)) {
    let created = false;
    updateFileAtomic(filePath, current => {
      if (current !== null) return current;
      created = true;
      return renderSeedContent(doc);
    });
    if (created) return true;
  }

  return migrateMissingFrontmatter(filePath, doc);
}

// ============================================================================
// Internal
// ============================================================================

/**
 * If the file at `filePath` lacks a YAML frontmatter block, prepend the
 * canonical frontmatter for the matching seed doc. Body content is preserved.
 *
 * Returns true when content was rewritten; false when no change was needed.
 */
function migrateMissingFrontmatter(filePath: string, doc: SpecSeedDoc): boolean {
  let migrated = false;
  updateFileAtomic(filePath, raw => {
    if (raw === null || hasFrontmatter(raw)) return raw;
    const fm = formatSeedFrontmatter(doc.frontmatter);
    migrated = true;
    return `${fm}\n\n${raw.replace(/^\s+/, '')}`;
  });
  return migrated;
}
