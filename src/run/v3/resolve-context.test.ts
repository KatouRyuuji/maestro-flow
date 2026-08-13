import { describe, expect, it } from 'vitest';
import { runResponseErrorDetailV12Schema } from '../protocol-schemas.js';
import {
  resolveSessionContext,
  sessionContextErrorToV3Error,
  type ResolveSessionContextInput,
  type SessionContextCandidateInput,
} from './resolve-context.js';

const accessible = (sessionId: string) => ({ session_id: sessionId, access: 'accessible' as const });
const candidate = (sessionId: string): SessionContextCandidateInput => ({ session_id: sessionId });

describe('resolveSessionContext priority', () => {
  it('selects an accessible explicit ID ahead of every inferred tier', () => {
    expect(resolveSessionContext({
      explicit_session: accessible('explicit'),
      current_binding: accessible('bound'),
      open_sessions: [candidate('open-b'), candidate('open-a')],
      runnable_candidates: [candidate('runnable')],
    })).toEqual({ ok: true, session_id: 'explicit', source: 'explicit_session_id' });
  });

  it('selects the current binding ahead of open and runnable candidates', () => {
    expect(resolveSessionContext({
      current_binding: accessible('bound'),
      open_sessions: [candidate('open')],
      runnable_candidates: [candidate('runnable')],
    })).toEqual({ ok: true, session_id: 'bound', source: 'current_binding' });
  });

  it.each([
    ['explicit_session', 'explicit_session_id'],
    ['current_binding', 'current_binding'],
  ] as const)('returns a canonical ID from %s', (field, source) => {
    expect(resolveSessionContext({ [field]: accessible('  s-1  ') })).toEqual({
      ok: true, session_id: 's-1', source,
    });
  });

  it('selects the unique open Session ahead of runnable candidates', () => {
    expect(resolveSessionContext({
      open_sessions: [candidate('open')],
      runnable_candidates: [candidate('runnable-b'), candidate('runnable-a')],
    })).toEqual({ ok: true, session_id: 'open', source: 'open_sessions' });
  });

  it('selects the unique runnable candidate only when higher tiers are empty', () => {
    expect(resolveSessionContext({
      open_sessions: [],
      runnable_candidates: [candidate('runnable')],
    })).toEqual({ ok: true, session_id: 'runnable', source: 'runnable_candidates' });
  });
});

describe('resolveSessionContext fail-closed references', () => {
  it.each([
    ['not_found', 'SESSION_NOT_FOUND', 'provide-an-existing-session-id'],
    ['inaccessible', 'SESSION_INACCESSIBLE', 'check-session-access'],
  ] as const)('does not fall back when an explicit ID is %s', (access, code, nextAction) => {
    expect(resolveSessionContext({
      explicit_session: { session_id: 'explicit', access },
      current_binding: accessible('bound'),
      open_sessions: [candidate('open')],
    })).toEqual({
      ok: false,
      error: {
        code,
        message: expect.stringContaining('explicit'),
        source: 'explicit_session_id',
        candidates: ['explicit'],
        next_actions: [nextAction],
      },
    });
  });

  it.each([
    ['not_found', 'SESSION_NOT_FOUND', 'provide-an-existing-session-id'],
    ['inaccessible', 'SESSION_INACCESSIBLE', 'check-session-access'],
  ] as const)('does not guess another Session when the current binding is %s', (access, code, nextAction) => {
    expect(resolveSessionContext({
      current_binding: { session_id: 'stale-binding', access },
      open_sessions: [candidate('newest-looking-session')],
      runnable_candidates: [candidate('runnable')],
    })).toEqual({
      ok: false,
      error: {
        code,
        message: expect.stringContaining('stale-binding'),
        source: 'current_binding',
        candidates: ['stale-binding'],
        next_actions: [nextAction],
      },
    });
  });

  it('rejects an empty explicit ID instead of inferring context', () => {
    expect(resolveSessionContext({
      explicit_session: accessible('  '),
      open_sessions: [candidate('open')],
    })).toMatchObject({
      ok: false,
      error: { code: 'SESSION_CONTEXT_INVALID', source: 'explicit_session_id' },
    });
  });
});

