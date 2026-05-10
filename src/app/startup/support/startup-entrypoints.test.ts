import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REEXEC_RESTART_EXIT_CODE,
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from '../../../system/lifecycle/runtime-mode.js';

describe('startup entrypoint wiring', () => {
  it('treats split startup contracts as launcher-reexec restarted processes', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SPLIT,
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.SPLIT,
      restart: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: DEFAULT_REEXEC_RESTART_EXIT_CODE,
      },
    });
    expect(toRuntimeStatusMetadata(contract)).toEqual({
      activeMode: 'split',
      restartStrategy: 'reexec',
      restartCommandSource: 'mode-default',
      restartExitCode: DEFAULT_REEXEC_RESTART_EXIT_CODE,
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
      entrypoint: 'single' as any,
    })).toThrow('Unsupported runtime entrypoint');
  });
});
