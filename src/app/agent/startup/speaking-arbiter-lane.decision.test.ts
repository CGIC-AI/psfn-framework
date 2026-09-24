import { describe, expect, it, vi } from 'vitest';

import { loadSchedulerSeedDefaults } from '../../../system/config/scheduler-config.js';
import { createDefaultDecisionBackendSettings } from '../../../system/config/decision-backend-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { OutboundReplyDeduper } from '../../../system/lifecycle/outbound-reply-dedupe.js';
import type { RoomSignalRuntime } from '../../../core/participation/passive-name-candidate.js';
import type { DecisionOutcome } from '../../../primitives/llm/decision/types.js';

const captured = vi.hoisted(() => ({ roomSignal: undefined as unknown }));

vi.mock('../../../core/participation/passive-name-candidate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/participation/passive-name-candidate.js')>();
  class CapturingBuilder extends actual.PassiveNameCandidateBuilder {
    constructor(options: ConstructorParameters<typeof actual.PassiveNameCandidateBuilder>[0]) {
      super(options);
      captured.roomSignal = options.roomSignal;
    }
  }
  return { ...actual, PassiveNameCandidateBuilder: CapturingBuilder };
});

const { wireSpeakingArbiterLane } = await import('./speaking-arbiter-lane.js');

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function deps(options: { multiCompanion: boolean; siteEnabled: boolean; decide: ReturnType<typeof vi.fn> }) {
  const schedulerConfig = loadSchedulerSeedDefaults();
  const roomSignal = schedulerConfig.socialAutonomy.roomSignal;
  roomSignal.enabled = true;
  roomSignal.classifier = { ...roomSignal.classifier, enabled: true, maxOutputTokens: 64 };
  roomSignal.companionInterests = ['persistence'];
  const decisionBackend = {
    ...createDefaultDecisionBackendSettings(),
    sites: options.siteEnabled ? { 'room.ambiguity': { enabled: true, threshold: 0.6 } } : {},
  };
  return {
    config: {
      companionId: COMPANION_ID,
      multiCompanion: options.multiCompanion,
      decisionBackend,
    } as SubstrateConfig,
    schedulerConfig,
    llmProvider: { complete: vi.fn() } as never,
    agentLoop: { handleMessage: vi.fn(), getEgressDeliveryRecorder: () => null } as never,
    companionName: 'Selene',
    observedGroupMemoryScheduler: { classifyChannelMemoryScope: vi.fn(async () => 'group') } as never,
    sessionStore: { getRecent: vi.fn(() => []) } as never,
    persistenceRuntime: {} as never,
    coreRuntime: {
      fatigueLedger: {},
      biographicalAliasResolverFor: () => ({ resolve: async () => [] }),
      decisionRuntime: {
        decide: options.decide,
        effectiveMode: () => 'local',
        siteSettings: (siteId: string) => decisionBackend.sites[siteId as 'room.ambiguity'],
      },
    } as never,
    gatewaySender: { send: vi.fn(async () => undefined) },
    outboundReplyGuard: new OutboundReplyDeduper(),
  };
}

const RELEVANT: DecisionOutcome = {
  ok: true,
  answers: { relevant: { type: 'noul', pYes: 0.8 } },
  backend: 'local',
  probabilitySource: 'self_report_uncalibrated',
  latencyMs: 12,
};

describe('wireSpeakingArbiterLane room ambiguity classifier', () => {
  it('wires a decide()-backed classifier that runs once per physical message', async () => {
    const decide = vi.fn(async () => RELEVANT);
    wireSpeakingArbiterLane(deps({ multiCompanion: false, siteEnabled: true, decide }));
    const runtime = captured.roomSignal as RoomSignalRuntime;
    expect(runtime.classifier).toBeDefined();

    // resolve() keys only on the physical message identity.
    const features = { roomId: 'room-1', messageId: 'msg-1' } as never;
    const input = { features, content: 'what do we do about that thing', interests: ['persistence'] };
    await expect(runtime.classifier?.resolve(input)).resolves.toEqual({ outcome: 'relevant' });
    await expect(runtime.classifier?.resolve(input)).resolves.toEqual({ outcome: 'relevant' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ siteId: 'room.ambiguity' });
  });

  it('builds no classifier unless the decision site is enabled', () => {
    wireSpeakingArbiterLane(deps({ multiCompanion: false, siteEnabled: false, decide: vi.fn() }));
    expect((captured.roomSignal as RoomSignalRuntime).classifier).toBeUndefined();
  });

  it('builds no classifier in a companion fleet without a durable claim', () => {
    wireSpeakingArbiterLane(deps({ multiCompanion: true, siteEnabled: true, decide: vi.fn() }));
    expect((captured.roomSignal as RoomSignalRuntime).classifier).toBeUndefined();
  });
});
