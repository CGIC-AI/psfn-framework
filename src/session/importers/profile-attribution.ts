import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ImportedProfileAttribution {
  authorId: string;
  authorName: string;
  contactId?: string;
}

export interface ResolveProfileAttributionOptions {
  databasePath?: string;
  authorId?: string;
  authorName?: string;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolvePrimaryPartnerDiscordProfile(
  options: ResolveProfileAttributionOptions = {},
): ImportedProfileAttribution {
  const overrideAuthorId = normalizeOptionalString(options.authorId);
  const overrideAuthorName = normalizeOptionalString(options.authorName);

  if (overrideAuthorId && overrideAuthorName) {
    return {
      authorId: overrideAuthorId,
      authorName: overrideAuthorName,
    };
  }

  const databasePath = resolve(options.databasePath ?? './data/psfn.db');
  if (!existsSync(databasePath)) {
    throw new Error(`Profile attribution database not found: ${databasePath}`);
  }

  const db = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const rows = db.prepare(`
      SELECT
        c.id AS contactId,
        c.display_name AS displayName,
        c.discord_user_id AS discordUserId,
        cci.channel_user_id AS channelUserId
      FROM contacts c
      LEFT JOIN contact_channel_ids cci
        ON cci.contact_id = c.id
       AND cci.channel = 'discord'
      WHERE c.trust_level = 'primary'
        AND c.relationship_type = 'partner'
      ORDER BY c.last_seen DESC, c.first_seen DESC
    `).all() as Array<{
      contactId: string;
      displayName: string;
      discordUserId: string | null;
      channelUserId: string | null;
    }>;

    if (rows.length === 0) {
      throw new Error('No primary partner Discord profile found for import attribution');
    }
    if (rows.length > 1) {
      throw new Error('Multiple primary partner profiles found; pass --profile-id and --profile-name explicitly');
    }

    const row = rows[0]!;
    const authorId = overrideAuthorId
      ?? normalizeOptionalString(row.channelUserId)
      ?? normalizeOptionalString(row.discordUserId);
    const authorName = overrideAuthorName ?? normalizeOptionalString(row.displayName);

    if (!authorId || !authorName) {
      throw new Error('Primary partner profile is missing Discord attribution fields');
    }

    return {
      authorId,
      authorName,
      contactId: row.contactId,
    };
  } finally {
    db.close();
  }
}
