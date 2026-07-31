import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportFileStem, resolveCoordinatorReportPath } from './report-path.js';

describe('reportFileStem', () => {
  it('preserves portable node IDs for backward compatibility', () => {
    expect(reportFileStem('execute-step_1')).toBe('execute-step_1');
  });

  it.each(['phase:design', 'phase/review', '设计阶段', 'node with spaces', 'CON', 'nul'])(
    'hashes node IDs that are unsafe as portable filenames: %s',
    (nodeId) => {
      const expected = createHash('sha256').update(nodeId, 'utf8').digest('hex');
      expect(reportFileStem(nodeId)).toBe(`node-${expected}`);
    },
  );

  it('keeps unsafe session IDs inside the report root', () => {
    const root = '/tmp/maestro-sessions';
    const path = resolveCoordinatorReportPath(root, '../../escape', 'execute');
    const relativePath = relative(root, path);

    expect(relativePath.startsWith('..')).toBe(false);
    expect(relativePath).toMatch(/^session-[a-f0-9]{64}[\\/]reports[\\/]execute\.json$/);
  });
});
