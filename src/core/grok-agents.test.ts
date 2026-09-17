import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrokAgents } from './skill-converter.js';

const repoRoot = process.cwd();
const claudeDir = join(repoRoot, '.claude');

const UNSUPPORTED_COLLAB_TOKEN = /\b(?:TaskList|TaskGet|TaskUpdate|SendMessage|TeamCreate|TeamDelete)\b/;

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'grok-agents-test-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Grok agent generation', () => {
  it('applies section overrides so team agents carry no Claude-only collaboration tokens', () => withTempDir((targetDir) => {
    const result = buildGrokAgents(claudeDir, targetDir);
    const sourceCount = readdirSync(join(claudeDir, 'agents')).filter(name => name.endsWith('.md')).length;
    expect(result.files).toBe(sourceCount);

    const worker = readFileSync(join(targetDir, 'team-worker.md'), 'utf8');
    const supervisor = readFileSync(join(targetDir, 'team-supervisor.md'), 'utf8');
    expect(worker).toContain('spawn_subagent');
    expect(worker).toContain('team_msg');
    expect(worker).not.toMatch(UNSUPPORTED_COLLAB_TOKEN);
    expect(supervisor).not.toMatch(UNSUPPORTED_COLLAB_TOKEN);
    // frontmatter allowed-tools dropped the Claude-only collaboration tools
    expect(worker).not.toMatch(/^  - (TaskList|TaskGet|TaskUpdate|SendMessage)$/m);
    expect(supervisor).not.toMatch(/^  - (TaskList|TaskGet|TaskUpdate|SendMessage)$/m);
  }));

  it('fails closed when an agent retains unsupported collaboration semantics', () => withTempDir((root) => {
    const source = join(root, '.claude', 'agents');
    const target = join(root, 'out');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'invalid.md'), [
      '---',
      'name: invalid',
      'description: invalid lifecycle',
      'allowed-tools: [Read]',
      '---',
      '',
      '# Invalid',
      'Report to the coordinator via SendMessage.',
    ].join('\n'));
    expect(() => buildGrokAgents(join(root, '.claude'), target)).toThrow(/unsupported SendMessage semantics/);
  }));
});
