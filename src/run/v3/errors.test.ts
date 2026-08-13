import { describe, expect, it } from 'vitest';

import { runResponseErrorDetailV12Schema } from '../protocol-schemas.js';
import {
  V3StructuredError,
  createRequestConflictError,
  createRevisionConflictError,
  createSessionAmbiguousError,
  createSessionSchemaUnsupportedError,
} from './errors.js';

describe('v3 structured errors', () => {
  it('serializes and schema-validates the complete revision conflict contract', () => {
    const error = createRevisionConflictError({
      code: 'RUN_REVISION_CONFLICT', targetType: 'run', targetId: 'run-123',
      expectedRevision: 3, currentRevision: 4, changedBy: 'pi-window-a',
    });

    expect(error).toBeInstanceOf(V3StructuredError);
    expect(error.toRunResponseV12ErrorDetail()).toEqual({
      code: 'RUN_REVISION_CONFLICT',
      message: 'revision conflict for run run-123',
      retryable: true,
      details: {},
      target_type: 'run',
      target_id: 'run-123',
      expected_revision: 3,
      current_revision: 4,
      changed_by: 'pi-window-a',
      next_actions: ['reload-target', 're-evaluate-intent', 'resubmit-with-new-request-id'],
    });
    expect(runResponseErrorDetailV12Schema.parse(error.toJSON())).toEqual(error.toJSON());
  });

  it('puts REQUEST_CONFLICT request metadata in details and emits explicit null CAS fields', () => {
    const detail = createRequestConflictError({
      requestId: 'req-1', changedBy: 'participant-a',
    }).toRunResponseV12ErrorDetail();

    expect(detail).toEqual({
      code: 'REQUEST_CONFLICT',
      message: 'request req-1 conflicts with an existing receipt',
      retryable: false,
      details: { request_id: 'req-1', changed_by: 'participant-a' },
      target_type: null,
      target_id: null,
      expected_revision: null,
      current_revision: null,
      changed_by: null,
      next_actions: ['use-the-original-payload', 'submit-with-new-request-id'],
    });
    expect(runResponseErrorDetailV12Schema.parse(detail)).toEqual(detail);
  });

  it('puts stable SESSION_AMBIGUOUS candidates in details without inventing a target type', () => {
    const detail = createSessionAmbiguousError({
      candidateSessionIds: ['s-2', ' s-1 ', 's-2'],
    }).toRunResponseV12ErrorDetail();

    expect(detail).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      details: { candidates: ['s-1', 's-2'] },
      target_type: null,
      target_id: null,
      expected_revision: null,
      current_revision: null,
      changed_by: null,
      next_actions: ['select-session:s-1', 'select-session:s-2'],
    });
    expect(runResponseErrorDetailV12Schema.parse(detail)).toEqual(detail);
  });

  it('puts SESSION_SCHEMA_UNSUPPORTED session and schema metadata in details', () => {
    const detail = createSessionSchemaUnsupportedError({
      sessionId: 's-1', schemaVersion: 'session/3.0',
    }).toRunResponseV12ErrorDetail();

    expect(detail).toMatchObject({
      code: 'SESSION_SCHEMA_UNSUPPORTED',
      retryable: false,
      details: { session_id: 's-1', schema_version: 'session/3.0' },
      target_type: null,
      target_id: null,
      next_actions: ['upgrade-maestro', 'use-a-schema-compatible-command'],
    });
    expect(runResponseErrorDetailV12Schema.parse(detail)).toEqual(detail);
  });

  it('uses only protocol-recognized codes and transition target types at compile time', () => {
    const error = new V3StructuredError('INVALID_STATE_TRANSITION', 'transition rejected', {
      details: { reason: 'RUN_TRANSITION_INVALID' },
      target_type: 'run',
    });
    expect(runResponseErrorDetailV12Schema.parse(error.toRunResponseV12ErrorDetail()))
      .toMatchObject({ code: 'INVALID_STATE_TRANSITION', target_type: 'run' });
  });
});
