// ── Pending contact approvals (E3.4 contact-tracking policy gate) ──
// Durable queue of speakers seen in `contactTracking: 'approval'` channels who
// have no contact record yet. Entries persist across restarts so operator
// decisions (especially DENY) survive: a denied speaker stays untracked and is
// NOT re-proposed on every message — re-proposal requires an explicit operator
// reset (which removes the record entirely).
//
// Privacy: message previews are captured only from the channel where the
// speaker was seen — the queue payload never aggregates content from other
// channels or DMs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

export type PendingContactApprovalStatus = 'pending' | 'denied';

export interface PendingContactMessagePreview {
  messageId: string;
  preview: string;
  at: string;
}

export interface PendingContactApprovalEntry {
  id: string;
  /** Identity channel (e.g. 'discord', 'telegram', 'api'). */
  channel: string;
  /** Channel-scoped user id of the untracked speaker. */
  channelUserId: string;
  displayName: string;
  /** Channel/room id where the speaker was first seen. */
  channelId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Small sample of message previews from this channel only. */
  messagePreviews: PendingContactMessagePreview[];
  status: PendingContactApprovalStatus;
  decidedAt?: string;
}

export interface PendingContactSighting {
  channel: string;
  channelUserId: string;
  displayName: string;
  channelId: string;
  messageId: string;
  messagePreview: string;
}

export interface PendingContactSightingResult {
  entry: PendingContactApprovalEntry;
  /** True when this sighting created a NEW pending entry (notify exactly then). */
  created: boolean;
}

export interface PendingContactApprovalStore {
  list(): Promise<PendingContactApprovalEntry[]>;
  getById(id: string): Promise<PendingContactApprovalEntry | undefined>;
  getByIdentity(channel: string, channelUserId: string): Promise<PendingContactApprovalEntry | undefined>;
  /** Record a sighting of an untracked speaker; creates or updates the entry. */
  recordSighting(sighting: PendingContactSighting): Promise<PendingContactSightingResult>;
  /** Operator DENY: entry persists with status 'denied' so it never re-enqueues. */
  markDenied(id: string): Promise<PendingContactApprovalEntry | undefined>;
  /**
   * Remove the record entirely. Used after operator APPROVE (the contact row is
   * the durable outcome) and for operator RESET of a denial (next message from
   * the speaker re-proposes).
   */
  remove(id: string): Promise<PendingContactApprovalEntry | undefined>;
}

const DEFAULT_MAX_PREVIEWS = 3;
const DEFAULT_MAX_PREVIEW_LENGTH = 160;

interface PendingContactApprovalFileShape {
  version: 1;
  entries: PendingContactApprovalEntry[];
}

function identityKey(channel: string, channelUserId: string): string {
  return `${channel.trim().toLowerCase()}:${channelUserId.trim()}`;
}

