/**
 * Spec Seeds
 *
 * Single source of truth for spec file templates (frontmatter + body).
 * Used by spec-init (initialize), spec-loader (auto-init on load), and
 * spec-writer (create-on-demand when adding an entry to a missing file).
 *
 * Keeps frontmatter format consistent across all entry points so loaded
 * specs always carry their YAML metadata (title, readMode, priority,
 * category, keywords).
 */

export interface SpecSeedFrontmatter {
  title: string;
  readMode: string;
  priority: string;
  category: string;
  keywords: string[];
}

export interface SpecSeedDoc {
  filename: string;
  frontmatter: SpecSeedFrontmatter;
  body: string;
}

export const SPEC_SEED_DOCS: SpecSeedDoc[] = [
  {
    filename: 'coding-conventions.md',
    frontmatter: {
      title: 'Coding Conventions',
      readMode: 'required',
      priority: 'high',
      category: 'coding',
      keywords: ['style', 'naming', 'import', 'pattern', 'convention', 'formatting'],
    },
    body: `# Coding Conventions

## Formatting

## Naming

## Imports

## Patterns

## Entries

`,
  },
  {
    filename: 'architecture-constraints.md',
    frontmatter: {
      title: 'Architecture Constraints',
      readMode: 'required',
      priority: 'high',
      category: 'arch',
      keywords: ['architecture', 'module', 'layer', 'boundary', 'dependency', 'structure'],
    },
    body: `# Architecture Constraints

## Module Structure

## Layer Boundaries

## Dependency Rules

## Technology Constraints

## Entries

`,
  },
  {
    filename: 'learnings.md',
    frontmatter: {
      title: 'Learnings',
      readMode: 'optional',
      priority: 'medium',
      category: 'learning',
      keywords: ['bug', 'lesson', 'gotcha', 'learning'],
    },
    body: `# Learnings

Add entries with: \`/maestro-spec learning <description>\`

## Entries

`,
  },
  {
    filename: 'quality-rules.md',
    frontmatter: {
      title: 'Quality Rules',
      readMode: 'required',
      priority: 'medium',
      category: 'review',
      keywords: ['quality', 'lint', 'rule', 'enforcement'],
    },
    body: `# Quality Rules

## Entries

`,
  },
  {
    filename: 'debug-notes.md',
    frontmatter: {
      title: 'Debug Notes',
      readMode: 'optional',
      priority: 'medium',
      category: 'debug',
      keywords: ['debug', 'issue', 'workaround', 'root-cause', 'gotcha'],
    },
    body: `# Debug Notes

## Entries

`,
  },
  {
    filename: 'test-conventions.md',
    frontmatter: {
      title: 'Test Conventions',
      readMode: 'required',
      priority: 'high',
      category: 'test',
      keywords: ['test', 'coverage', 'mock', 'fixture', 'assertion', 'framework'],
    },
    body: `# Test Conventions

## Framework

## Directory Structure

## Naming Conventions

## Patterns

## Entries

`,
  },
  {
    filename: 'ui-conventions.md',
    frontmatter: {
      title: 'UI Conventions',
      readMode: 'optional',
      priority: 'medium',
      category: 'ui',
      keywords: ['ui', 'design', 'color', 'typography', 'layout', 'animation', 'component'],
    },
    body: `# UI Conventions

## Color & Theme

## Typography

## Layout & Spacing

## Motion & Animation

## Component Patterns

## Entries

`,
  },
  {
    filename: 'review-standards.md',
    frontmatter: {
      title: 'Review Standards',
      readMode: 'required',
      priority: 'medium',
      category: 'review',
      keywords: ['review', 'checklist', 'gate', 'approval', 'standard'],
    },
    body: `# Review Standards

## Entries

`,
  },
];

/** Build YAML frontmatter block (without trailing newline) for a seed doc. */
export function formatSeedFrontmatter(fm: SpecSeedFrontmatter): string {
  const keywordsYaml = fm.keywords.map(k => `  - ${k}`).join('\n');
  return [
    '---',
    `title: "${fm.title}"`,
    `readMode: ${fm.readMode}`,
    `priority: ${fm.priority}`,
    `category: ${fm.category}`,
    'keywords:',
    keywordsYaml,
    '---',
  ].join('\n');
}

/** Return frontmatter + blank line + body — ready to write to disk. */
export function renderSeedContent(doc: SpecSeedDoc): string {
  return formatSeedFrontmatter(doc.frontmatter) + '\n\n' + doc.body;
}

/** True when raw content begins with a YAML frontmatter block. */
export function hasFrontmatter(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) return false;
  // Must have a closing --- on its own line
  return trimmed.indexOf('\n---', 3) !== -1;
}

/** Look up a seed by filename (e.g. 'coding-conventions.md'). */
export function findSeedByFilename(filename: string): SpecSeedDoc | undefined {
  return SPEC_SEED_DOCS.find(d => d.filename === filename);
}

// ============================================================================
// Presets — named collections of additional seed docs
// ============================================================================

export interface SpecPreset {
  name: string;
  description: string;
  seeds: SpecSeedDoc[];
}

const ACADEMIC_SEEDS: SpecSeedDoc[] = [
  {
    filename: 'writing-conventions.md',
    frontmatter: {
      title: 'Writing Conventions',
      readMode: 'required',
      priority: 'high',
      category: 'coding',
      keywords: ['writing-conventions', 'writing-patterns', 'citation-conventions', 'tool-preferences', 'academic-writing'],
    },
    body: `# Writing Conventions

## Style

## Citations

## Patterns

## Tool Preferences

## Entries

`,
  },
  {
    filename: 'methodology-patterns.md',
    frontmatter: {
      title: 'Methodology Patterns',
      readMode: 'required',
      priority: 'high',
      category: 'arch',
      keywords: ['methodology-patterns', 'argument-patterns', 'research-methodology'],
    },
    body: `# Methodology Patterns

## Methods

## Argument Patterns

## Entries

`,
  },
  {
    filename: 'venue-requirements.md',
    frontmatter: {
      title: 'Venue Requirements',
      readMode: 'required',
      priority: 'high',
      category: 'review',
      keywords: ['venue-requirements', 'review-learnings', 'submission-guidelines'],
    },
    body: `# Venue Requirements

## Guidelines

## Review Learnings

## Entries

`,
  },
  {
    filename: 'experiment-protocols.md',
    frontmatter: {
      title: 'Experiment Protocols',
      readMode: 'required',
      priority: 'high',
      category: 'test',
      keywords: ['experiment-protocols', 'reproducibility', 'statistical-validation'],
    },
    body: `# Experiment Protocols

## Protocols

## Validation

## Entries

`,
  },
  {
    filename: 'domain-knowledge.md',
    frontmatter: {
      title: 'Domain Knowledge',
      readMode: 'optional',
      priority: 'medium',
      category: 'learning',
      keywords: ['domain-knowledge', 'terminology-glossary', 'field-specific'],
    },
    body: `# Domain Knowledge

## Terminology

## Key Concepts

## Entries

`,
  },
];

export const SPEC_PRESETS: Record<string, SpecPreset> = {
  academic: {
    name: 'academic',
    description: 'Academic research: writing conventions, methodology, venue requirements, experiment protocols, domain knowledge',
    seeds: ACADEMIC_SEEDS,
  },
};

export function getPresetSeeds(preset: string): SpecSeedDoc[] {
  return SPEC_PRESETS[preset]?.seeds ?? [];
}

export function listPresets(): SpecPreset[] {
  return Object.values(SPEC_PRESETS);
}
