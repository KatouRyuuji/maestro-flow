import { describe, expect, it } from 'vitest';

import { resumeMapV1Schema } from '../protocol-schemas.js';
import type { RunV30, SessionStateV30 } from '../schemas.js';
import {
  RESUME_MAP_MAX_UTF8_BYTES,
  ResumeMapProjectionError,
  assertResumeMapHasNoForbiddenFields,
  computeResumeMapFingerprint,
  projectResumeMapV1,
  resumeMapUtf8Bytes,
  verifyResumeMapFingerprint,
  type ResumeMapProjectionInput,
} from './resume-view.js';

const session = (overrides: Partial<SessionStateV30> = {}): SessionStateV30 => ({
  schema_version: 'session/3.0',
  session_id: 'session-1',
  objective: 'Resume deterministic work',
  definition_of_done: 'The projection is bounded and verifiable.',
  status: 'open',
  orchestration_revision: 5,
  activity_revision: 8,
  chain: [],
  decisions: [],
  active_run_ids: ['run-b', 'run-a'],
  artifacts_ref: 'artifacts.json',
  evidence_ref: 'evidence.json',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:01:00.000Z',
  completed_at: null,
  archived_at: null,
  ...overrides,
});

const run = (runId: string, overrides: Partial<RunV30> = {}): RunV30 => ({
  schema_version: 'run/3.0',
  run_id: runId,
  session_id: 'session-1',
  step_id: `step-${runId}`,
  parent_run_id: null,
  retry_of_run_id: null,
  attempt: 1,
  command: 'workflow execute',
  args: [],
  goal: null,
  status: 'running',
  revision: runId === 'run-a' ? 3 : 4,
  actor_id: 'actor-1',
  input_refs: [],
  output_refs: [],
  primary_artifact_id: null,
  verdict: null,
  summary: null,
  created_at: '2026-08-12T00:00:00.000Z',
  started_at: '2026-08-12T00:00:01.000Z',
  ended_at: null,
  sealed_at: null,
  ...overrides,
});

const input = (overrides: Partial<ResumeMapProjectionInput> = {}): ResumeMapProjectionInput => ({
  session: session(),
  runs: [run('run-b', { status: 'blocked' }), run('run-a')],
  blockingGates: ['gate-z', 'gate-a'],
  openDecisions: ['decision-z', 'decision-a'],
  pendingPublications: [
    { publicationId: 'publication-z', resourceUri: 'artifact://z' },
    { publicationId: 'publication-a', resourceUri: 'artifact://a' },
  ],
  nextActions: [
    { action: 'run-complete', targetId: 'run-a', expectedRevision: 3 },
    { action: 'run-check', targetId: 'run-b', expectedRevision: 4 },
    { action: 'session-chain-audit', targetId: 'session-1', expectedRevision: 5 },
  ],
  ...overrides,
});

