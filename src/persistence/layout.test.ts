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
  ensurePersistenceLayout,
  migrateLegacyPersistenceLayout,
  resolveContactsDir,
  resolveContinuityDir,
  resolveLegacyValuesJournalPath,
  resolveNotesDir,
  resolveReflectionJournalPath,
  resolveReflectionNotesDir,
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

  it('resolves canonical paths under a data directory', () => {
    const dataDir = join(tempDir, 'data');

    expect(resolveSessionsDir(dataDir)).toBe(join(dataDir, 'sessions'));
    expect(resolveNotesDir(dataDir)).toBe(join(dataDir, 'notes'));
    expect(resolveContactsDir(dataDir)).toBe(join(dataDir, 'contacts'));
    expect(resolveContinuityDir(dataDir)).toBe(join(dataDir, 'contacts', 'continuity'));
    expect(resolveValuesJournalPath(dataDir)).toBe(join(dataDir, 'notes', 'values.jsonl'));
    expect(resolveLegacyValuesJournalPath(dataDir)).toBe(join(dataDir, 'values.jsonl'));
    expect(resolveReflectionNotesDir(dataDir)).toBe(join(dataDir, 'notes', 'reflections'));
    expect(resolveReflectionJournalPath(dataDir)).toBe(join(dataDir, 'notes', 'reflections', 'journal.jsonl'));
    expect(resolveScratchpadMirrorPath(dataDir)).toBe(join(dataDir, 'notes', 'scratchpad.json'));
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
