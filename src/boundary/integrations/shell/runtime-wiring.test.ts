import { describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayShellOps } from './gateway-ops.js';
import { registerShellTools, type ShellRuntimeTarget } from './runtime-wiring.js';

function createMockTarget(): ShellRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('shell runtime wiring', () => {
  it('registers shell as a core tool', () => {
    const target = createMockTarget();
    const ops = {
      exec: vi.fn(),
    };

    registerShellTools(target, ops);

    expect(target.registerTool.mock.calls.map((call: any[]) => call[0].name)).toEqual(['shell']);
    expect(target.registerTool.mock.calls.every((call: any[]) => call[1] === 'core')).toBe(true);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    const target = createMockTarget();
    const gateway = {
      shellExec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: '/workspace',
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 3,
      })),
    } as unknown as GatewayClient;

    registerShellTools(target, new GatewayShellOps(gateway), { gatewayMode: true });

    expect(target.registerTool.mock.calls[0][0].wiringMeta?.requiredGatewayMethods).toEqual(['shell.exec']);
  });
});
