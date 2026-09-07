import { describe, expect, it } from 'vitest';
import {
  extractGoalFlag,
  inferGoalUiPlatform,
  resolveGoalMode,
  resolveGoalModeForHost,
} from './goal-mode.js';

const PREPARE_WITH_GOAL = [
  '---',
  'name: maestro',
  'goal: true',
  '---',
  '',
  '# Prepare',
].join('\n');

const PREPARE_WITHOUT_GOAL = [
  '---',
  'name: companion',
  '---',
  '',
  '# Prepare',
].join('\n');

describe('extractGoalFlag', () => {
  it('reads goal: true from frontmatter', () => {
    expect(extractGoalFlag(PREPARE_WITH_GOAL)).toBe(true);
  });

  it('returns false when the flag is absent', () => {
    expect(extractGoalFlag(PREPARE_WITHOUT_GOAL)).toBe(false);
  });
});

describe('resolveGoalMode', () => {
  it('returns Cursor-native /goal rules and keeps clear dismissed', () => {
    const mode = resolveGoalMode(PREPARE_WITH_GOAL, 'cursor');
    expect(mode?.platform).toBe('cursor');
    expect(mode?.instructions).toContain('CreateGoal');
    expect(mode?.instructions).toContain('用户清除或关闭 Goal 后');
    expect(mode?.instructions).toContain('不要用 UpdateGoal 刷新外观');
    expect(mode?.instructions).not.toMatch(/`create_goal\s*\(/);
  });

  it('returns Grok-native /goal clear rules', () => {
    const mode = resolveGoalMode(PREPARE_WITH_GOAL, 'grok');
    expect(mode?.platform).toBe('grok');
    expect(mode?.instructions).toContain('/goal clear');
    expect(mode?.instructions).toContain('不要再 create_goal');
  });

  it('returns Claude-native /goal clear rules', () => {
    const mode = resolveGoalMode(PREPARE_WITH_GOAL, 'claude');
    expect(mode?.platform).toBe('claude');
    expect(mode?.instructions).toContain('用户清除或关闭 /goal 后');
    expect(mode?.instructions).toContain('不要重建');
  });

  it('returns null when goal is not declared', () => {
    expect(resolveGoalMode(PREPARE_WITHOUT_GOAL, 'cursor')).toBeNull();
  });

  it('returns null for platforms without a goal block', () => {
    expect(resolveGoalMode(PREPARE_WITH_GOAL, 'agy')).toBeNull();
  });
});

describe('inferGoalUiPlatform', () => {
  it('keeps the resolved platform when no host signal is present', () => {
    expect(inferGoalUiPlatform('claude', {})).toBe('claude');
    expect(inferGoalUiPlatform('grok', { CURSOR_AGENT: '0' })).toBe('grok');
  });

  it('selects cursor when CURSOR_AGENT=1 so the host gets Cursor-native /goal rules', () => {
    expect(inferGoalUiPlatform('claude', { CURSOR_AGENT: '1' })).toBe('cursor');
  });

  it('lets MAESTRO_PLATFORM override host detection', () => {
    expect(inferGoalUiPlatform('claude', { CURSOR_AGENT: '1', MAESTRO_PLATFORM: 'codex' })).toBe('codex');
  });

  it('ignores unknown MAESTRO_PLATFORM values', () => {
    expect(inferGoalUiPlatform('claude', { MAESTRO_PLATFORM: 'not-a-platform' })).toBe('claude');
  });
});

describe('resolveGoalModeForHost', () => {
  it('emits Cursor Goal instructions inside a Cursor agent even if the run bound claude', () => {
    const mode = resolveGoalModeForHost(PREPARE_WITH_GOAL, 'claude', { CURSOR_AGENT: '1' });
    expect(mode?.platform).toBe('cursor');
    expect(mode?.instructions).toContain('CreateGoal');
  });

  it('does not switch platforms when invoked outside Cursor', () => {
    const mode = resolveGoalModeForHost(PREPARE_WITH_GOAL, 'claude', {});
    expect(mode?.platform).toBe('claude');
    expect(mode?.instructions).toContain('/goal');
  });
});
