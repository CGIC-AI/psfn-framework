import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import { createTurnId } from '../../turns/id.js';
import type { EmoSimAdapterInput, EmoSimRunContext } from './emosim-adapter.js';
import type { EmoSimServerRunnerOptions } from './emosim-server-adapter.js';
import { deriveObserverSocialContactKey } from './social-contact.js';
import type { ObserverEvalInputPayload } from './types.js';

const runnerCapture = vi.hoisted(() => ({
  options: [] as unknown[],
  runs: [] as { input: unknown; context: unknown }[],
}));

vi.mock('./emosim-server-adapter.js', () => ({
  createEmoSimServerRunner: (options: EmoSimServerRunnerOptions) => {
    runnerCapture.options.push(options);
    return {
      run: async (input: EmoSimAdapterInput, context?: EmoSimRunContext) => {
        runnerCapture.runs.push({ input, context });
        throw new Error('captured');
      },
      readCurrentState: async () => {
        throw new Error('not used');
      },
    };
  },
}));

const { createObserverEvalSidecarRuntimeFromConfig } = await import('./config.js');

const PERSONALITY = { O: 0.7, C: 0.45, E: 0.82, A: 0.6, N: 0.35 };

function makeRuntime() {
  return createObserverEvalSidecarRuntimeFromConfig({
    observerEvalSidecar: {
      ...createDefaultObserverEvalSidecarSettings(),
      enabled: true,
      sidecarId: 'observer-companion-a',
      adapter: {
        kind: 'emosim_server',
        serverUrl: 'http://emosim.test:17342',
        sessionLabel: 'companion-a-session',
        agentName: 'companion-a',
        personality: PERSONALITY,
        includeWorldState: false,
      },
    },
  }, {});
}

function makeInput(socialContactKey?: string): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: createTurnId('turn-social-1'),
      requestId: 'request-1',
      sourceMessageId: 'message-1',
      channelId: 'channel-1',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: { routingSource: 'api', isDirectMessage: true, channelPrivacy: 'public' },
    emotion: {
      snapshot: {
        vad: { valence: 0.4, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.2, arousal: 0.1, dominance: 0.05 },
        discrete: { joy: 0.5, trust: 0.2 },
        confidence: 0.8,
      },
      appraisalEntryCount: 1,
    },
    coherenceContext: { recentMirrorNoteCount: 0, timeGapMs: null, activeConcernCount: 0 },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 24,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
      ...(socialContactKey ? { socialContactKey } : {}),
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_000,
      emotionSessionId: 'emotion-session-1',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: { callType: 'chat', purpose: 'chat' },
    },
  };
}

describe('observer sidecar companion subject and social contact wiring', () => {
  beforeEach(() => {
    runnerCapture.options.length = 0;
    runnerCapture.runs.length = 0;
  });

  it('builds the runner and projected subject from the companion-owned personality', async () => {
    const runtime = makeRuntime();
    expect(runnerCapture.options).toEqual([expect.objectContaining({
      sessionLabel: 'companion-a-session',
      agentName: 'companion-a',
      personality: PERSONALITY,
    })]);

    await expect(runtime.observer?.observeTurn(makeInput())).rejects.toThrow('captured');
    const [run] = runnerCapture.runs;
    expect((run?.input as EmoSimAdapterInput).subject).toEqual({
      name: 'companion-a',
      uid: 'observer-companion-a',
      personality: PERSONALITY,
    });
  });

  it('hands the verified contact key to the runner only as live run context', async () => {
    const key = deriveObserverSocialContactKey({
      speakerRole: 'user',
      actorKind: 'human',
      canonicalContactKey: 'contact-operator',
    })!;
    const runtime = makeRuntime();

    // The stub runner fails after capturing its call; the observer surfaces it.
    await expect(runtime.observer?.observeTurn(makeInput(key))).rejects.toThrow('captured');
    await expect(runtime.observer?.observeTurn(makeInput())).rejects.toThrow('captured');

    const [social, ambient] = runnerCapture.runs;
    expect(social?.context).toEqual({ socialContactKey: key });
    expect(JSON.stringify(social?.input)).not.toContain(key);
    expect(ambient?.context).toBeUndefined();
  });
});