describe('resolveSessionContext candidate tiers', () => {
  it('fails closed on multiple open Sessions with deduplicated, stable candidates and actions', () => {
    const input: ResolveSessionContextInput = {
      open_sessions: [candidate('session-z'), candidate('session-a'), candidate('session-z')],
      runnable_candidates: [candidate('only-runnable')],
    };

    expect(resolveSessionContext(input)).toEqual({
      ok: false,
      error: {
        code: 'SESSION_AMBIGUOUS',
        message: 'Multiple sessions are eligible from open_sessions; select one explicitly.',
        source: 'open_sessions',
        candidates: ['session-a', 'session-z'],
        next_actions: ['select-session:session-a', 'select-session:session-z'],
      },
    });
  });

  it('fails closed on multiple runnable candidates with stable ID order, never mtime order', () => {
    const older = { session_id: 'session-a', mtime_ms: 1 };
    const newer = { session_id: 'session-z', mtime_ms: 999_999 };

    expect(resolveSessionContext({ runnable_candidates: [newer, older, newer] })).toEqual({
      ok: false,
      error: {
        code: 'SESSION_AMBIGUOUS',
        message: 'Multiple sessions are eligible from runnable_candidates; select one explicitly.',
        source: 'runnable_candidates',
        candidates: ['session-a', 'session-z'],
        next_actions: ['select-session:session-a', 'select-session:session-z'],
      },
    });
  });

  it('treats whitespace variants as one canonical candidate', () => {
    expect(resolveSessionContext({
      open_sessions: [candidate('s-1'), candidate(' s-1 ')],
    })).toEqual({ ok: true, session_id: 's-1', source: 'open_sessions' });
  });

  it('sorts and reports canonical candidate IDs', () => {
    expect(resolveSessionContext({
      open_sessions: [candidate(' session-z '), candidate('session-a')],
    })).toMatchObject({
      ok: false,
      error: {
        candidates: ['session-a', 'session-z'],
        next_actions: ['select-session:session-a', 'select-session:session-z'],
      },
    });
  });

  it('rejects an invalid candidate rather than silently dropping it', () => {
    expect(resolveSessionContext({
      open_sessions: [candidate('valid'), candidate('')],
      runnable_candidates: [candidate('fallback')],
    })).toMatchObject({
      ok: false,
      error: { code: 'SESSION_CONTEXT_INVALID', source: 'open_sessions' },
    });
  });

  it('returns a structured unresolved result when all tiers are empty', () => {
    expect(resolveSessionContext({})).toEqual({
      ok: false,
      error: {
        code: 'SESSION_CONTEXT_UNRESOLVED',
        message: 'No explicit, bound, open, or runnable Session is available.',
        source: null,
        candidates: [],
        next_actions: ['provide-an-explicit-session-id', 'open-a-session'],
      },
    });
  });
});

describe('sessionContextErrorToV3Error', () => {
  it.each([
    ['SESSION_NOT_FOUND', 'SESSION_NOT_FOUND'],
    ['SESSION_INACCESSIBLE', 'INVALID_STATE_TRANSITION'],
    ['SESSION_CONTEXT_INVALID', 'INVALID_ARGUMENT'],
    ['SESSION_CONTEXT_UNRESOLVED', 'INVALID_STATE_TRANSITION'],
  ] as const)('maps %s to the frozen protocol code %s', (contextCode, protocolCode) => {
    const detail = sessionContextErrorToV3Error({
      code: contextCode,
      message: 'context resolution failed',
      source: 'explicit_session_id',
      candidates: ['session-a'],
      next_actions: ['select-session:session-a'],
    }).toRunResponseV12ErrorDetail();

    expect(detail).toMatchObject({
      code: protocolCode,
      details: {
        context_error_code: contextCode,
        source: 'explicit_session_id',
        candidates: ['session-a'],
      },
      target_type: null,
      target_id: null,
      expected_revision: null,
      current_revision: null,
      changed_by: null,
      next_actions: ['select-session:session-a'],
    });
    expect(runResponseErrorDetailV12Schema.parse(detail)).toEqual(detail);
  });

  it('preserves SESSION_AMBIGUOUS candidates and actions without loss', () => {
    const result = resolveSessionContext({
      open_sessions: [candidate('session-z'), candidate('session-a'), candidate('session-z')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ambiguous context');

    const detail = sessionContextErrorToV3Error(result.error).toRunResponseV12ErrorDetail();
    expect(detail).toEqual({
      code: 'SESSION_AMBIGUOUS',
      message: 'Multiple sessions are eligible from open_sessions; select one explicitly.',
      retryable: false,
      details: {
        context_error_code: 'SESSION_AMBIGUOUS',
        source: 'open_sessions',
        candidates: ['session-a', 'session-z'],
      },
      target_type: null,
      target_id: null,
      expected_revision: null,
      current_revision: null,
      changed_by: null,
      next_actions: ['select-session:session-a', 'select-session:session-z'],
    });
    expect(runResponseErrorDetailV12Schema.parse(detail)).toEqual(detail);
  });
});
