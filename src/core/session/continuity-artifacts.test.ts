import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionContinuityArtifactStore } from './continuity-artifacts.js';

describe('SessionContinuityArtifactStore', () => {
  let tempDir: string;
  let store: SessionContinuityArtifactStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-continuity-artifacts-'));
    store = new SessionContinuityArtifactStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists low-stress checkpoints and wake-return summaries per session', () => {
    const checkpoint = store.append({
      sessionId: 'api:continuity',
      kind: 'checkpoint',
      summary: 'We are midway through the cleanup refactor; the main thread is stable.',
      facets: ['task', 'life', 'task'],
      nextAnchor: 'Pick back up by checking the remaining runtime wiring tests.',
      createdAt: '2026-04-01T10:00:00.000Z',
    });
    const wakeReturn = store.append({
      sessionId: 'api:continuity',
      kind: 'wake_return',
      occasion: 'return',
      summary: 'We came back after a pause with the main task still intact and no relational tension to untangle.',
      facets: ['task', 'relational'],
      createdAt: '2026-04-01T11:00:00.000Z',
    });

    expect(checkpoint.facets).toEqual(['task', 'life']);
    expect(wakeReturn.occasion).toBe('return');

    const recent = store.listRecent('api:continuity');
    expect(recent).toHaveLength(2);
    expect(recent[0]?.kind).toBe('wake_return');
    expect(recent[0]?.occasion).toBe('return');
    expect(recent[1]?.kind).toBe('checkpoint');
    expect(recent[1]?.nextAnchor).toContain('runtime wiring tests');

    const persisted = readFileSync(join(tempDir, 'api%3Acontinuity.jsonl'), 'utf-8').trim().split('\n');
    expect(persisted).toHaveLength(2);
  });

  it('fails closed on invalid occasion usage', () => {
    expect(() => store.append({
      sessionId: 'api:continuity',
      kind: 'checkpoint',
      summary: 'Checkpoint should not accept wake metadata.',
      occasion: 'wake',
    })).toThrow('occasion is only allowed for wake_return artifacts');

    expect(() => store.append({
      sessionId: 'api:continuity',
      kind: 'wake_return',
      summary: 'Wake/return summaries need an explicit occasion.',
    })).toThrow('occasion must be a non-empty string');
  });

  it('filters by kind and skips malformed persisted lines', () => {
    store.append({
      sessionId: 'api:continuity',
      kind: 'checkpoint',
      summary: 'Stable checkpoint before break.',
      createdAt: '2026-04-01T09:00:00.000Z',
    });
    const path = join(tempDir, 'api%3Acontinuity.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{"bad":true}\n`, 'utf-8');
    store.append({
      sessionId: 'api:continuity',
      kind: 'wake_return',
      occasion: 'wake',
      summary: 'On wake, the emotional thread is calm and the practical next step is clear.',
      facets: ['life'],
      createdAt: '2026-04-01T12:00:00.000Z',
    });

    const checkpoints = store.listRecent('api:continuity', { kind: 'checkpoint' });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.kind).toBe('checkpoint');

    const wakeOnly = store.listRecent('api:continuity', { kind: 'wake_return', limit: 1 });
    expect(wakeOnly).toHaveLength(1);
    expect(wakeOnly[0]?.occasion).toBe('wake');
    expect(wakeOnly[0]?.facets).toEqual(['life']);
  });
});