export function truncateContactApprovalPreview(raw: string, maxLength: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

function assertEntryShape(value: unknown, filePath: string): PendingContactApprovalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid pending contact approval entry in ${filePath}`);
  }
  const entry = value as Record<string, unknown>;
  const requiredStrings = ['id', 'channel', 'channelUserId', 'displayName', 'channelId', 'firstSeenAt', 'lastSeenAt'];
  for (const field of requiredStrings) {
    if (typeof entry[field] !== 'string' || !(entry[field] as string).trim()) {
      throw new Error(`Invalid pending contact approval entry in ${filePath}: missing ${field}`);
    }
  }
  if (entry.status !== 'pending' && entry.status !== 'denied') {
    throw new Error(`Invalid pending contact approval entry in ${filePath}: status must be pending|denied`);
  }
  if (!Array.isArray(entry.messagePreviews)) {
    throw new Error(`Invalid pending contact approval entry in ${filePath}: messagePreviews must be an array`);
  }
  return value as PendingContactApprovalEntry;
}

export function createFilePendingContactApprovalStore(
  filePath: string,
  options?: { maxPreviews?: number; maxPreviewLength?: number; now?: () => Date },
): PendingContactApprovalStore {
  const maxPreviews = options?.maxPreviews ?? DEFAULT_MAX_PREVIEWS;
  const maxPreviewLength = options?.maxPreviewLength ?? DEFAULT_MAX_PREVIEW_LENGTH;
  const now = options?.now ?? (() => new Date());

  let loaded: Map<string, PendingContactApprovalEntry> | null = null;
  // Serialize mutations so concurrent sightings cannot interleave file writes.
  let mutationChain: Promise<unknown> = Promise.resolve();

  const load = (): Map<string, PendingContactApprovalEntry> => {
    if (loaded) return loaded;
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        loaded = new Map();
        return loaded;
      }
      throw error;
    }
    // Fail closed on corrupt state: never silently drop operator decisions.
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error(`Unsupported pending contact approvals file shape at ${filePath}`);
    }
    loaded = new Map(
      parsed.entries.map((entry: unknown) => {
        const validated = assertEntryShape(entry, filePath);
        return [identityKey(validated.channel, validated.channelUserId), validated];
      }),
    );
    return loaded;
  };

  const persist = (entries: Map<string, PendingContactApprovalEntry>): void => {
    const payload: PendingContactApprovalFileShape = {
      version: 1,
      entries: [...entries.values()],
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  };

  const enqueueMutation = <T>(mutation: () => T): Promise<T> => {
    const next = mutationChain.then(() => mutation());
    mutationChain = next.catch(() => undefined);
    return next;
  };

  return {
    async list(): Promise<PendingContactApprovalEntry[]> {
      return [...load().values()].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
    },

    async getById(id: string): Promise<PendingContactApprovalEntry | undefined> {
      return [...load().values()].find(entry => entry.id === id);
    },

    async getByIdentity(channel: string, channelUserId: string): Promise<PendingContactApprovalEntry | undefined> {
      return load().get(identityKey(channel, channelUserId));
    },

    recordSighting(sighting: PendingContactSighting): Promise<PendingContactSightingResult> {
      return enqueueMutation(() => {
        const entries = load();
        const key = identityKey(sighting.channel, sighting.channelUserId);
        const existing = entries.get(key);
        const timestamp = now().toISOString();

        if (existing) {
          // Denied entries are immutable until operator reset — no churn, no re-proposal.
          if (existing.status === 'denied') {
            return { entry: existing, created: false };
          }
          const alreadySampled = existing.messagePreviews.some(
            preview => preview.messageId === sighting.messageId,
          );
          const updated: PendingContactApprovalEntry = {
            ...existing,
            displayName: sighting.displayName.trim() || existing.displayName,
            lastSeenAt: timestamp,
            messagePreviews: alreadySampled || existing.messagePreviews.length >= maxPreviews
              ? existing.messagePreviews
              : [
                ...existing.messagePreviews,
                {
                  messageId: sighting.messageId,
                  preview: truncateContactApprovalPreview(sighting.messagePreview, maxPreviewLength),
                  at: timestamp,
                },
              ],
          };
          entries.set(key, updated);
          persist(entries);
          return { entry: updated, created: false };
        }

        const displayName = sighting.displayName.trim() || sighting.channelUserId.trim();
        const created: PendingContactApprovalEntry = {
          id: uuidv7(),
          channel: sighting.channel.trim().toLowerCase(),
          channelUserId: sighting.channelUserId.trim(),
          displayName,
          channelId: sighting.channelId,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          messagePreviews: [{
            messageId: sighting.messageId,
            preview: truncateContactApprovalPreview(sighting.messagePreview, maxPreviewLength),
            at: timestamp,
          }],
          status: 'pending',
        };
        entries.set(key, created);
        persist(entries);
        return { entry: created, created: true };
      });
    },

    markDenied(id: string): Promise<PendingContactApprovalEntry | undefined> {
      return enqueueMutation(() => {
        const entries = load();
        for (const [key, entry] of entries) {
          if (entry.id !== id) continue;
          const denied: PendingContactApprovalEntry = {
            ...entry,
            status: 'denied',
            decidedAt: now().toISOString(),
          };
          entries.set(key, denied);
          persist(entries);
          return denied;
        }
        return undefined;
      });
    },

    remove(id: string): Promise<PendingContactApprovalEntry | undefined> {
      return enqueueMutation(() => {
        const entries = load();
        for (const [key, entry] of entries) {
          if (entry.id !== id) continue;
          entries.delete(key);
          persist(entries);
          return entry;
        }
        return undefined;
      });
    },
  };
}
