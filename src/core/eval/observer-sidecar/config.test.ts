import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultObserverEvalSidecarSettings } from '../../../system/config/runtime-config-contracts.js';
import { createObserverEvalSidecarRuntimeFromConfig } from './config.js';
import type { ObserverEvalInputPayload } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('createObserverEvalSidecarRuntimeFromConfig', () => {
  it('keeps the observer detached when the sidecar is disabled', () => {
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    });

    expect(runtime.config?.enabled).toBe(false);
    expect(runtime.observer).toBeNull();
  });

  it('attaches an EmoSim observer for enabled sidecar settings', async () => {
    const emoSimRoot = mkdtempSync(join(tmpdir(), 'psfn-emosim-missing-'));
    tempDirs.push(emoSimRoot);
    const runtime = createObserverEvalSidecarRuntimeFromConfig({
      observerEvalSidecar: {
        ...createDefaultObserverEvalSidecarSettings(),
        enabled: true,
        adapter: {
          kind: 'emosim',
          emosimRoot: emoSimRoot,
          includeWorldState: false,
        },
        persistence: {
          enabled: false,
          retentionDays: 14,
          maxStoredObservations: 10_000,
        },
      },
    });

    expect(runtime.config?.enabled).toBe(true);
    expect(runtime.observer).not.toBeNull();
    await expect(runtime.observer?.observeTurn(makeObserverInput())).rejects.toThrow(
      'EmoSim statemashine.py was not found',
    );
  });
});

function makeObserverInput(): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-1',
      requestId: 'request-1',
      sourceMessageId: 'message-1',
      channelId: 'channel-1',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: true,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: {
        vad: { valence: 0.4, arousal: 0.2, dominance: 0.1 },
        mood: { valence: 0.2, arousal: 0.1, dominance: 0.05 },
        discrete: { joy: 0.5, trust: 0.2 },
        confidence: 0.8,
      },
      appraisalEntryCount: 1,
    },
    metadata: {
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 24,
      attachmentCount: 0,
      hasVisionInput: false,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_000,
      emotionSessionId: 'emotion-session-1',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'chat',
      },
    },
  };
}
