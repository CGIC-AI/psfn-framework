import { describe, it, expect } from 'vitest';
import {
  RUNTIME_MODE,
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
    expect(Object.keys(RUNTIME_MODE)).not.toContain('SINGLE');
    expect(normalizeRuntimeMode('single')).toBeNull();
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
      entrypoint: 'single' as any,
    })).toThrow('Unsupported runtime entrypoint');
  });

  it('maps split entrypoint to canonical split mode with default split restart command', () => {
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
        strategy: 'command',
        source: 'mode-default',
        command: 'npm run split',
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
      restartStrategy: 'command',
      restartCommandSource: 'mode-default',
      restartCommand: 'npm run split',
    });
  });
});
