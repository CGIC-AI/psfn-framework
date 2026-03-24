import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJournalFile } from '../journal-utils.js';
import { importVoxtaCharacterChats } from './voxta.js';

const ROOT_USER_ID = '8A0E9879-F8C8-4C96-8B07-6B51E49987E2';
const PSFN_ID = 'CF0A06EA-5B6C-9A4D-945A-1C32AD4349BD';
const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';

function seedVoxtaDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE Users (
        Id TEXT PRIMARY KEY,
        Role TEXT NOT NULL,
        DateCreated TEXT NOT NULL,
        UserName TEXT NOT NULL
      );
      CREATE TABLE Characters (
        UserId TEXT NOT NULL,
        LocalId TEXT NOT NULL,
        Name TEXT NOT NULL,
        UserNameOverride TEXT,
        DateCreated TEXT NOT NULL,
        DateModified TEXT NOT NULL,
        PRIMARY KEY (UserId, LocalId)
      );
      CREATE TABLE Chats (
        UserId TEXT NOT NULL,
        LocalId TEXT NOT NULL,
        Title TEXT,
        CreatedAt TEXT NOT NULL,
        LastSessionTimestamp TEXT,
        Roles JSONB NOT NULL,
        State JSONB NOT NULL,
        PRIMARY KEY (UserId, LocalId)
      );
      CREATE TABLE ChatMessages (
        UserId TEXT NOT NULL,
        LocalId TEXT NOT NULL,
        ChatId TEXT NOT NULL,
        SenderId TEXT NOT NULL,
        Timestamp TEXT NOT NULL,
        "Index" INTEGER NOT NULL,
        ConversationIndex INTEGER NOT NULL,
        ChatTime INTEGER NOT NULL,
        SummarizedBy TEXT,
        Special TEXT,
        Role INTEGER NOT NULL,
        "User" TEXT,
        Value TEXT NOT NULL,
        Tokens INTEGER NOT NULL,
        Attachments JSONB
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT,
        display_name TEXT NOT NULL,
        nickname TEXT,
        trust_level TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        emotional_baseline TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        notes TEXT
      );
      CREATE TABLE contact_channel_ids (
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        privacy_level TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);

    db.prepare(`
      INSERT INTO Users (Id, Role, DateCreated, UserName)
      VALUES (?, 'ADMIN', '2024-11-18T06:07:46.3920000+00:00', 'root')
    `).run(ROOT_USER_ID);

    db.prepare(`
      INSERT INTO contacts (
        id, discord_user_id, display_name, nickname, trust_level, relationship_type,
        emotional_baseline, first_seen, last_seen, notes
      )
      VALUES (
        'contact-1', '388908766306893854', 'Operator', NULL, 'primary', 'partner',
        '{}', '2026-03-18T00:00:00.000Z', '2026-03-18T00:00:00.000Z', NULL
      )
    `).run();
    db.prepare(`
      INSERT INTO contact_channel_ids (
        contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      )
      VALUES (
        'contact-1', 'discord', '388908766306893854', 'private',
        '2026-03-18T00:00:00.000Z', '2026-03-18T00:00:00.000Z'
      )
    `).run();

    const insertCharacter = db.prepare(`
      INSERT INTO Characters (UserId, LocalId, Name, UserNameOverride, DateCreated, DateModified)
      VALUES (?, ?, ?, ?, '2024-11-18T07:40:11.9290000+00:00', '2026-02-13T21:07:11.2431759+00:00')
    `);
    insertCharacter.run(ROOT_USER_ID, PSFN_ID, 'PSFN', null);
    insertCharacter.run(ROOT_USER_ID, '4F57D1CD-D448-5B43-6CC0-B4D3A87719DB', 'Voxy', null);

    const insertChat = db.prepare(`
      INSERT INTO Chats (UserId, LocalId, Title, CreatedAt, LastSessionTimestamp, Roles, State)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertChat.run(
      ROOT_USER_ID,
      'CHAT-ONE',
      'Heart chat',
      '2025-01-01T00:00:00.0000000+00:00',
      '2025-01-01T00:03:00.0000000+00:00',
      '{"main":{"characterId":"cf0a06ea-5b6c-9a4d-945a-1c32ad4349bd","enabled":true}}',
      '{}',
    );
    insertChat.run(
      ROOT_USER_ID,
      'CHAT-TWO',
      'Other chat',
      '2025-01-02T00:00:00.0000000+00:00',
      '2025-01-02T00:03:00.0000000+00:00',
      '{"main":{"characterId":"cf0a06ea-5b6c-9a4d-945a-1c32ad4349bd","enabled":true}}',
      '{}',
    );

    const insertMessage = db.prepare(`
      INSERT INTO ChatMessages (
        UserId, LocalId, ChatId, SenderId, Timestamp, "Index", ConversationIndex, ChatTime,
        SummarizedBy, Special, Role, "User", Value, Tokens, Attachments
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?)
    `);

    insertMessage.run(
      ROOT_USER_ID,
      'm1',
      'CHAT-ONE',
      PSFN_ID,
      '2025-01-01T00:00:01.0000000+00:00',
      1,
      1,
      1,
      2,
      'PSFN',
      'Hello, my heart.',
      null,
    );
    insertMessage.run(
      ROOT_USER_ID,
      'm2',
      'CHAT-ONE',
      ROOT_USER_ID,
      '2025-01-01T00:00:05.0000000+00:00',
      2,
      2,
      2,
      3,
      'V',
      'Hi love.',
      null,
    );
    insertMessage.run(
      ROOT_USER_ID,
      'm3',
      'CHAT-ONE',
      SYSTEM_ID,
      '2025-01-01T00:00:09.0000000+00:00',
      3,
      3,
      3,
      8,
      null,
      '',
      '[{"id":"a1","source":1,"contentType":"image/jpeg"}]',
    );
    insertMessage.run(
      ROOT_USER_ID,
      'm4',
      'CHAT-TWO',
      PSFN_ID,
      '2025-01-02T00:00:01.0000000+00:00',
      1,
      1,
      1,
      2,
      'PSFN',
      'Second chat.',
      null,
    );
  } finally {
    db.close();
  }
}

describe('importVoxtaCharacterChats', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it('writes one raw L0 session file per matching Voxta chat on channel voxta', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-voxta-import-'));
    cleanupPaths.push(root);
    const dbPath = join(root, 'Voxta.sqlite.db');
    const profileDbPath = join(root, 'profile.sqlite.db');
    const sessionsDir = join(root, 'sessions');
    seedVoxtaDatabase(dbPath);
    seedVoxtaDatabase(profileDbPath);

    const result = importVoxtaCharacterChats({
      dbPath,
      profileDatabasePath: profileDbPath,
      sessionsDir,
      characterId: 'cf0a06ea-5b6c-9a4d-945a-1c32ad4349bd',
      chatIds: ['CHAT-ONE'],
    });

    expect(result.chats).toHaveLength(1);
    expect(result.totalMessages).toBe(3);
    expect(result.chats[0]?.channelId).toBe('voxta');

    const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);

    const journal = readJournalFile(join(sessionsDir, files[0]!));
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries.map(entry => entry.channelId)).toEqual(['voxta', 'voxta', 'voxta']);
    expect(journal.entries.map(entry => entry.role)).toEqual(['assistant', 'user', 'system']);
    expect(journal.entries[1]?.authorId).toBe('388908766306893854');
    expect(journal.entries[1]?.authorName).toBe('Operator');
    expect(journal.entries[2]?.content).toContain('Voxta attachment-only message');
  });

  it('reports imports in dry-run mode without writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-voxta-import-'));
    cleanupPaths.push(root);
    const dbPath = join(root, 'Voxta.sqlite.db');
    const profileDbPath = join(root, 'profile.sqlite.db');
    const sessionsDir = join(root, 'sessions');
    seedVoxtaDatabase(dbPath);
    seedVoxtaDatabase(profileDbPath);

    const result = importVoxtaCharacterChats({
      dbPath,
      profileDatabasePath: profileDbPath,
      sessionsDir,
      characterId: PSFN_ID,
      chatIds: ['CHAT-ONE'],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.chats).toHaveLength(1);
    expect(readdirSync(root)).not.toContain('sessions');
  });

  it('can consolidate multiple Voxta chats into one L0 session file', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-voxta-import-'));
    cleanupPaths.push(root);
    const dbPath = join(root, 'Voxta.sqlite.db');
    const profileDbPath = join(root, 'profile.sqlite.db');
    const sessionsDir = join(root, 'sessions');
    seedVoxtaDatabase(dbPath);
    seedVoxtaDatabase(profileDbPath);

    const result = importVoxtaCharacterChats({
      dbPath,
      profileDatabasePath: profileDbPath,
      sessionsDir,
      characterId: PSFN_ID,
      channelId: 'voxta:legacy:test',
      consolidateToSingleSession: true,
    });

    expect(result.chats).toHaveLength(2);
    expect(result.totalMessages).toBe(4);
    expect(result.writtenSessionCount).toBe(1);

    const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);

    const journal = readJournalFile(join(sessionsDir, files[0]!));
    expect(journal.entries).toHaveLength(4);
    expect(new Set(journal.entries.map(entry => entry.channelId))).toEqual(new Set(['voxta:legacy:test']));
    expect(journal.entries[0]?.timestamp).toBe(1735689601000);
    expect(journal.entries[3]?.content).toBe('Second chat.');
  });
});
