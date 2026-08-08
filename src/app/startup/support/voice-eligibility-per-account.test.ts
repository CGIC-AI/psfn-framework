import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEligibilityGate,
  EligibilityDeniedError,
} from '../../../system/capabilities/eligibility.js';
import { GatewayCapabilityTierResolver } from '../../../boundary/gateway/capability-tier-resolver.js';
import { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import type { ResolvedCompanionsFleetConfig } from '../../../system/config/companions-config.js';
import { saveCapabilityTierConfig } from '../../../system/config/capability-tier-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { registerStreamingSttProvider } from '../../../primitives/voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../../primitives/voice/connectors/tts/index.js';
import { createRuntimeVoiceSttConnector } from './bootstrap-helpers.js';
import { buildConfiguredTtsConnectors } from '../../../channels/discord/voice-preflight.js';

// an52.5: a one-gateway/N-companion fleet where the gateway root grants
// external.web must still gate each per-account Discord voice surface against
// the ACCOUNT companion's own capability tier — a nursery companion's partner
// audio/TTS text must not egress to Deepgram/ElevenLabs just because the
// gateway root is higher-tier. Uses the real per-companion resolver.

const COMPANION_A = 'companion-a'; // autonomous: external.web granted
const COMPANION_B = 'companion-b'; // nursery: external.web withheld

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

function makeTierDir(root: string, name: string, tier: 'autonomous' | 'nursery'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  saveCapabilityTierConfig(dir, { tier, customTokens: [] });
  return dir;
}

function makePerCompanionEligibilityGate(input: { multiCompanion: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'an52-5-voice-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const dirA = makeTierDir(root, COMPANION_A, 'autonomous');
  const dirB = makeTierDir(root, COMPANION_B, 'nursery');
  // The gateway ROOT is autonomous (grants external.web) — the fleet-wide
  // "leaky" baseline the bug fell back to for every account.
  const baseDir = makeTierDir(root, 'gateway-root', 'autonomous');

  const companionFleet = {
    companions: [
      { companionId: COMPANION_A, companionDataDir: dirA },
      { companionId: COMPANION_B, companionDataDir: dirB },
    ],
  } as unknown as ResolvedCompanionsFleetConfig;

  const resolver = new GatewayCapabilityTierResolver({
    baseRuntime: new CapabilityRuntime({ dataDir: baseDir }),
    multiCompanion: input.multiCompanion,
    companionFleet,
  });
  const gate = createEligibilityGate((companionId) => resolver.resolveAccess(companionId));
  return { gate };
}

function registerExternalWebStt() {
  const createConnector = vi.fn(() => ({
    id: 'plugin-stt',
    startStream: vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    })),
  }));
  const restore = registerStreamingSttProvider('plugin-stt', {
    createConnector,
    metadata: {
      isConfigured: (config) => Boolean(config.pluginSttToken),
      eligibility: { requiredTokens: ['external.web'] },
    },
    resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginSttEndpoint) }),
  });
  cleanups.push(restore);
  return { createConnector };
}

function registerExternalWebTts() {
  const createConnector = vi.fn(() => ({
    id: 'plugin-tts',
    synthesizeStream: vi.fn(async () => ({
      audio: (async function* emptyAudio() {})(),
      cancel: async () => {},
    })),
    synthesizeBuffer: vi.fn(async () => Buffer.alloc(0)),
  }));
  const restore = registerStreamingTtsProvider('plugin-tts', {
    createConnector,
    metadata: {
      isConfigured: (config) => Boolean(config.pluginTtsToken),
      eligibility: { requiredTokens: ['external.web'] },
    },
    resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginTtsEndpoint) }),
  });
  cleanups.push(restore);
  return { createConnector };
}

const STT_CONFIG = fromPartial<SubstrateConfig>({
  sttProvider: 'plugin-stt',
  pluginSttToken: 'stt-key',
  pluginSttEndpoint: 'wss://plugin-stt.invalid',
});

const TTS_CONFIG = fromPartial<SubstrateConfig>({
  ttsProvider: 'plugin-tts',
  pluginTtsToken: 'tts-key',
  pluginTtsEndpoint: 'https://plugin-tts.invalid',
});

describe('per-account Discord voice eligibility resolves the account companion tier (an52.5)', () => {
  it('allows the autonomous account companion and denies the nursery account companion', () => {
    const { gate } = makePerCompanionEligibilityGate({ multiCompanion: true });
    const stt = registerExternalWebStt();
    const tts = registerExternalWebTts();

    // Companion A (autonomous): its own tier grants external.web -> connectors build.
    const sttA = createRuntimeVoiceSttConnector(STT_CONFIG, {
      eligibilityGate: gate,
      companionId: COMPANION_A,
    });
    expect(sttA).not.toBeNull();
    expect(stt.createConnector).toHaveBeenCalledTimes(1);
    const ttsA = buildConfiguredTtsConnectors(TTS_CONFIG, 'plugin-tts', gate, COMPANION_A);
    expect(ttsA).toHaveLength(1);
    expect(tts.createConnector).toHaveBeenCalledTimes(1);

    stt.createConnector.mockClear();
    tts.createConnector.mockClear();

    // Companion B (nursery): its OWN tier lacks external.web -> denied at
    // activation, BEFORE any connector/external I/O is constructed, even though
    // the gateway root tier (autonomous) would have granted it.
    let denied: unknown;
    try {
      createRuntimeVoiceSttConnector(STT_CONFIG, {
        eligibilityGate: gate,
        companionId: COMPANION_B,
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(EligibilityDeniedError);
    const decision = (denied as EligibilityDeniedError).decision;
    expect(decision.missingTokens).toContain('external.web');
    expect(decision.tier).toBe('nursery');
    expect(stt.createConnector).not.toHaveBeenCalled();

    // Discord's TTS builder disables voice by yielding no connectors for the
    // denied companion (it never reaches synthesis / external I/O).
    const ttsB = buildConfiguredTtsConnectors(TTS_CONFIG, 'plugin-tts', gate, COMPANION_B);
    expect(ttsB).toHaveLength(0);
    expect(tts.createConnector).not.toHaveBeenCalled();
  });

  it('fails closed (propagates) for an unknown account companion instead of using the gateway root', () => {
    const { gate } = makePerCompanionEligibilityGate({ multiCompanion: true });
    registerExternalWebStt();

    expect(() => createRuntimeVoiceSttConnector(STT_CONFIG, {
      eligibilityGate: gate,
      companionId: 'companion-unknown',
    })).toThrow(/No companion data dir is resolved for companion companion-unknown/);
  });

  it('leaves single-account mode unchanged: companionId is ignored and the root tier applies', () => {
    // multiCompanion=false -> resolveAccess returns the base (root) runtime
    // regardless of companionId, so a nursery companionId does not deny when the
    // gateway root is autonomous.
    const { gate } = makePerCompanionEligibilityGate({ multiCompanion: false });
    const stt = registerExternalWebStt();

    const binding = createRuntimeVoiceSttConnector(STT_CONFIG, {
      eligibilityGate: gate,
      companionId: COMPANION_B,
    });
    expect(binding).not.toBeNull();
    expect(stt.createConnector).toHaveBeenCalledTimes(1);
  });
});
