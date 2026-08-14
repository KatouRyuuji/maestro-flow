import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import {
  reportFrontmatterSchema,
  type Handoff,
  type ReportFrontmatter,
} from './schemas.js';

export type { ReportFrontmatter };

export function readReportFrontmatter(runDir: string): ReportFrontmatter {
  const path = join(runDir, 'report.md');
  if (!existsSync(path)) return reportFrontmatterSchema.parse({});
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return reportFrontmatterSchema.parse({});
  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1], { prettyErrors: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(
      'report.md frontmatter YAML is invalid: ' + detail + '. '
      + 'Check the --- delimiters, indentation, and that quotes/brackets are closed; '
      + 'values containing colons or special characters should be quoted.',
    );
  }
  try {
    return reportFrontmatterSchema.parse(parsed ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(
        'report.md frontmatter is invalid (' + issues + ').\n'
        + 'Allowed shapes — decisions: string | { text, status: proposed|accepted|rejected } | { accepted: "<text>" } (also proposed/rejected); '
        + 'constraints: string | { text, status: locked|open|deferred } | { locked: "<text>" } (also open/deferred).\n'
        + 'Example:\n'
        + '  decisions:\n'
        + '    - text: "Use X"\n'
        + '      status: accepted\n'
        + '  constraints:\n'
        + '    - locked: "Always Y"',
      );
    }
    throw err;
  }
}

export function deriveHandoff(
  frontmatter: ReportFrontmatter,
  runId: string,
  command: string,
  artifactRefs: string[],
  evidenceRefs: string[],
): Handoff {
  return {
    schema_version: 'command-handoff/1.0',
    producer_run_id: runId,
    command,
    verdict: frontmatter.verdict,
    summary: frontmatter.summary,
    constraints: frontmatter.constraints,
    decisions: frontmatter.decisions,
    concerns: frontmatter.concerns,
    artifact_refs: artifactRefs,
    next: frontmatter.next.map(item => ({
      command: item.command,
      reason: item.reason,
      needs: item.needs,
    })),
    details: frontmatter.details,
  };
}

