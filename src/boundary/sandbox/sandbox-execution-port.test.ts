import { describe, expect, it } from 'vitest';
import {
  normalizeSandboxDebugLogKey,
  withChildProcessSandboxExecutionPort,
} from './sandbox-execution-port.js';

describe('withChildProcessSandboxExecutionPort', () => {
  it('starts on supported Node versions while blocking network globals in the VM', async () => {
    const port = withChildProcessSandboxExecutionPort(null);
    const result = await port.executeCode({
      code: 'FINAL(JSON.stringify({ fetch: typeof fetch, WebSocket: typeof WebSocket }))',
      timeoutMs: 1_000,
      initialLocals: {},
      helperNames: [],
      hostHelpers: {},
    });

    expect(result.error).toBeNull();
    expect(result.finalAnswer).toBe('{"fetch":"undefined","WebSocket":"undefined"}');
  });
});

describe('normalizeSandboxDebugLogKey', () => {
  it('passes through well-formed keys unchanged', () => {
    expect(normalizeSandboxDebugLogKey('sandbox_helper:missing')).toBe('sandbox_helper:missing');
  });

  it('buckets non-string keys instead of forwarding them to the rate limiter', () => {
    const malformed: unknown[] = [undefined, null, 42, { nested: true }, ['a'], Symbol('key')];
    for (const value of malformed) {
      expect(normalizeSandboxDebugLogKey(value)).toBe('sandbox_debug_log:invalid-key');
    }
  });

  it('buckets empty and whitespace-only keys', () => {
    expect(normalizeSandboxDebugLogKey('')).toBe('sandbox_debug_log:invalid-key');
    expect(normalizeSandboxDebugLogKey('   ')).toBe('sandbox_debug_log:invalid-key');
  });

  it('truncates oversized keys to a fixed bound', () => {
    const oversized = 'k'.repeat(10_000);
    const normalized = normalizeSandboxDebugLogKey(oversized);
    expect(normalized).toHaveLength(128);
    expect(normalized).toBe(oversized.slice(0, 128));
  });

  it('keeps distinct oversized keys from growing the key space unboundedly', () => {
    const prefix = 'shared-prefix-'.repeat(20);
    const first = normalizeSandboxDebugLogKey(`${prefix}unique-suffix-1`);
    const second = normalizeSandboxDebugLogKey(`${prefix}unique-suffix-2`);
    expect(first).toBe(second);
  });
});
