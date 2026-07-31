import { describe, expect, it } from 'vitest';
import { assertSafePathSegment } from './ids.js';

describe('assertSafePathSegment', () => {
  it.each(['run-123', 'session_name', '中文-run', 'run name'])(
    'accepts filesystem-safe segments: %s',
    (value) => expect(() => assertSafePathSegment(value, 'test ID')).not.toThrow(),
  );

  it.each(['', '.', '..', 'run/1', 'run\\1', 'run:1', 'run?1', 'run*1', 'run.', 'run ', 'CON', 'nul.txt', 'LPT1'])(
    'rejects non-portable filesystem segments: %s',
    (value) => expect(() => assertSafePathSegment(value, 'test ID')).toThrow(/Invalid test ID/),
  );
});
