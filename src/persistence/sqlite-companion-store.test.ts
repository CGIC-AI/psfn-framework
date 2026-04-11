import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteCompanionStore } from './sqlite-companion-store.js';
import { resolveReflectionMetacognitionJournalPath } from './layout.js';

describe('createSqliteCompanionStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('opens the sqlite companion database and assembles the memory and reflection stores', async () => {
    const rootDir = makeTempDir('psfn-sqlite-companion-store-');
    const companionDataDir = join(rootDir, 'companion-data');
    const databasePath = join(companionDataDir, 'companion.db');

    const store = createSqliteCompanionStore({
      databasePath,
      companionDataDir,
      embeddingDims: 8,
    });

    expect(existsSync(databasePath)).toBe(true);
    await expect(store.memoryStore.countActiveMemories()).resolves.toBe(0);

    await store.reflectionStore.append({
      kind: 'reflection_run',
      templateId: 'musing',
      templateName: 'Musing',
      occurredAt: '2026-04-02T12:00:00.000Z',
      executionSource: 'manual',
      initiatorSurface: 'tool:heartbeat_run_template',
      initiatedBy: 'companion',
      reason: 'Manual reflection run via heartbeat_run_template',
      channelId: 'internal:reflection:musing',
      sendToDiscordEffective: false,
      mode: 'agent',
      prompt: 'Reflect briefly.',
      reflection: 'I noticed steady attention.',
      internalStateSnapshotRef: 'snapshot-1',
      metacognitiveFlags: [{ flag: 'steadiness', confidence: 0.64 }],
      reflectionJournalEntryId: 'reflection-1',
    });

    const metacognitionPath = resolveReflectionMetacognitionJournalPath(companionDataDir);
    expect(existsSync(metacognitionPath)).toBe(true);
    const raw = readFileSync(metacognitionPath, 'utf-8').trim();
    expect(raw).toContain('Manual reflection run via heartbeat_run_template');

    const row = store.db.prepare(`SELECT * FROM reflections LIMIT 1`).get() as {
      kind: string;
      template_id: string;
      execution_source: string;
      prompt: string;
      reflection: string;
    };
    expect(row.kind).toBe('reflection_run');
    expect(row.template_id).toBe('musing');
    expect(row.execution_source).toBe('manual');
    expect(row.prompt).toBe('Reflect briefly.');
    expect(row.reflection).toContain('steady attention');

    store.db.close();
  });
});
