import { describe, expect, it, vi } from 'vitest';
import type { IcpInitiationPermit } from '../../shared/contracts/icp-autonomy.js';
import type { IcpInitiationCandidate } from '../../core/icp/initiation-candidate.js';
import { createIcpAutonomyCandidateDispatcher } from './icp-autonomy-candidate-dispatcher.js';

const NOW_MS = 2_000;
const LOCAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_SENDER = '77777777-7777-4777-8777-777777777777';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const PROVENANCE = 'icp-prov:11111111-1111-4111-8111-111111111111';
const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;

function candidate(): IcpInitiationCandidate {
  return {
    candidateId: CANDIDATE_ID,
    rootInitiationId: ROOT_ID,
    localCompanionId: LOCAL,
    peerContactId: 'peer-contact-b',
    peerCompanionId: PEER,
    preferredChannel: 'dm',
    source: 'intention',
    provenanceRef: PROVENANCE,
    reasonSummary: 'Continue the approved private research task.',
    continuationTaskKind: 'research',
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    status: 'permitted',
    revision: 2,
  };
}

function permit(): IcpInitiationPermit {
  return {
    permitId: PERMIT_ID,
    candidateId: CANDIDATE_ID,
    conversationId: CONVERSATION_ID,
    senderCompanionId: LOCAL,
    recipientCompanionId: PEER,
    channelId: CHANNEL,
    provenanceRef: PROVENANCE,
    issuedAtMs: 1_500,
    expiresAtMs: 5_000,
    status: 'issued',
    revision: 1,
  };
}

describe('production ICP autonomy candidate dispatcher', () => {
  it('runs one canonical private scheduler turn with exact local notify arguments', async () => {
    const runCandidateTurn = vi.fn(async () => ({ content: 'done' }));
    const dispatcher = createIcpAutonomyCandidateDispatcher({
      runCandidateTurn,
      now: () => new Date(NOW_MS),
    });

    await dispatcher.dispatch({ candidate: candidate(), permit: permit() });

    expect(runCandidateTurn).toHaveBeenCalledTimes(1);
    const message = runCandidateTurn.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      id: `icp-autonomy-candidate:${CANDIDATE_ID}`,
      channelId: `internal:icp-autonomy:${CANDIDATE_ID}`,
      channelType: 'terminal',
      authorId: 'system:icp-autonomy',
      routing: {
        icpAutonomyCandidate: {
          candidateId: CANDIDATE_ID,
          rootInitiationId: ROOT_ID,
          source: 'intention',
          provenanceRef: PROVENANCE,
          continuationTaskKind: 'research',
        },
      },
    });
    expect(message?.content).toContain(JSON.stringify(candidate().reasonSummary));
    expect(message?.content).toContain(JSON.stringify('peer-contact-b'));
    expect(message?.content).toContain(JSON.stringify(PERMIT_ID));
    expect(message?.routing?.icpAutonomyCandidate).not.toHaveProperty('reasonSummary');
    expect(message?.routing?.icpAutonomyCandidate).not.toHaveProperty('peerContactId');
    expect(message?.routing?.icpAutonomyCandidate).not.toHaveProperty('permitId');
  });

  it.each([
    {
      name: 'candidate id',
      mutate: (value: IcpInitiationPermit) => ({
        ...value,
        candidateId: '66666666-6666-4666-8666-666666666666',
      }),
    },
    {
      name: 'sender companion',
      mutate: (value: IcpInitiationPermit) => ({
        ...value,
        senderCompanionId: OTHER_SENDER,
        channelId: `companion-dm:${OTHER_SENDER}:${PEER}`,
      }),
    },
    {
      name: 'recipient companion',
      mutate: (value: IcpInitiationPermit) => ({
        ...value,
        recipientCompanionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        channelId: `companion-dm:${LOCAL}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      }),
    },
    {
      name: 'provenance',
      mutate: (value: IcpInitiationPermit) => ({
        ...value,
        provenanceRef: 'icp-prov:88888888-8888-4888-8888-888888888888',
      }),
    },
    {
      name: 'preferred channel kind',
      mutate: (value: IcpInitiationPermit) => ({
        ...value,
        channelId: 'companion-room:study',
      }),
    },
  ])('rejects a permit with mismatched $name before a model turn', async ({ mutate }) => {
    const runCandidateTurn = vi.fn();
    const dispatcher = createIcpAutonomyCandidateDispatcher({
      runCandidateTurn,
      now: () => new Date(NOW_MS),
    });

    await expect(dispatcher.dispatch({
      candidate: candidate(),
      permit: mutate(permit()),
    })).rejects.toThrow(/candidate|permit|channel/i);

    expect(runCandidateTurn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'expired private candidate',
      binding: () => ({
        candidate: { ...candidate(), expiresAtMs: NOW_MS },
        permit: permit(),
      }),
    },
    {
      name: 'expired broker permit',
      binding: () => ({
        candidate: candidate(),
        permit: { ...permit(), expiresAtMs: NOW_MS },
      }),
    },
    {
      name: 'non-permitted private candidate',
      binding: () => ({
        candidate: { ...candidate(), status: 'deferred' as const },
        permit: permit(),
      }),
    },
  ])('rejects an $name before a model turn', async ({ binding }) => {
    const runCandidateTurn = vi.fn();
    const dispatcher = createIcpAutonomyCandidateDispatcher({
      runCandidateTurn,
      now: () => new Date(NOW_MS),
    });

    await expect(dispatcher.dispatch(binding())).rejects.toThrow(/candidate|permit/i);

    expect(runCandidateTurn).not.toHaveBeenCalled();
  });

  it('rejects extra dispatch fields before a model turn', async () => {
    const runCandidateTurn = vi.fn();
    const dispatcher = createIcpAutonomyCandidateDispatcher({
      runCandidateTurn,
      now: () => new Date(NOW_MS),
    });

    await expect(dispatcher.dispatch({
      candidate: candidate(),
      permit: permit(),
      reasonSummary: 'forbidden parallel authority',
    } as never)).rejects.toThrow(/unknown key/i);

    expect(runCandidateTurn).not.toHaveBeenCalled();
  });

  it('propagates a trusted turn-activation failure without starting the agent loop', async () => {
    const runCandidateTurn = vi.fn(async () => {
      throw new Error('notify candidate turn activation is no longer authorized');
    });
    const dispatcher = createIcpAutonomyCandidateDispatcher({
      runCandidateTurn,
      now: () => new Date(NOW_MS),
    });

    await expect(dispatcher.dispatch({
      candidate: candidate(),
      permit: permit(),
    })).rejects.toThrow('activation is no longer authorized');

    expect(runCandidateTurn).toHaveBeenCalledTimes(1);
  });
});
