import { describe, it, expect } from 'vitest';
import { resolveGatewayConnectFailureExitCode } from './gateway-connect-failure.js';
import { DEFAULT_REEXEC_RESTART_EXIT_CODE } from '../../system/lifecycle/runtime-mode.js';

describe('resolveGatewayConnectFailureExitCode', () => {
  it('exits through the reexec restart code for split reexec contracts', () => {
    expect(
      resolveGatewayConnectFailureExitCode({ strategy: 'reexec', source: 'mode-default', exitCode: 75 }),
    ).toBe(75);
    expect(DEFAULT_REEXEC_RESTART_EXIT_CODE).toBe(75);
  });

  it('honors a custom reexec exit code when the contract sets one', () => {
    expect(
      resolveGatewayConnectFailureExitCode({ strategy: 'reexec', source: 'explicit', exitCode: 42 }),
    ).toBe(42);
  });

  it('falls back to the default reexec code when a reexec contract omits an exit code', () => {
    expect(
      resolveGatewayConnectFailureExitCode({ strategy: 'reexec', source: 'mode-default' }),
    ).toBe(DEFAULT_REEXEC_RESTART_EXIT_CODE);
  });

  it('never returns the generic fatal exit(1); supervisor/command/unsupported all restart', () => {
    for (const strategy of ['supervisor', 'command', 'unsupported'] as const) {
      const code = resolveGatewayConnectFailureExitCode({ strategy, source: 'none' });
      expect(code).not.toBe(1);
      expect(code).toBe(DEFAULT_REEXEC_RESTART_EXIT_CODE);
    }
  });
});
