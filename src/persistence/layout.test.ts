import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CONTINUOUS_RUNTIME_ROOT,
  DEFAULT_PRODUCTION_RUNTIME_ROOT,
  RUNTIME_LAYOUT_MODE,
  ensurePersistenceLayout,
  migrateLegacyPersistenceLayout,
  normalizeRuntimeLayoutMode,
  resolveBackupsDir,
  resolveCharacterCardHistoryPath,
  resolveCoreMemoryPath,
  resolveConfiguredCompanionDataDir,
  resolveConfiguredSystemDataDir,
  resolveContactsDir,
  resolveContinuityDir,
  resolveGeneratedImagesDir,
  resolveHeartbeatPolicyPath,
  resolveIdentityAssetsDir,
  resolveInternalRoleEnvelopeLedgerPath,
  resolveInternalRoleEnvelopesDir,
  resolveLegacyValuesJournalPath,
  resolveLastActiveSessionPath,
  resolveNotesDir,
  resolvePersistenceRoots,
  resolvePromptHistoryPath,
  resolvePromptLayersPath,
  resolvePostTurnActionQueuePath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
  resolveReflectionJournalPath,
  resolveReflectionNotesDir,
  resolveRuntimeLayoutMode,
  resolveRuntimePathLayout,
  resolveSafeguardAuditTrailPath,
  resolveShardSessionMemorySyncAuditPath,
  resolveScratchpadMirrorPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from './layout.js';

function writeJournalEntry(filePath: string, channelId: string): void {
  writeFileSync(
    filePath,
    `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId,
      timestamp: 1_706_000_000_000,
      role: 'assistant',
      content: 'test',
    })}\n`,
    'utf-8',
  );
}

