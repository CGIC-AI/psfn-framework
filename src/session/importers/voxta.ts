import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { SessionEntryRole } from '../types.js';
import { writeL0SessionFile, type RawL0MessageInput } from './l0-file-writer.js';
import {
  resolvePrimaryPartnerDiscordProfile,
  type ImportedProfileAttribution,
} from './profile-attribution.js';

const SYSTEM_SENDER_ID = '00000000-0000-0000-0000-000000000000';

interface VoxtaChatRow {
  chatId: string;
  title: string | null;
  createdAt: string;
  lastSessionTimestamp: string | null;
}

interface VoxtaMessageRow {
  localId: string;
  chatId: string;
  senderId: string;
  timestamp: string;
  messageIndex: number;
  conversationIndex: number;
  chatTime: number;
  special: string | null;
  role: number;
  userName: string | null;
  value: string;
  attachments: string | null;
}

export interface VoxtaImportedChatSummary {
  chatId: string;
  channelId: string;
  filePath?: string;
  title?: string;
  messageCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface VoxtaImportResult {
  characterId: string;
  characterName: string;
  dbPath: string;
  sessionsDir: string;
  dryRun: boolean;
  chats: VoxtaImportedChatSummary[];
  totalMessages: number;
}

export interface ImportVoxtaCharacterChatsOptions {
  dbPath: string;
  sessionsDir: string;
  characterId: string;
  channelId?: string;
  defaultChannelVisibility?: string;
  chatIds?: string[];
  profileDatabasePath?: string;
  profileAuthorId?: string;
  profileAuthorName?: string;
  dryRun?: boolean;
}

function normalizeVoxtaId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Voxta IDs must not be empty');
  }
  return normalized.toUpperCase();
}

function parseVoxtaTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`Invalid Voxta timestamp: ${value}`);
  }
  return timestamp;
}

function mapVoxtaRole(role: number): SessionEntryRole {
  if (role === 2) return 'assistant';
  if (role === 3) return 'user';
  return 'system';
}

function summarizeAttachments(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const counts = new Map<string, number>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const contentType = typeof (entry as { contentType?: unknown }).contentType === 'string'
        ? (entry as { contentType: string }).contentType.trim()
        : 'attachment';
      const key = contentType || 'attachment';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) {
      return `${parsed.length} attachment${parsed.length === 1 ? '' : 's'}`;
    }
    return [...counts.entries()]
      .map(([contentType, count]) => `${count}x ${contentType}`)
      .join(', ');
  } catch {
    return 'attachment metadata present';
  }
}

function buildMessageContent(row: VoxtaMessageRow): string {
  const normalized = row.value.trim();
  if (normalized) return normalized;
  const attachmentSummary = summarizeAttachments(row.attachments);
  if (attachmentSummary) {
    return `[Voxta attachment-only message: ${attachmentSummary}]`;
  }
  return '[Voxta empty message; see metadata]';
}

function buildMetadata(
  row: VoxtaMessageRow,
  role: SessionEntryRole,
  originalAuthorId: string,
  originalAuthorName: string,
  profileMapped: boolean,
): string {
  return JSON.stringify({
    source: 'voxta',
    voxtaRole: row.role,
    mappedRole: role,
    voxtaMessageId: row.localId,
    voxtaChatId: row.chatId,
    voxtaIndex: row.messageIndex,
    voxtaConversationIndex: row.conversationIndex,
    voxtaChatTime: row.chatTime,
    voxtaSpecial: row.special ?? undefined,
    voxtaAttachments: row.attachments ?? undefined,
    originalAuthorId,
    originalAuthorName,
    importedProfileMapped: profileMapped,
  });
}

function loadSenderNames(db: BetterSqlite3.Database): Map<string, string> {
  const names = new Map<string, string>();

  const users = db.prepare(`
    SELECT Id AS id, UserName AS name
    FROM Users
  `).all() as Array<{ id: string; name: string }>;

  for (const row of users) {
    if (!row.id || !row.name) continue;
    names.set(normalizeVoxtaId(row.id), row.name.trim());
  }

  const characters = db.prepare(`
    SELECT LocalId AS id, COALESCE(NULLIF(TRIM(UserNameOverride), ''), Name) AS name
    FROM Characters
  `).all() as Array<{ id: string; name: string | null }>;

  for (const row of characters) {
    if (!row.id || !row.name) continue;
    const normalizedName = row.name.trim();
    if (!normalizedName) continue;
    names.set(normalizeVoxtaId(row.id), normalizedName);
  }

  names.set(SYSTEM_SENDER_ID, 'system');
  return names;
}

function loadVoxtaUserIds(db: BetterSqlite3.Database): Set<string> {
  const ids = new Set<string>();
  const rows = db.prepare(`
    SELECT Id AS id
    FROM Users
  `).all() as Array<{ id: string }>;

  for (const row of rows) {
    if (!row.id) continue;
    ids.add(normalizeVoxtaId(row.id));
  }
  return ids;
}

