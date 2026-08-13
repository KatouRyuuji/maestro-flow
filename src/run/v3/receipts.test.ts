import { describe, expect, it } from 'vitest';

import type { RequestReceiptV20, TransitionReceiptV20 } from '../protocol-schemas.js';
import {
  canonicalPayloadHash,
  createRequestReceipt,
  createTransitionReceipt,
  parseTransitionReceiptRef,
  replayRequestReceipt,
  transitionReceiptRef,
} from './receipts.js';
import { V3StructuredError } from './errors.js';

function transition(): TransitionReceiptV20 {
  return createTransitionReceipt({
    transitionId: 'tr-1', requestId: 'req-1', sessionId: 's-1', activityRevision: 1,
    targetType: 'run', targetId: 'r-1', revisionBefore: 0, revisionAfter: 1,
    actorId: 'actor', participantId: 'p-1', reason: 'test', recordedAt: '2026-08-12T00:00:00.000Z',
    result: { status: 'running' },
  });
}

function tx(request: RequestReceiptV20 | null, receipt: TransitionReceiptV20 | null) {
  return {
    readRequestReceipt: () => request,
    readTransitionReceipt: () => receipt,
  };
}

describe('v3 request and transition receipts', () => {
  it('hashes canonical payloads independently of key order', () => {
    expect(canonicalPayloadHash({ b: 2, a: 1 })).toBe(canonicalPayloadHash({ a: 1, b: 2 }));
  });

  it('round-trips canonical transition references', () => {
    const reference = transitionReceiptRef(12, 'tr-1');
    expect(reference).toBe('receipts/transitions/000000000012-tr-1.json');
    expect(parseTransitionReceiptRef(reference)).toEqual({ activityRevision: 12, transitionId: 'tr-1' });
    expect(() => parseTransitionReceiptRef('receipts/transitions/12-tr-1.json')).toThrow(/invalid/);
  });

  it('replays the original transition for the same participant and payload', () => {
    const receipt = transition();
    const payloadHash = canonicalPayloadHash({ operation: 'run-transition' });
    const request = createRequestReceipt({
      requestId: 'req-1', participantId: 'p-1', payloadHash,
      transitionReceiptRef: transitionReceiptRef(1, 'tr-1'),
    });
    expect(replayRequestReceipt({
      tx: tx(request, receipt), sessionId: 's-1', requestId: 'req-1', participantId: 'p-1', payloadHash,
    })).toEqual(receipt);
  });

  it.each([
    ['different payload', 'p-1', canonicalPayloadHash({ operation: 'other' })],
    ['different participant', 'p-2', canonicalPayloadHash({ operation: 'run-transition' })],
  ])('rejects %s as REQUEST_CONFLICT', (_name, participantId, suppliedHash) => {
    const receipt = transition();
    const storedHash = canonicalPayloadHash({ operation: 'run-transition' });
    const request = createRequestReceipt({
      requestId: 'req-1', participantId: 'p-1', payloadHash: storedHash,
      transitionReceiptRef: transitionReceiptRef(1, 'tr-1'),
    });
    try {
      replayRequestReceipt({
        tx: tx(request, receipt), sessionId: 's-1', requestId: 'req-1', participantId, payloadHash: suppliedHash,
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(V3StructuredError);
      expect((error as V3StructuredError).code).toBe('REQUEST_CONFLICT');
    }
  });
});
