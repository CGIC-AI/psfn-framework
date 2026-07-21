import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKILL_USAGE_TELEMETRY_FILE_NAME, SkillUsageTelemetryStore } from './telemetry.js';

describe('SkillUsageTelemetryStore debounced persistence (psfn-framework-ol0b)', () => {
  let tmpDir: string;
  let filePath: string;
  let store: SkillUsageTelemetryStore | null;
  const fixedNow = () => new Date('2024-01-01T00:00:00.000Z');

  beforeEach(() => {
    tmpDir = join(tmpdir(), `skill-tel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    filePath = join(tmpDir, SKILL_USAGE_TELEMETRY_FILE_NAME);
    store = null;
  });

  afterEach(() => {
    store?.close();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves reads from memory and coalesces many records into one debounced flush', () => {
    vi.useFakeTimers();
    store = new SkillUsageTelemetryStore(tmpDir, { flushDelayMs: 1_000, now: fixedNow });

    store.record('skill-a', { outcome: 'success' });
    store.record('skill-a', { outcome: 'failure' });
    store.record('skill-b', { outcome: 'success' });

    // No read-rewrite-per-invocation: nothing is on disk yet.
    expect(existsSync(filePath)).toBe(false);
    // In-memory aggregate is immediately queryable.
    expect(store.get('skill-a')?.invocationCount).toBe(2);
    expect(store.get('skill-a')?.failureCount).toBe(1);
    expect(store.list().map(s => s.name)).toEqual(['skill-a', 'skill-b']);

    // The debounce window elapses -> a single flush writes the file.
    vi.advanceTimersByTime(1_000);
    expect(existsSync(filePath)).toBe(true);

    // Data survives the flush: a fresh store loads the same aggregate.
    const reloaded = new SkillUsageTelemetryStore(tmpDir, { now: fixedNow });
    expect(reloaded.get('skill-a')?.invocationCount).toBe(2);
    expect(reloaded.get('skill-a')?.failureCount).toBe(1);
    expect(reloaded.get('skill-b')?.invocationCount).toBe(1);
  });

  it('flush() persists immediately and preserves the on-disk format', () => {
    store = new SkillUsageTelemetryStore(tmpDir, { flushDelayMs: 100_000, now: fixedNow });
    store.record('skill-c', { outcome: 'success', durationMs: 5 });
    expect(existsSync(filePath)).toBe(false);

    store.flush();
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw) as { version: number; skills: Record<string, { invocationCount: number }> };
    expect(parsed.version).toBe(1);
    expect(parsed.skills['skill-c'].invocationCount).toBe(1);

    // Idempotent: a second flush with nothing dirty is a no-op.
    expect(() => store!.flush()).not.toThrow();
  });

  it('close() flushes the pending debounced tail so nothing is lost on shutdown', () => {
    store = new SkillUsageTelemetryStore(tmpDir, { flushDelayMs: 100_000, now: fixedNow });
    store.record('skill-d', { outcome: 'success' });
    store.close();

    const reloaded = new SkillUsageTelemetryStore(tmpDir, { now: fixedNow });
    expect(reloaded.get('skill-d')?.invocationCount).toBe(1);
  });
});
