import { describe, expect, it } from 'vitest';
import {
  APPROVALS_UNSUPPORTED_REASON,
  deriveApprovalPanelState,
  submitApprovalDecision,
} from './approvals.js';
import { createInitialHubStreamState } from './stream/hub-stream.js';

describe('approval panel fail-closed state', () => {
  it('reports unsupported approval capability when hub protocol has no approval messages', () => {
    expect(deriveApprovalPanelState(createInitialHubStreamState())).toEqual({
      capability: 'unsupported',
      requests: [],
      blockedReason: APPROVALS_UNSUPPORTED_REASON,
    });
  });

  it('blocks approval decisions without a hub approval path', () => {
    expect(() => submitApprovalDecision()).toThrow(APPROVALS_UNSUPPORTED_REASON);
  });
});