describe('persistence layout', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-layout-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves canonical companion-state paths under a companion data directory', () => {
    const dataDir = join(tempDir, 'companion');

    expect(resolveSessionsDir(dataDir)).toBe(join(dataDir, 'sessions'));
    expect(resolveNotesDir(dataDir)).toBe(join(dataDir, 'notes'));
    expect(resolveContactsDir(dataDir)).toBe(join(dataDir, 'contacts'));
    expect(resolveContinuityDir(dataDir)).toBe(join(dataDir, 'contacts', 'continuity'));
    expect(resolveValuesJournalPath(dataDir)).toBe(join(dataDir, 'notes', 'values.jsonl'));
    expect(resolveLegacyValuesJournalPath(dataDir)).toBe(join(dataDir, 'values.jsonl'));
    expect(resolveReflectionNotesDir(dataDir)).toBe(join(dataDir, 'notes', 'reflections'));
    expect(resolveReflectionJournalPath(dataDir)).toBe(join(dataDir, 'notes', 'reflections', 'journal.jsonl'));
    expect(resolveScratchpadMirrorPath(dataDir)).toBe(join(dataDir, 'notes', 'scratchpad.json'));
    expect(resolveCoreMemoryPath(dataDir)).toBe(join(dataDir, 'core_memory.json'));
    expect(resolveInternalRoleEnvelopesDir(dataDir)).toBe(join(dataDir, 'internal-role-envelopes'));
    expect(resolveInternalRoleEnvelopeLedgerPath(dataDir, 'discord:dm/primary')).toBe(
      join(dataDir, 'internal-role-envelopes', 'discord%3Adm%2Fprimary.jsonl'),
    );
    expect(resolveCharacterCardHistoryPath(dataDir)).toBe(join(dataDir, 'character-card-history.jsonl'));
    expect(resolvePromptLayersPath(dataDir)).toBe(join(dataDir, 'prompt-layers.json'));
    expect(resolvePromptHistoryPath(dataDir)).toBe(join(dataDir, 'prompt-history.jsonl'));
    expect(resolvePromptRegistryPath(dataDir)).toBe(join(dataDir, 'prompt-registry.json'));
    expect(resolvePromptRegistryHistoryPath(dataDir)).toBe(join(dataDir, 'prompt-registry-history.jsonl'));
    expect(resolveHeartbeatPolicyPath(dataDir)).toBe(join(dataDir, 'heartbeat-policy.json'));
    expect(resolvePostTurnActionQueuePath(dataDir)).toBe(join(dataDir, 'post-turn-actions.queue.json'));
    expect(resolveSafeguardAuditTrailPath(dataDir)).toBe(join(dataDir, 'safeguards-audit.jsonl'));
    expect(resolveShardSessionMemorySyncAuditPath(dataDir)).toBe(
      join(dataDir, 'shard-session-memory-sync-audit.jsonl'),
    );
    expect(resolveIdentityAssetsDir(dataDir)).toBe(join(dataDir, 'identity-assets'));
    expect(resolveGeneratedImagesDir(dataDir)).toBe(join(dataDir, 'images'));
    expect(resolveBackupsDir(dataDir)).toBe(join(dataDir, 'backups'));
    expect(resolveLastActiveSessionPath(dataDir)).toBe(join(dataDir, 'last_active_channel.json'));
  });

  it('uses the legacy shared data root when split roots are not configured', () => {
    expect(resolvePersistenceRoots()).toEqual({
      systemDataDir: './data',
      companionDataDir: './data',
      usesLegacySharedDataDir: true,
    });
    expect(resolvePersistenceRoots({ legacyDataDir: '/tmp/shared-root' })).toEqual({
      systemDataDir: '/tmp/shared-root',
      companionDataDir: '/tmp/shared-root',
      usesLegacySharedDataDir: true,
    });
  });

  it('resolves explicit system/companion split roots', () => {
    expect(resolvePersistenceRoots({
      systemDataDir: '/tmp/system-data',
      companionDataDir: '/tmp/companion-data',
    })).toEqual({
      systemDataDir: '/tmp/system-data',
      companionDataDir: '/tmp/companion-data',
      usesLegacySharedDataDir: false,
    });
  });

  it('rejects ambiguous or invalid split-root configuration', () => {
    expect(() => resolvePersistenceRoots({
      systemDataDir: '/tmp/system-data',
    })).toThrow('SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together');
    expect(() => resolvePersistenceRoots({
      companionDataDir: '/tmp/companion-data',
    })).toThrow('SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together');
    expect(() => resolvePersistenceRoots({
      systemDataDir: '/tmp/shared',
      companionDataDir: '/tmp/shared',
    })).toThrow('SYSTEM_DATA_DIR and COMPANION_DATA_DIR must point to different roots');
  });

  it('normalizes runtime layout mode aliases and defaults from NODE_ENV', () => {
    expect(normalizeRuntimeLayoutMode('prod')).toBe(RUNTIME_LAYOUT_MODE.PRODUCTION);
    expect(normalizeRuntimeLayoutMode('DEV')).toBe(RUNTIME_LAYOUT_MODE.CONTINUOUS);
    expect(resolveRuntimeLayoutMode({ nodeEnv: 'production' })).toBe(RUNTIME_LAYOUT_MODE.PRODUCTION);
    expect(resolveRuntimeLayoutMode({ nodeEnv: 'development' })).toBe(RUNTIME_LAYOUT_MODE.CONTINUOUS);
    expect(() => resolveRuntimeLayoutMode({ mode: 'staging' })).toThrow(
      'Unsupported PSFN_RUNTIME_LAYOUT_MODE "staging"',
    );
  });

  it('resolves continuous-mode defaults with shared data root compatibility', () => {
    expect(resolveRuntimePathLayout()).toEqual({
      mode: RUNTIME_LAYOUT_MODE.CONTINUOUS,
      runtimeRootDir: DEFAULT_CONTINUOUS_RUNTIME_ROOT,
      systemDataDir: './data',
      companionDataDir: './data',
      workspacePath: './workspace',
      logsDir: './logs',
      tempDir: './tmp',
      backupsDir: resolveBackupsDir('./data'),
      usesLegacySharedDataDir: true,
    });
  });

  it('resolves production-mode defaults with isolated roots', () => {
    expect(resolveRuntimePathLayout({
      mode: RUNTIME_LAYOUT_MODE.PRODUCTION,
    })).toEqual({
      mode: RUNTIME_LAYOUT_MODE.PRODUCTION,
      runtimeRootDir: DEFAULT_PRODUCTION_RUNTIME_ROOT,
      systemDataDir: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/system-data`,
      companionDataDir: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/companion-data`,
      workspacePath: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/workspace`,
      logsDir: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/logs`,
      tempDir: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/tmp`,
      backupsDir: `${DEFAULT_PRODUCTION_RUNTIME_ROOT}/backups`,
      usesLegacySharedDataDir: false,
    });
  });

  it('rejects production mode when DATA_DIR shared-root fallback would be used', () => {
    expect(() => resolveRuntimePathLayout({
      mode: RUNTIME_LAYOUT_MODE.PRODUCTION,
      legacyDataDir: '/srv/shared-data',
    })).toThrow('DATA_DIR shared-root mode is forbidden');
  });

  it('rejects duplicate and overlapping mutable roots in production mode', () => {
    expect(() => resolveRuntimePathLayout({
      mode: RUNTIME_LAYOUT_MODE.PRODUCTION,
      systemDataDir: '/srv/psfn/system-data',
      companionDataDir: '/srv/psfn/companion-data',
      workspacePath: '/srv/psfn/companion-data',
    })).toThrow('shares a mutable root');

    expect(() => resolveRuntimePathLayout({
      mode: RUNTIME_LAYOUT_MODE.PRODUCTION,
      systemDataDir: '/srv/psfn/system-data',
      companionDataDir: '/srv/psfn/companion-data',
      backupsDir: '/srv/psfn/companion-data/backups',
    })).toThrow('must not overlap');
  });

  it('derives continuous shared data defaults from explicit runtime root', () => {
    const layout = resolveRuntimePathLayout({
      mode: RUNTIME_LAYOUT_MODE.CONTINUOUS,
      runtimeRootDir: '/srv/psfn/continuous',
    });
    expect(layout.systemDataDir).toBe('/srv/psfn/continuous/data');
    expect(layout.companionDataDir).toBe('/srv/psfn/continuous/data');
    expect(layout.workspacePath).toBe('/srv/psfn/continuous/workspace');
    expect(layout.logsDir).toBe('/srv/psfn/continuous/logs');
    expect(layout.tempDir).toBe('/srv/psfn/continuous/tmp');
  });

  it('resolves configured system and companion dirs from config-style objects', () => {
    expect(resolveConfiguredSystemDataDir({
      dataDir: '/tmp/legacy',
    })).toBe('/tmp/legacy');
    expect(resolveConfiguredCompanionDataDir({
      dataDir: '/tmp/legacy',
    })).toBe('/tmp/legacy');
    expect(resolveConfiguredSystemDataDir({
      dataDir: '/tmp/legacy',
      systemDataDir: '/tmp/system',
      companionDataDir: '/tmp/companion',
    })).toBe('/tmp/system');
    expect(resolveConfiguredCompanionDataDir({
      dataDir: '/tmp/legacy',
      systemDataDir: '/tmp/system',
      companionDataDir: '/tmp/companion',
    })).toBe('/tmp/companion');
  });

  it('creates all expected persistence directories', () => {
    const dataDir = join(tempDir, 'data');

    ensurePersistenceLayout(dataDir);

    const dirs = [
      resolveSessionsDir(dataDir),
      resolveNotesDir(dataDir),
      resolveReflectionNotesDir(dataDir),
      resolveContactsDir(dataDir),
      resolveContinuityDir(dataDir),
      resolveInternalRoleEnvelopesDir(dataDir),
    ];
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  it('migrates legacy continuity files from sessions to contacts/continuity', () => {
    const dataDir = join(tempDir, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });

    const continuityContent = '{"id":"legacy"}\n';
    const continuitySource = join(sessionsDir, 'user_alpha.jsonl');
    writeFileSync(continuitySource, continuityContent, 'utf-8');

    const chatSource = join(sessionsDir, '20260302_general_010101.jsonl');
    writeJournalEntry(chatSource, 'discord:general');

    migrateLegacyPersistenceLayout(dataDir);

    const continuityTarget = join(resolveContinuityDir(dataDir), 'user_alpha.jsonl');
    expect(existsSync(continuitySource)).toBe(false);
    expect(existsSync(continuityTarget)).toBe(true);
    expect(readFileSync(continuityTarget, 'utf-8')).toBe(continuityContent);
    expect(existsSync(chatSource)).toBe(true);
  });

  it('keeps legacy continuity source when target file already exists', () => {
    const dataDir = join(tempDir, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    const continuityDir = resolveContinuityDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(continuityDir, { recursive: true });

    const sourcePath = join(sessionsDir, 'user_beta.jsonl');
    const targetPath = join(continuityDir, 'user_beta.jsonl');
    writeFileSync(sourcePath, 'source\n', 'utf-8');
    writeFileSync(targetPath, 'target\n', 'utf-8');

    migrateLegacyPersistenceLayout(dataDir);

    expect(existsSync(sourcePath)).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe('source\n');
    expect(readFileSync(targetPath, 'utf-8')).toBe('target\n');
  });

  it('moves reflection sessions into notes/reflections and prunes channel index entries', () => {
    const dataDir = join(tempDir, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });

    const reflectionFile = '20260302_reflection_010102.jsonl';
    const regularFile = '20260302_general_010103.jsonl';
    writeJournalEntry(join(sessionsDir, reflectionFile), 'internal:reflection:daily');
    writeJournalEntry(join(sessionsDir, regularFile), 'discord:general');
    writeFileSync(join(sessionsDir, '_channel_index.json'), JSON.stringify({
      version: 1,
      channels: {
        'internal:reflection:daily': { filename: reflectionFile },
        'discord:general': { filename: regularFile },
      },
    }), 'utf-8');

    migrateLegacyPersistenceLayout(dataDir);

    const reflectionTarget = join(resolveReflectionNotesDir(dataDir), reflectionFile);
    expect(existsSync(join(sessionsDir, reflectionFile))).toBe(false);
    expect(existsSync(reflectionTarget)).toBe(true);
    expect(existsSync(join(sessionsDir, regularFile))).toBe(true);

    const indexPayload = JSON.parse(readFileSync(join(sessionsDir, '_channel_index.json'), 'utf-8')) as {
      channels: Record<string, unknown>;
    };
    expect(indexPayload.channels['internal:reflection:daily']).toBeUndefined();
    expect(indexPayload.channels['discord:general']).toBeDefined();
  });

  it('adds a timestamp suffix when reflection destination filename already exists', () => {
    const dataDir = join(tempDir, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    const reflectionsDir = resolveReflectionNotesDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(reflectionsDir, { recursive: true });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(424242);
    const filename = '20260302_reflection_010104.jsonl';
    const sourcePath = join(sessionsDir, filename);
    const existingTargetPath = join(reflectionsDir, filename);
    const uniqueTargetPath = join(reflectionsDir, '20260302_reflection_010104-424242.jsonl');

    writeJournalEntry(sourcePath, 'internal:reflection:collision');
    writeFileSync(existingTargetPath, 'existing\n', 'utf-8');

    migrateLegacyPersistenceLayout(dataDir);

    expect(nowSpy).toBeDefined();
    expect(existsSync(sourcePath)).toBe(false);
    expect(readFileSync(existingTargetPath, 'utf-8')).toBe('existing\n');
    expect(existsSync(uniqueTargetPath)).toBe(true);
  });
});
