import { describe, it, expect } from 'vitest';
import {
  RUNTIME_MODE,
  DEFAULT_REEXEC_RESTART_EXIT_CODE,
  normalizeRestartExitCode,
  normalizeRestartCommand,
  normalizeRuntimeMode,
  resolveRuntimeCommandInvocation,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from './runtime-mode.js';

describe('normalizeRuntimeMode', () => {
  it('normalizes supported aliases', () => {
    expect(normalizeRuntimeMode('SPLIT')).toBe(RUNTIME_MODE.SPLIT);
    expect(normalizeRuntimeMode('gateway')).toBe(RUNTIME_MODE.GATEWAY_AGENT);
    expect(normalizeRuntimeMode('gateway_agent')).toBe(RUNTIME_MODE.GATEWAY_AGENT);
    expect(normalizeRuntimeMode('yolo')).toBe(RUNTIME_MODE.SPLIT);
  });

  it('returns null for unknown values', () => {
    expect(Object.keys(RUNTIME_MODE)).not.toContain('MONOLITHIC');
    expect(normalizeRuntimeMode('monolithic')).toBeNull();
    expect(normalizeRuntimeMode('mystery')).toBeNull();
    expect(normalizeRuntimeMode(undefined)).toBeNull();
  });
});

describe('normalizeRestartCommand', () => {
  it('trims and rejects empty values', () => {
    expect(normalizeRestartCommand(' npm run split ')).toBe('npm run split');
    expect(normalizeRestartCommand('   ')).toBeUndefined();
    expect(normalizeRestartCommand(undefined)).toBeUndefined();
  });
});

describe('normalizeRestartExitCode', () => {
  it('accepts integer process exit codes', () => {
    expect(normalizeRestartExitCode('75')).toBe(75);
    expect(normalizeRestartExitCode(' 0 ')).toBe(0);
    expect(normalizeRestartExitCode(undefined)).toBeUndefined();
  });

  it('rejects invalid restart exit codes', () => {
    expect(() => normalizeRestartExitCode('restart')).toThrow('Invalid PSFN_LIFECYCLE_RESTART_EXIT_CODE');
    expect(() => normalizeRestartExitCode('300')).toThrow('Invalid PSFN_LIFECYCLE_RESTART_EXIT_CODE');
  });
});

describe('resolveRuntimeCommandInvocation', () => {
  it('splits command strings into command and args', () => {
    expect(resolveRuntimeCommandInvocation('npm run split')).toEqual({
      command: 'npm',
      args: ['run', 'split'],
    });
  });

  it('preserves quoted arguments', () => {
    expect(resolveRuntimeCommandInvocation('npm run "split mode"')).toEqual({
      command: 'npm',
      args: ['run', 'split mode'],
    });
  });

  it('rejects unmatched quotes', () => {
    expect(() => resolveRuntimeCommandInvocation('npm run "split')).toThrow('unmatched quote');
  });
});

describe('resolveRuntimeModeContract', () => {
  it('rejects disabled runtime entrypoints', () => {
    expect(() => resolveRuntimeModeContract({
      entrypoint: 'monolithic' as any,
    })).toThrow('Unsupported runtime entrypoint');
  });

  it('maps split entrypoint to canonical split mode with wrapper reexec restart', () => {
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
  });

  it('maps gateway-agent entrypoint to canonical gateway-agent mode by default', () => {
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
  });

  it('allows gateway-agent entrypoint to switch into split mode via env', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      runtimeModeEnv: 'split',
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.SPLIT,
      restart: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: DEFAULT_REEXEC_RESTART_EXIT_CODE,
      },
    });
  });

  it('allows the split wrapper restart exit code to be configured explicitly', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SPLIT,
      restartExitCodeEnv: '76',
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.SPLIT,
      restart: {
        strategy: 'reexec',
        source: 'mode-default',
        exitCode: 76,
      },
    });
  });

  it('treats yolo alias as split mode and preserves explicit restart command', () => {
    const contract = resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      runtimeModeEnv: 'yolo',
      restartCommandEnv: 'npm run yolo',
    });

    expect(contract).toEqual({
      mode: RUNTIME_MODE.SPLIT,
      restart: {
        strategy: 'command',
        source: 'explicit',
        command: 'npm run yolo',
      },
    });
  });

  it('rejects unsupported env mode for entrypoint contract', () => {
    expect(() => resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SPLIT,
      runtimeModeEnv: 'gateway-agent',
    })).toThrow('is not allowed for entrypoint');
  });

  it('rejects unknown runtime mode values instead of silently falling back', () => {
    expect(() => resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      runtimeModeEnv: 'mystery',
    })).toThrow('Unsupported PSFN_RUNTIME_MODE');
  });
});

describe('toRuntimeStatusMetadata', () => {
  it('includes active mode and restart strategy metadata', () => {
    const metadata = toRuntimeStatusMetadata(resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.SPLIT,
    }));

    expect(metadata).toEqual({
      activeMode: 'split',
      restartStrategy: 'reexec',
      restartCommandSource: 'mode-default',
      restartExitCode: DEFAULT_REEXEC_RESTART_EXIT_CODE,
    });
  });
});
