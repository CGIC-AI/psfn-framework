import { describe, expect, it, vi } from 'vitest';

import { loadChargePolicySeedDefaults } from '../../../system/config/charge-policy-config.js';
import { loadSchedulerSeedDefaults } from '../../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { OutboundReplyDeduper } from '../../../system/lifecycle/outbound-reply-dedupe.js';
import { wireSpeakingArbiterLane, type SpeakingArbiterLaneDeps } from './speaking-arbiter-lane.js';

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeDeps(mode: 'off' | 'shadow' | 'on'): SpeakingArbiterLaneDeps {
  const schedulerConfig = loadSchedulerSeedDefaults();
  schedulerConfig.socialAutonomy.egressLease.mode = mode;
  return {
    config: {
      companionId: COMPANION_ID,
      multiCompanion: true,
      chargePolicy: loadChargePolicySeedDefaults(),
    } as SubstrateConfig,
    schedulerConfig,
    llmProvider: { complete: vi.fn() } as never,
    agentLoop: { handleMessage: vi.fn() } as never,
    companionName: 'Selene',
    observedGroupMemoryScheduler: {
      classifyChannelMemoryScope: vi.fn(async () => 'group'),
    } as never,
    sessionStore: { getRecent: vi.fn(() => []) } as never,
    persistenceRuntime: {
      speakingArbiterStore: {},
      socialPotStore: {},
    } as never,
    coreRuntime: { fatigueLedger: {} } as never,
    gatewaySender: { send: vi.fn(async () => undefined) },
    outboundReplyGuard: new OutboundReplyDeduper(),
  };
}

describe('wireSpeakingArbiterLane owner-controlled egress posture', () => {
  it('keeps off inert and assembles the hardened phase for shadow and on', () => {
    expect(wireSpeakingArbiterLane(makeDeps('off')).egressLeasePhase).toBeUndefined();
    expect(wireSpeakingArbiterLane(makeDeps('shadow')).egressLeasePhase).toBeDefined();
    expect(wireSpeakingArbiterLane(makeDeps('on')).egressLeasePhase).toBeDefined();
  });
});
