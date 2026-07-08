import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import { EmotionState, type EmotionStateSnapshot } from '../../emotion/state.js';
import type { EmotionObserver } from '../../emotion/observer.js';
import { buildSessionMetadataWithEmotionState } from '../../emotion/session-metadata.js';
import {
  createDmConversationScope,
  createGroupConversationScope,
} from '../../session/conversation-scope.js';
import { createDefaultEmotionScopingSettings } from '../../../system/config/emotion-scoping-config.js';
import type { SessionManager } from '../../session/manager.js';
import type { LLMProviderPort } from '../contracts.js';

const FIXED_NOW = 1_000_000_000;

// Observer stub: any message containing "HOT" spikes arousal; everything else
// is near-neutral. Returns the nested EmotionObserverResult shape the runtime
// normalizes.
const observer = {
  observe: async (text: string) => ({
    observation: text.includes('HOT')
      ? { vad: { valence: -0.7, arousal: 1, dominance: 0.5 }, confidence: 1 }
      : { vad: { valence: 0, arousal: 0.02, dominance: 0 }, confidence: 1 },
  }),
} as unknown as EmotionObserver;

const llmProvider = {
  complete: async () => ({ content: 'x' }),
} as unknown as LLMProviderPort;

function makeSessionManager(recent: (channelId: string) => Array<{ metadata?: string; timestamp: number; content?: string; role?: string }>): SessionManager {
  return {
    getRecentMessages: (channelId: string) => recent(channelId),
  } as unknown as SessionManager;
}

function makeRuntime(sessionManager: SessionManager): EmotionSelfModelRuntime {
  return new EmotionSelfModelRuntime({
    sessionManager,
    llmProvider,
    emotionRuntime: { state: new EmotionState(), observer, requireWiring: true },
    emotionScopingConfig: createDefaultEmotionScopingSettings(),
    getActiveConcernProvider: () => null,
    getPendingFollowUpProvider: () => null,
    getContactStore: () => null,
    getSelfModelRuntimeRequired: () => false,
    logger: { debug: () => {} },
  });
}

const groupScope = createGroupConversationScope({
  channelId: 'roomR',
  recentSpeakers: [{ authorId: 'contactA', name: 'A' }],
});
const dmMember = createDmConversationScope({ channelId: 'chanA', contact: { contactId: 'contactA' } });
const dmNonMember = createDmConversationScope({ channelId: 'chanB', contact: { contactId: 'contactB' } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scoped emotion runtime (E1.5)', () => {
  it('applies a bounded group→DM carry-over to a member and none to an unrelated contact', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const runtime = makeRuntime(makeSessionManager(() => []));

    // Heated group turn, then a member DM: the DM inherits elevated arousal.
    await runtime.observeEmotionState('HOT topic', 'roomR', groupScope);
    const member = await runtime.observeEmotionState('hi there', 'chanA', dmMember);

    // Re-enter the group (so the next transition is again group→DM), then a
    // NON-member DM: no modifier, so arousal reflects only the DM's own input.
    await runtime.observeEmotionState('HOT topic', 'roomR', groupScope);
    const nonMember = await runtime.observeEmotionState('hi there', 'chanB', dmNonMember);

    expect(member).not.toBeNull();
    expect(nonMember).not.toBeNull();
    expect(member!.vad.arousal).toBeGreaterThan(nonMember!.vad.arousal + 0.1);
    // Bounded: never exceeds the max modifier magnitude above the DM's own signal.
    expect(member!.vad.arousal).toBeLessThanOrEqual(1);
    // The unrelated DM contact sees essentially no modifier.
    expect(nonMember!.vad.arousal).toBeLessThan(0.1);
  });

  it('never leaks DM affect into a group (DM→group carries nothing)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    // Run with a heated DM inserted between two group turns.
    const withDm = makeRuntime(makeSessionManager(() => []));
    await withDm.observeEmotionState('HOT topic', 'roomR', groupScope);
    await withDm.observeEmotionState('HOT topic', 'chanA', dmMember); // heated member DM
    const groupAfterDm = await withDm.observeEmotionState('calm now', 'roomR', groupScope);

    // Control: identical group turns, no DM in between.
    const control = makeRuntime(makeSessionManager(() => []));
    await control.observeEmotionState('HOT topic', 'roomR', groupScope);
    const groupControl = await control.observeEmotionState('calm now', 'roomR', groupScope);

    // The group is unaffected by the DM's heat: same arousal as the control.
    expect(groupAfterDm!.vad.arousal).toBeCloseTo(groupControl!.vad.arousal, 6);
  });

  it('rehydrates scoped state (and re-seeds the global baseline) from session metadata after restart', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const persisted: EmotionStateSnapshot = {
      vad: { valence: 0.5, arousal: 0.4, dominance: 0.3 },
      mood: { valence: 0.6, arousal: 0.3, dominance: 0.2 },
      discrete: { joy: 0.5 },
      confidence: 0.8,
    };
    const metadata = buildSessionMetadataWithEmotionState(undefined, persisted);
    const runtime = makeRuntime(makeSessionManager((channelId) =>
      channelId === 'chanRestored'
        ? [{ metadata, timestamp: FIXED_NOW - 1000, content: 'prior turn', role: 'assistant' }]
        : [],
    ));

    const dmRestored = createDmConversationScope({ channelId: 'chanRestored', contact: { contactId: 'contactR' } });
    const result = await runtime.observeEmotionState('a neutral note', 'chanRestored', dmRestored);

    // Mood survived the restart (one neutral observation barely moves the EMA).
    expect(result!.mood.valence).toBeGreaterThan(0.5);
    // Her global mood baseline was re-seeded from the restored scope.
    expect(runtime.getGlobalMoodBaseline().valence).toBeGreaterThan(0.5);
  });
});
