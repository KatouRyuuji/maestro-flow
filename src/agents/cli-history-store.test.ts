import { describe, expect, it } from 'vitest';
import { CliAgentRunner } from './cli-agent-runner.js';
import { assertValidCliExecId, isValidCliExecId } from './cli-history-store.js';

describe('CLI execution ID validation', () => {
  it('accepts generated and portable custom IDs', () => {
    expect(isValidCliExecId('cdx-123456-abcd')).toBe(true);
    expect(isValidCliExecId('custom_run-1')).toBe(true);
    expect(() => assertValidCliExecId('custom_run-1')).not.toThrow();
  });

  it.each(['run:1', '../run', 'run/1', 'run 1', '执行-1', '', 'a'.repeat(65), 'CON', 'nul'])(
    'rejects IDs that are unsafe as portable filenames: %s',
    (execId) => {
      expect(isValidCliExecId(execId)).toBe(false);
      expect(() => assertValidCliExecId(execId)).toThrow(/Invalid execution ID/);
    },
  );

  it('rejects an invalid custom ID before starting an agent', async () => {
    const runner = new CliAgentRunner();
    await expect(runner.run({
      prompt: 'test',
      tool: 'codex',
      mode: 'analysis',
      workDir: process.cwd(),
      execId: 'run:1',
    })).rejects.toThrow(/Invalid execution ID/);
  });
});
