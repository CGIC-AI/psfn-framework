import { describe, it, expect } from 'vitest';
import { buildVoiceWebSocketServerOptions } from './voice-websocket-runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

// Wiring proof (bead zet.6): operator-set voice websocket transport limits must
// reach the WebSocketVoiceServer construction options. createApiVoiceWebSocketRuntime
// merges buildVoiceWebSocketServerOptions(config) as the base for the server, so
// this asserts the config→options mapping the live server consumes.
describe('buildVoiceWebSocketServerOptions — voice websocket limits wiring', () => {
  it('maps operator-set voice settings into server transport options', () => {
    const options = buildVoiceWebSocketServerOptions({
      voiceSessionTimeoutMs: 45_000,
      voiceMaxFrameBytes: 131_072,
      voiceMaxPendingFrames: 8,
    } as SubstrateConfig);

    expect(options.sessionTimeoutMs).toBe(45_000);
    expect(options.maxFrameBytes).toBe(131_072);
    expect(options.maxPendingFrames).toBe(8);
  });

  it('preserves the server compiled defaults exactly when unset', () => {
    const options = buildVoiceWebSocketServerOptions({} as SubstrateConfig);

    expect(options.sessionTimeoutMs).toBe(30_000);
    expect(options.maxFrameBytes).toBe(256 * 1024);
    expect(options.maxPendingFrames).toBe(32);
  });
});
