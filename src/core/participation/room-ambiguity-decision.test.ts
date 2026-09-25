import { describe, expect, it, vi } from 'vitest';
import { createDefaultRoomSignalSettings } from '../../system/config/participation-config.js';
import type { DecisionOutcome, DecisionRequest } from '../../primitives/llm/decision/types.js';
import {
  DecisionRoomAmbiguityClassifier,
  InProcessRoomClassificationClaim,
} from './room-ambiguity-decision.js';

const INPUT = {
  roomId: 'room-1',
  messageId: 'msg-1',
  excerpt: 'the migration is stuck again‮',
  interests: ['persistence'],
};

function noul(pYes: number): DecisionOutcome {
  return {
    ok: true,
    answers: { relevant: { type: 'noul', pYes } },
    backend: 'jev',
    probabilitySource: 'jev',
    latencyMs: 40,
  };
}

function classifier(outcome: DecisionOutcome, threshold: number | null = 0.7) {
  const decide = vi.fn(async (_request: DecisionRequest) => outcome);
  const instance = new DecisionRoomAmbiguityClassifier({
    decisions: {
      decide,
      siteSettings: () => (threshold === null ? undefined : { enabled: true, threshold }),
    },
    classifier: { ...createDefaultRoomSignalSettings().classifier, enabled: true, maxOutputTokens: 64 },
    companionId: 'companion-1',
  });
  return { instance, decide };
}

describe('DecisionRoomAmbiguityClassifier', () => {
  it('is relevant when the yes-probability clears the threshold', async () => {
    await expect(classifier(noul(0.7)).instance.classify(INPUT)).resolves.toEqual({ relevant: true });
    await expect(classifier(noul(0.69)).instance.classify(INPUT)).resolves.toEqual({ relevant: false });
  });

  it('asks one content-minimal noul question on the room.ambiguity site', async () => {
    const { instance, decide } = classifier(noul(0.9));
    await instance.classify(INPUT);
    const request = decide.mock.calls[0]?.[0];
    expect(request?.siteId).toBe('room.ambiguity');
    expect(request?.state).toEqual({ excerpt: 'the migration is stuck again', interests: ['persistence'] });
    expect(Object.keys(request?.questions ?? {})).toEqual(['relevant']);
    expect(request?.workSpec).toMatchObject({ purpose: 'decision', maxOutputTokens: 64, deadlineMs: 4_000 });
  });

  it('fails closed to not relevant on a decision failure', async () => {
    const { instance } = classifier({ ok: false, reason: 'error', backend: 'local', latencyMs: 3 });
    await expect(instance.classify(INPUT)).resolves.toEqual({ relevant: false });
  });

  it('does not run without an owner threshold', async () => {
    const { instance, decide } = classifier(noul(1), null);
    await expect(instance.classify(INPUT)).resolves.toEqual({ relevant: false });
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('InProcessRoomClassificationClaim', () => {
  it('grants each physical message once and stays bounded', async () => {
    const claims = new InProcessRoomClassificationClaim(2);
    await expect(claims.claim({ roomId: 'r', messageId: 'a' })).resolves.toBe(true);
    await expect(claims.claim({ roomId: 'r', messageId: 'a' })).resolves.toBe(false);
    await claims.claim({ roomId: 'r', messageId: 'b' });
    await claims.claim({ roomId: 'r', messageId: 'c' });
    await expect(claims.claim({ roomId: 'r', messageId: 'a' })).resolves.toBe(true);
  });
});
