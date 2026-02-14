import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Contact, RelationshipType } from './types.js';
import type { TrustLevel } from '../trust/types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ContactStore');

// ── Row shape from SQLite (snake_case) ──

interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: string;
  first_seen: string;
  last_seen: string;
  notes: string | null;
}

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    discordUserId: row.discord_user_id ?? undefined,
    displayName: row.display_name,
    trustLevel: row.trust_level as TrustLevel,
    relationshipType: row.relationship_type as RelationshipType,
    emotionalBaseline: row.emotional_baseline ? JSON.parse(row.emotional_baseline) as Record<string, number> : undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    notes: row.notes ?? undefined,
  };
}

export class ContactStore {
  private db: Database.Database;
  private primaryUserId?: string;

  constructor(db: Database.Database, primaryUserId?: string) {
    this.db = db;
    this.primaryUserId = primaryUserId;
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'regular',
        relationship_type TEXT NOT NULL DEFAULT 'stranger',
        emotional_baseline TEXT DEFAULT '{}',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);
      CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);
    `);
  }

  /** Insert or update a contact. If discordUserId exists, updates. Otherwise inserts. */
  upsert(partial: Partial<Contact> & { displayName: string }): Contact {
    const now = new Date().toISOString();

    // If discordUserId provided, check for existing
    if (partial.discordUserId) {
      const existing = this.getByDiscordUserId(partial.discordUserId);
      if (existing) {
        // Update existing contact
        const trustLevel = this.isPrimaryUser(partial.discordUserId)
          ? 'primary' as TrustLevel
          : (partial.trustLevel ?? existing.trustLevel);

        const stmt = this.db.prepare(`
          UPDATE contacts SET
            display_name = ?,
            trust_level = ?,
            relationship_type = ?,
            emotional_baseline = ?,
            last_seen = ?,
            notes = ?
          WHERE discord_user_id = ?
        `);
        stmt.run(
          partial.displayName,
          trustLevel,
          partial.relationshipType ?? existing.relationshipType,
          partial.emotionalBaseline ? JSON.stringify(partial.emotionalBaseline) : (existing.emotionalBaseline ? JSON.stringify(existing.emotionalBaseline) : '{}'),
          now,
          partial.notes ?? existing.notes ?? null,
          partial.discordUserId,
        );
        log.debug('Updated contact', { discordUserId: partial.discordUserId, displayName: partial.displayName });
        return this.getByDiscordUserId(partial.discordUserId)!;
      }
    }

    // Insert new contact
    const isPrimary = partial.discordUserId ? this.isPrimaryUser(partial.discordUserId) : false;
    const contact: Contact = {
      id: partial.id ?? uuidv4(),
      discordUserId: partial.discordUserId,
      displayName: partial.displayName,
      trustLevel: isPrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
      relationshipType: isPrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
      emotionalBaseline: partial.emotionalBaseline,
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      notes: partial.notes,
    };

    const stmt = this.db.prepare(`
      INSERT INTO contacts (id, discord_user_id, display_name, trust_level, relationship_type,
        emotional_baseline, first_seen, last_seen, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      contact.id,
      contact.discordUserId ?? null,
      contact.displayName,
      contact.trustLevel,
      contact.relationshipType,
      contact.emotionalBaseline ? JSON.stringify(contact.emotionalBaseline) : '{}',
      contact.firstSeen,
      contact.lastSeen,
      contact.notes ?? null,
    );

    log.debug('Created contact', { id: contact.id, displayName: contact.displayName });
    return contact;
  }

  /** Get a contact by its internal UUID. */
  getById(id: string): Contact | undefined {
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE id = ?');
    const row = stmt.get(id) as ContactRow | undefined;
    return row ? rowToContact(row) : undefined;
  }

  /** Get a contact by Discord user ID. */
  getByDiscordUserId(discordUserId: string): Contact | undefined {
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE discord_user_id = ?');
    const row = stmt.get(discordUserId) as ContactRow | undefined;
    return row ? rowToContact(row) : undefined;
  }

  /** Get all contacts at a given trust level. */
  getByTrustLevel(trustLevel: TrustLevel): Contact[] {
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE trust_level = ?');
    const rows = stmt.all(trustLevel) as ContactRow[];
    return rows.map(rowToContact);
  }

  /** Update a contact's trust level. Returns false if not found or if attempting to change primary user. */
  setTrustLevel(id: string, trustLevel: TrustLevel): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    // Cannot change primary user's trust level
    if (contact.discordUserId && this.isPrimaryUser(contact.discordUserId)) {
      log.warn('Attempted to change primary user trust level', { id });
      return false;
    }

    const stmt = this.db.prepare('UPDATE contacts SET trust_level = ? WHERE id = ?');
    stmt.run(trustLevel, id);
    log.debug('Updated trust level', { id, trustLevel });
    return true;
  }

  /** Update a contact's last_seen timestamp to now. */
  updateLastSeen(id: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE contacts SET last_seen = ? WHERE id = ?');
    stmt.run(now, id);
  }

  /** Update a contact's notes. Returns false if not found. */
  updateNotes(id: string, notes: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    const stmt = this.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?');
    stmt.run(notes, id);
    return true;
  }

  /** List all contacts. */
  listAll(): Contact[] {
    const stmt = this.db.prepare('SELECT * FROM contacts ORDER BY last_seen DESC');
    const rows = stmt.all() as ContactRow[];
    return rows.map(rowToContact);
  }

  /**
   * Resolve a Discord user ID to a Contact.
   * Creates a new contact with defaults if not found.
   * Primary user gets 'primary' trust and 'partner' relationship.
   * Always updates lastSeen.
   */
  resolveUserId(discordUserId: string): Contact {
    const existing = this.getByDiscordUserId(discordUserId);
    if (existing) {
      this.updateLastSeen(existing.id);
      // Re-fetch to get updated lastSeen
      return this.getByDiscordUserId(discordUserId)!;
    }

    // Create new contact with defaults
    const isPrimary = this.isPrimaryUser(discordUserId);
    return this.upsert({
      discordUserId,
      displayName: discordUserId,  // Use ID as placeholder name
      trustLevel: isPrimary ? 'primary' : 'regular',
      relationshipType: isPrimary ? 'partner' : 'stranger',
    });
  }

  private isPrimaryUser(discordUserId: string): boolean {
    return !!this.primaryUserId && discordUserId === this.primaryUserId;
  }
}