describe('ResumeMapV1 projection', () => {
  it('projects every contract field through the strict schema in stable ID order', () => {
    const map = projectResumeMapV1(input({
      runs: [
        run('not-active'),
        run('run-b', { status: 'blocked', revision: 3 }),
        run('run-a'),
        run('run-b', { status: 'blocked', revision: 4 }),
      ],
      blockingGates: ['gate-z', 'gate-a', 'gate-z'],
      openDecisions: ['decision-z', 'decision-a', 'decision-a'],
      pendingPublications: [
        { publicationId: 'publication-z' },
        { publicationId: 'publication-a', resourceUri: 'artifact://z' },
        { publicationId: 'publication-a', resourceUri: 'artifact://a' },
      ],
      nextActions: [
        { action: 'run-check', targetId: 'run-b', expectedRevision: 3 },
        { action: 'run-check', targetId: 'run-b', expectedRevision: 4 },
        { action: 'run-complete', targetId: 'run-a', expectedRevision: 3 },
      ],
    }));

    expect(resumeMapV1Schema.parse(map)).toEqual(map);
    expect(map).toMatchObject({
      sessionId: 'session-1',
      sessionStatus: 'open',
      orchestrationRevision: 5,
      activityRevision: 8,
      activeRuns: [
        { runId: 'run-a', stepId: 'step-run-a', status: 'running', revision: 3 },
        { runId: 'run-b', stepId: 'step-run-b', status: 'blocked', revision: 4 },
      ],
      blockingGates: ['gate-a', 'gate-z'],
      openDecisions: ['decision-a', 'decision-z'],
      pendingPublications: [
        { publicationId: 'publication-a', resourceUri: 'artifact://a' },
        { publicationId: 'publication-z' },
      ],
      nextActions: [
        { action: 'run-complete', targetId: 'run-a', expectedRevision: 3 },
        { action: 'run-check', targetId: 'run-b', expectedRevision: 4 },
      ],
    });
    expect(verifyResumeMapFingerprint(map)).toBe(true);
  });

  it.each([
    'pending', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'sealed',
  ] as const)('projects schema-authorized %s Run status', status => {
    const map = projectResumeMapV1(input({
      session: session({ active_run_ids: ['run-a'] }),
      runs: [run('run-a', { status })],
      blockingGates: [],
      openDecisions: [],
      pendingPublications: [],
      nextActions: [],
    }));
    expect(map.activeRuns).toEqual([{
      runId: 'run-a', stepId: 'step-run-a', status, revision: 3,
    }]);
  });

  it('produces identical canonical content and fingerprint for shuffled inputs', () => {
    const forward = input();
    const reversed = input({
      session: session({ active_run_ids: ['run-a', 'run-b', 'run-a'] }),
      runs: [...forward.runs].reverse(),
      blockingGates: [...forward.blockingGates].reverse(),
      openDecisions: [...forward.openDecisions].reverse(),
      pendingPublications: [...forward.pendingPublications].reverse(),
      nextActions: [...forward.nextActions].reverse(),
    });
    expect(projectResumeMapV1(reversed)).toEqual(projectResumeMapV1(forward));
  });

  it('changes the fingerprint when an authority revision changes', () => {
    const original = projectResumeMapV1(input());
    const changed = projectResumeMapV1(input({
      session: session({ activity_revision: 9 }),
    }));
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(verifyResumeMapFingerprint(changed)).toBe(true);
  });

  it('recomputes fingerprints without trusting key insertion order and rejects tampering', () => {
    const map = projectResumeMapV1(input());
    const { fingerprint, ...body } = map;
    expect(fingerprint).toBe(computeResumeMapFingerprint(body));
    expect(verifyResumeMapFingerprint({ ...map, activityRevision: 999 })).toBe(false);
    expect(verifyResumeMapFingerprint({ ...map, operation: 'resume' })).toBe(false);
  });

  it('deep-scans forbidden execution, generation, lease, and operation field names', () => {
    expect(() => assertResumeMapHasNoForbiddenFields({
      safe: [{ nested: { execution_id: 'old' } }],
    })).toThrowError(ResumeMapProjectionError);
    expect(() => assertResumeMapHasNoForbiddenFields({ generation: 1 })).toThrowError();
    expect(() => assertResumeMapHasNoForbiddenFields({ detail: { leaseToken: 'old' } })).toThrowError();
    expect(() => assertResumeMapHasNoForbiddenFields({ operation_name: 'old' })).toThrowError();
    expect(() => assertResumeMapHasNoForbiddenFields(projectResumeMapV1(input()))).not.toThrow();
  });

  it('passes maps within the 2KB boundary and throws when the projection exceeds it', () => {
    const small = projectResumeMapV1(input());
    expect(resumeMapUtf8Bytes(small)).toBeLessThanOrEqual(RESUME_MAP_MAX_UTF8_BYTES);
    expect(verifyResumeMapFingerprint(small)).toBe(true);

    // A map that fits exactly at the boundary still projects.
    let exactBoundary: ReturnType<typeof projectResumeMapV1> | undefined;
    let boundaryUriLength = -1;
    for (let length = 0; length < 3000; length += 1) {
      const map = projectResumeMapV1(input({
        pendingPublications: [{ publicationId: 'publication-a', resourceUri: `x:${'a'.repeat(length)}` }],
      }));
      if (resumeMapUtf8Bytes(map) === RESUME_MAP_MAX_UTF8_BYTES) {
        exactBoundary = map;
        boundaryUriLength = length;
        break;
      }
    }
    expect(exactBoundary).toBeDefined();
    expect(resumeMapUtf8Bytes(exactBoundary!)).toBe(2048);

    // One byte beyond the boundary throws instead of truncating.
    expect(() => projectResumeMapV1(input({
      pendingPublications: [{
        publicationId: 'publication-a',
        resourceUri: `x:${'a'.repeat(boundaryUriLength + 1)}`,
      }],
    }))).toThrowError(ResumeMapProjectionError);
  });

  it('throws on oversized projections instead of evicting runs, gates, or actions', () => {
    const manyRuns = Array.from({ length: 80 }, (_, index) => {
      const id = `run-${String(index).padStart(3, '0')}`;
      return run(id, { revision: index, status: index === 0 ? 'blocked' : 'pending' });
    });
    expect(() => projectResumeMapV1(input({
      session: session({ active_run_ids: manyRuns.map(item => item.run_id) }),
      runs: manyRuns,
      blockingGates: ['gate-critical'],
      openDecisions: [],
      pendingPublications: [],
      nextActions: manyRuns.map(item => ({
        action: 'run-check', targetId: item.run_id, expectedRevision: item.revision,
      })),
    }))).toThrowError(ResumeMapProjectionError);
  });

  it('fails closed when an active Run document is unavailable', () => {
    expect(() => projectResumeMapV1(input({ runs: [run('run-a')] })))
      .toThrowError(/run-b/);
  });

  it('fails rather than shortening an authority ID when the irreducible map exceeds 2KB', () => {
    const hugeId = `session-${'x'.repeat(2200)}`;
    expect(() => projectResumeMapV1(input({
      session: session({ session_id: hugeId, active_run_ids: [] }),
      runs: [],
      blockingGates: [],
      openDecisions: [],
      pendingPublications: [],
      nextActions: [],
    }))).toThrowError(/exceeds 2048 UTF-8 bytes/);
  });
});
