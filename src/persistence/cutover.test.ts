import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPersistenceCutoverReady,
  buildPersistenceCutoverPlan,
  executePersistenceCutover,
} from './cutover.js';
import {
  resolveContinuityDir,
  resolveNorthStarPath,
  resolveReflectionNotesDir,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from './layout.js';
import { buildMessageJournalEntry } from './journals/journal/entries.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function writeText(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, value, 'utf-8');
}

describe('persistence cutover', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (!root) continue;
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createRoots() {
    const root = mkdtempSync(join(tmpdir(), 'psfn-cutover-'));
    tempRoots.push(root);
    return {
      root,
      legacySharedDataDir: join(root, 'data'),
      legacyCompanionDir: join(root, 'companion'),
      systemDataDir: join(root, 'system-data'),
      companionDataDir: join(root, 'companion-data'),
    };
  }

  it('plans pending migrations for legacy shared-root artifacts when split roots are configured', () => {
    const dirs = createRoots();
    writeJson(join(dirs.legacySharedDataDir, 'settings.json'), { sessionMessageLimit: 44 });
    writeJson(join(dirs.legacySharedDataDir, 'character.json'), {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Companion' },
    });
    writeText(join(dirs.legacySharedDataDir, 'companion.db'), 'sqlite');
    writeText(join(dirs.legacySharedDataDir, 'sessions', 'session-1.jsonl'), '{"id":1}\n');

    const plan = buildPersistenceCutoverPlan(dirs);
    expect(plan.pendingMigrationCount).toBeGreaterThanOrEqual(4);
    expect(plan.entries.find(entry => entry.id === 'system.settings_json')?.status).toBe('pending_migration');
    expect(plan.entries.find(entry => entry.id === 'companion.character_card')?.status).toBe('pending_migration');
    expect(plan.entries.find(entry => entry.id === 'companion.database')?.status).toBe('pending_migration');
    expect(plan.entries.find(entry => entry.id === 'companion.sessions')?.status).toBe('pending_migration');
    expect(() => assertPersistenceCutoverReady(dirs)).toThrow('Run "npm run migrate:persistence-layout');
  });

  it('supports dry-run without mutating legacy or target roots', () => {
    const dirs = createRoots();
    writeJson(join(dirs.legacySharedDataDir, 'settings.json'), { sessionMessageLimit: 12 });
    writeText(join(dirs.legacySharedDataDir, 'companion.db'), 'sqlite');

    const result = executePersistenceCutover(dirs, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.plan.pendingMigrationCount).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(dirs.systemDataDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dirs.companionDataDir, 'companion.db'))).toBe(false);
    expect(existsSync(join(dirs.legacySharedDataDir, 'settings.json'))).toBe(true);
    expect(result.manifestPath).toBeUndefined();
  });

  it('migrates legacy artifacts, writes a manifest, and becomes idempotent', () => {
    const dirs = createRoots();
    writeJson(join(dirs.legacySharedDataDir, 'settings.json'), { sessionMessageLimit: 55 });
    writeJson(join(dirs.legacySharedDataDir, 'character.json'), {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Companion' },
    });
    writeText(join(dirs.legacySharedDataDir, 'values.jsonl'), '{"version":1}\n');
    writeJson(join(dirs.legacySharedDataDir, 'north-star.json'), [{
      id: 'north-star-1',
      title: 'Shared care',
      content: 'Protect the human and relationship.',
      scope: 'shared',
      enabled: true,
      priority: 0,
      updatedAt: '2026-03-25T00:00:00.000Z',
      updatedBy: 'admin',
      checksum: 'f8916cd4f51aab11',
      version: 1,
    }]);
    writeText(join(dirs.legacySharedDataDir, 'companion.db'), 'sqlite-main');
    writeText(join(dirs.legacySharedDataDir, 'companion.db-wal'), 'sqlite-wal');
    writeText(join(dirs.legacySharedDataDir, 'gateway-audit.db'), 'audit-main');
    writeText(join(dirs.legacySharedDataDir, 'sessions', 'session-1.jsonl'), '{"id":1}\n');

    const result = executePersistenceCutover(dirs);
    expect(result.dryRun).toBe(false);
    expect(result.manifestPath).toBeDefined();
    expect(result.backupRootDir).toBeDefined();
    expect(existsSync(join(dirs.systemDataDir, 'settings.json'))).toBe(true);
    expect(existsSync(join(dirs.systemDataDir, 'gateway-audit.db'))).toBe(true);
    expect(existsSync(join(dirs.companionDataDir, 'character.json'))).toBe(true);
    expect(existsSync(resolveValuesJournalPath(dirs.companionDataDir))).toBe(true);
    expect(existsSync(resolveNorthStarPath(dirs.companionDataDir))).toBe(true);
    expect(existsSync(join(dirs.companionDataDir, 'companion.db'))).toBe(true);
    expect(existsSync(join(dirs.companionDataDir, 'companion.db-wal'))).toBe(true);
    expect(existsSync(join(resolveSessionsDir(dirs.companionDataDir), 'session-1.jsonl'))).toBe(true);
    expect(existsSync(join(dirs.legacySharedDataDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(dirs.legacySharedDataDir, 'character.json'))).toBe(false);
    expect(existsSync(join(dirs.legacySharedDataDir, 'sessions'))).toBe(false);

    const manifest = JSON.parse(readFileSync(result.manifestPath!, 'utf-8')) as {
      status: string;
      entries: Array<{ id: string; status: string; backupPath?: string }>;
    };
    expect(manifest.status).toBe('completed');
    expect(manifest.entries.find(entry => entry.id === 'system.settings_json')?.status).toBe('completed_migration');
    expect(manifest.entries.find(entry => entry.id === 'system.gateway_audit_db')?.status).toBe('completed_migration');
    expect(manifest.entries.find(entry => entry.id === 'companion.database')?.status).toBe('completed_migration');
    expect(existsSync(join(result.backupRootDir!, 'system', 'settings.json'))).toBe(true);
    expect(existsSync(join(result.backupRootDir!, 'system', 'gateway-audit.db'))).toBe(true);
    expect(existsSync(join(result.backupRootDir!, 'companion', 'character.json'))).toBe(true);
    expect(existsSync(join(result.backupRootDir!, 'companion', 'state', 'sessions', 'session-1.jsonl'))).toBe(true);

    const rerun = executePersistenceCutover(dirs, { dryRun: true });
    expect(rerun.plan.actionableCount).toBe(0);
    expect(() => assertPersistenceCutoverReady(dirs)).not.toThrow();
  });

  it('runs legacy intra-root cleanup after moving companion state', () => {
    const dirs = createRoots();
    writeText(join(dirs.legacySharedDataDir, 'sessions', 'user_alice.jsonl'), '{"channelId":"discord:dm:alice"}\n');
    writeText(
      join(dirs.legacySharedDataDir, 'sessions', 'reflection.jsonl'),
      `${JSON.stringify(buildMessageJournalEntry(1, {
        channelId: 'internal:reflection:daily',
        role: 'assistant',
        content: 'hello',
        timestamp: 1_700_000_000_000,
      }))}\n`,
    );

    executePersistenceCutover(dirs);

    expect(existsSync(join(resolveContinuityDir(dirs.companionDataDir), 'user_alice.jsonl'))).toBe(true);
    expect(existsSync(join(resolveReflectionNotesDir(dirs.companionDataDir), 'reflection.jsonl'))).toBe(true);
    expect(existsSync(join(dirs.companionDataDir, 'sessions', 'user_alice.jsonl'))).toBe(false);
    expect(existsSync(join(dirs.companionDataDir, 'sessions', 'reflection.jsonl'))).toBe(false);
  });

  it('fails closed on duplicate or conflicting split-root state', () => {
    const dirs = createRoots();
    writeJson(join(dirs.legacySharedDataDir, 'character.json'), {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Companion' },
    });
    writeJson(join(dirs.companionDataDir, 'character.json'), {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Someone Else' },
    });

    const plan = buildPersistenceCutoverPlan(dirs);
    expect(plan.entries.find(entry => entry.id === 'companion.character_card')?.status).toBe('conflict');
    expect(() => executePersistenceCutover(dirs)).toThrow('Refusing to apply persistence cutover with conflicts');
  });

  it('rejects split-root configs that still point owned paths outside canonical roots', () => {
    const dirs = createRoots();
    expect(() => assertPersistenceCutoverReady({
      ...dirs,
      characterCardPath: join(dirs.legacyCompanionDir, 'character.json'),
    })).toThrow(`must stay inside ${dirs.companionDataDir}`);
    expect(() => assertPersistenceCutoverReady({
      ...dirs,
      databasePath: join(dirs.legacySharedDataDir, 'companion.db'),
    })).toThrow(`must stay inside ${dirs.companionDataDir}`);
    expect(() => assertPersistenceCutoverReady({
      ...dirs,
      auditDbPath: join(dirs.legacySharedDataDir, 'gateway-audit.db'),
    })).toThrow(`must stay inside ${dirs.systemDataDir}`);
  });
});
