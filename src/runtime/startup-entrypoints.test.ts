import { describe, expect, it } from 'vitest';
import {
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from '../lifecycle/runtime-mode.js';

describe('startup entrypoint wiring', () => {
  it('treats split startup contracts as command-restarted processes', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SPLIT,
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.SPLIT,
      restart: {
        strategy: 'command',
        source: 'mode-default',
        command: 'npm run split',
      },
    });
    expect(toRuntimeStatusMetadata(contract)).toEqual({
      activeMode: 'split',
      restartStrategy: 'command',
      restartCommandSource: 'mode-default',
      restartCommand: 'npm run split',
    });
  });

  it('treats gateway-agent startup contracts as supervisor-managed processes', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.GATEWAY_AGENT,
      restart: {
        strategy: 'supervisor',
        source: 'none',
      },
    });
    expect(toRuntimeStatusMetadata(contract)).toEqual({
      activeMode: 'gateway-agent',
      restartStrategy: 'supervisor',
      restartCommandSource: 'none',
      restartCommand: undefined,
    });
  });

  it('rejects disabled startup contracts', () => {
    expect(() => resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SINGLE,
    })).toThrow('Unsupported runtime entrypoint "single"');
  });
});