function resolveCharacterName(
  db: BetterSqlite3.Database,
  characterId: string,
): string {
  const row = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(UserNameOverride), ''), Name) AS name
    FROM Characters
    WHERE UPPER(LocalId) = ?
    LIMIT 1
  `).get(characterId) as { name: string | null } | undefined;

  const name = row?.name?.trim();
  if (!name) {
    throw new Error(`Voxta character not found: ${characterId}`);
  }
  return name;
}

function listTargetChats(
  db: BetterSqlite3.Database,
  characterId: string,
  requestedChatIds: ReadonlySet<string>,
): VoxtaChatRow[] {
  const rows = db.prepare(`
    SELECT DISTINCT
      c.LocalId AS chatId,
      c.Title AS title,
      c.CreatedAt AS createdAt,
      c.LastSessionTimestamp AS lastSessionTimestamp
    FROM Chats c
    WHERE EXISTS (
      SELECT 1
      FROM ChatMessages m
      WHERE m.ChatId = c.LocalId
        AND UPPER(m.SenderId) = ?
    )
       OR instr(UPPER(COALESCE(c.Roles, '')), ?) > 0
    ORDER BY datetime(COALESCE(c.LastSessionTimestamp, c.CreatedAt)), c.LocalId
  `).all(characterId, characterId) as VoxtaChatRow[];

  if (requestedChatIds.size === 0) {
    return rows;
  }

  return rows.filter(row => requestedChatIds.has(normalizeVoxtaId(row.chatId)));
}

function listChatMessages(
  db: BetterSqlite3.Database,
  chatId: string,
): VoxtaMessageRow[] {
  return db.prepare(`
    SELECT
      LocalId AS localId,
      ChatId AS chatId,
      SenderId AS senderId,
      Timestamp AS timestamp,
      "Index" AS messageIndex,
      ConversationIndex AS conversationIndex,
      ChatTime AS chatTime,
      Special AS special,
      Role AS role,
      "User" AS userName,
      Value AS value,
      Attachments AS attachments
    FROM ChatMessages
    WHERE ChatId = ?
    ORDER BY ConversationIndex, "Index", Timestamp, LocalId
  `).all(chatId) as VoxtaMessageRow[];
}

function mapVoxtaMessageToL0(
  row: VoxtaMessageRow,
  profile: ImportedProfileAttribution,
  senderNames: ReadonlyMap<string, string>,
  voxtaUserIds: ReadonlySet<string>,
  visibility: string,
): RawL0MessageInput {
  const role = mapVoxtaRole(row.role);
  const sourceSenderId = normalizeVoxtaId(row.senderId);
  const sourceAuthorName = row.userName?.trim()
    || senderNames.get(sourceSenderId)
    || (sourceSenderId === SYSTEM_SENDER_ID ? 'system' : sourceSenderId);
  const profileMapped = voxtaUserIds.has(sourceSenderId);
  const authorId = profileMapped ? profile.authorId : sourceSenderId;
  const authorName = profileMapped ? profile.authorName : sourceAuthorName;

  return {
    role,
    content: buildMessageContent(row),
    authorId,
    authorName,
    timestamp: parseVoxtaTimestamp(row.timestamp),
    metadata: buildMetadata(row, role, sourceSenderId, sourceAuthorName, profileMapped),
    originChannelId: `voxta:${row.chatId}`,
    channelVisibility: visibility,
  };
}

export function importVoxtaCharacterChats(
  options: ImportVoxtaCharacterChatsOptions,
): VoxtaImportResult {
  const dbPath = resolve(options.dbPath);
  if (!existsSync(dbPath)) {
    throw new Error(`Voxta database not found: ${dbPath}`);
  }

  const sessionsDir = resolve(options.sessionsDir);
  const characterId = normalizeVoxtaId(options.characterId);
  const channelId = options.channelId?.trim() || 'voxta';
  const defaultChannelVisibility = options.defaultChannelVisibility?.trim() || 'private';
  const requestedChatIds = new Set((options.chatIds ?? []).map(normalizeVoxtaId));
  const db = new BetterSqlite3(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const characterName = resolveCharacterName(db, characterId);
    const senderNames = loadSenderNames(db);
    const voxtaUserIds = loadVoxtaUserIds(db);
    const profile = resolvePrimaryPartnerDiscordProfile({
      databasePath: options.profileDatabasePath,
      authorId: options.profileAuthorId,
      authorName: options.profileAuthorName,
    });
    const chats = listTargetChats(db, characterId, requestedChatIds);
    if (requestedChatIds.size > 0 && chats.length !== requestedChatIds.size) {
      const locatedIds = new Set(chats.map(chat => normalizeVoxtaId(chat.chatId)));
      const missing = [...requestedChatIds].filter(chatId => !locatedIds.has(chatId));
      if (missing.length > 0) {
        throw new Error(`Requested Voxta chats not found for ${characterId}: ${missing.join(', ')}`);
      }
    }

    const summaries: VoxtaImportedChatSummary[] = [];

    for (const chat of chats) {
      const rows = listChatMessages(db, chat.chatId);
      const messages = rows.map(row => mapVoxtaMessageToL0(
        row,
        profile,
        senderNames,
        voxtaUserIds,
        defaultChannelVisibility,
      ));
      if (messages.length === 0) continue;

      const firstTimestamp = messages[0]!.timestamp;
      const lastTimestamp = messages[messages.length - 1]!.timestamp;
      const written = options.dryRun
        ? null
        : writeL0SessionFile({
          sessionsDir,
          channelId,
          seedTimestamp: firstTimestamp,
          seedAuthorId: profile.authorId,
          seedAuthorName: profile.authorName,
          messages,
        });

      summaries.push({
        chatId: chat.chatId,
        channelId,
        filePath: written?.filePath,
        title: chat.title?.trim() || undefined,
        messageCount: messages.length,
        firstTimestamp,
        lastTimestamp,
      });
    }

    return {
      characterId,
      characterName,
      dbPath,
      sessionsDir,
      dryRun: options.dryRun ?? false,
      chats: summaries,
      totalMessages: summaries.reduce((sum, chat) => sum + chat.messageCount, 0),
    };
  } finally {
    db.close();
  }
}

export function describeVoxtaImportSource(dbPath: string): string {
  return basename(resolve(dbPath));
}
