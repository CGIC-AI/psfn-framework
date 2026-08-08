// ── Companion-initiated contact block list (cogsec agency, htm9.16) ──
//
// A companion can escalate against an abusive user all the way to "I never want
// to see this person's messages again." This store is the system-owned,
// persisted, reversible block list backing that agency:
//
//   - SOFT block: the message is no longer processed by the agent; each drop
//     emits a cogsec/quarantine event so the operator retains visibility.
//   - HARD block: inbound is dropped at the gateway full stop, no event and no
//     companion attention spent — the guaranteed backstop.
//
// The list is keyed by (channelType, contactId) where contactId is the
// channel-local author id that the gateway sees on an inbound SubstrateMessage
// (e.g. a Discord user id). The gateway reads it to decide drop/observe/allow;
// the agent-side contact tool writes it. Because both processes touch the same
// file, every read reloads on mtime change and every mutation is a fresh
// read-modify-write persisted with an atomic rename.
//
// Fail closed: malformed persisted state throws on load; unknown/blank inputs
// are rejected rather than silently ignored. Unblocking is only ever explicit
// (companion or operator) — nothing in this module clears a block automatically.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const CONTACT_BLOCK_LIST_VERSION = 1 as const;

/** Soft = drop-with-visibility, hard = silent gateway drop. */
export type ContactBlockMode = 'soft' | 'hard';
/** Where the block applies. DMs drop at the gateway; groups observe-only. */
export type ContactBlockScope = 'dm' | 'group' | 'all';
export type ContactBlockActorKind = 'companion' | 'operator';

const BLOCK_MODES: ReadonlySet<ContactBlockMode> = new Set(['soft', 'hard']);
const BLOCK_SCOPES: ReadonlySet<ContactBlockScope> = new Set(['dm', 'group', 'all']);
const ACTOR_KINDS: ReadonlySet<ContactBlockActorKind> = new Set(['companion', 'operator']);

export interface ContactBlockActor {
  kind: ContactBlockActorKind;
  /** Free-form actor identifier, e.g. 'companion' or 'operator:pierre'. */
  id: string;
}

export interface ContactBlockEntry {
  channelType: string;
  /** Channel-local author id the gateway sees on inbound (e.g. discord user id). */
  contactId: string;
  /** Best-effort link back to the canonical contact row, when known. */
  canonicalContactId?: string;
  displayName?: string;
  mode: ContactBlockMode;
  scope: ContactBlockScope;
  reason?: string;
  blockedBy: ContactBlockActor;
  blockedAt: string;
  updatedAt: string;
}

export type ContactBlockAuditAction = 'block' | 'update' | 'unblock';

export interface ContactBlockAuditEntry {
  action: ContactBlockAuditAction;
  channelType: string;
  contactId: string;
  mode?: ContactBlockMode;
  scope?: ContactBlockScope;
  reason?: string;
  actor: ContactBlockActor;
  at: string;
}

export interface ContactBlockListState {
  version: typeof CONTACT_BLOCK_LIST_VERSION;
  updatedAt: string;
  entries: Record<string, ContactBlockEntry>;
  audit: ContactBlockAuditEntry[];
}

export type ContactBlockDecisionAction = 'allow' | 'drop' | 'observe';

export interface ContactBlockDecision {
  action: ContactBlockDecisionAction;
  mode?: ContactBlockMode;
  scope?: ContactBlockScope;
  reason?: string;
  entry?: ContactBlockEntry;
}

export interface ContactBlockInput {
  channelType: string;
  contactId: string;
  canonicalContactId?: string;
  displayName?: string;
  mode: ContactBlockMode;
  /** Defaults to 'all' (both DM and group) when omitted. */
  scope?: ContactBlockScope;
  reason?: string;
  actor: ContactBlockActor;
}

export interface ContactUnblockInput {
  channelType: string;
  contactId: string;
  reason?: string;
  actor: ContactBlockActor;
}

export interface ContactBlockEvaluateInput {
  channelType: string;
  contactId: string;
  isDirectMessage: boolean;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function parseMode(value: unknown, field: string): ContactBlockMode {
  if (typeof value === 'string' && BLOCK_MODES.has(value as ContactBlockMode)) {
    return value as ContactBlockMode;
  }
  throw new Error(`${field} must be one of: soft, hard`);
}

function parseScope(value: unknown, field: string): ContactBlockScope {
  if (typeof value === 'string' && BLOCK_SCOPES.has(value as ContactBlockScope)) {
    return value as ContactBlockScope;
  }
  throw new Error(`${field} must be one of: dm, group, all`);
}

function parseActor(value: unknown, field: string): ContactBlockActor {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !ACTOR_KINDS.has(kind as ContactBlockActorKind)) {
    throw new Error(`${field}.kind must be one of: companion, operator`);
  }
  return { kind: kind as ContactBlockActorKind, id: requireString(value.id, `${field}.id`) };
}

function entryKey(channelType: string, contactId: string): string {
  return `${channelType}\x00${contactId}`;
}

function parseEntry(value: unknown, field: string): ContactBlockEntry {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    channelType: requireString(value.channelType, `${field}.channelType`),
    contactId: requireString(value.contactId, `${field}.contactId`),
    ...(value.canonicalContactId !== undefined
      ? { canonicalContactId: requireString(value.canonicalContactId, `${field}.canonicalContactId`) }
      : {}),
    ...(value.displayName !== undefined
      ? { displayName: requireString(value.displayName, `${field}.displayName`) }
      : {}),
    mode: parseMode(value.mode, `${field}.mode`),
    scope: parseScope(value.scope, `${field}.scope`),
    ...(value.reason !== undefined ? { reason: requireString(value.reason, `${field}.reason`) } : {}),
    blockedBy: parseActor(value.blockedBy, `${field}.blockedBy`),
    blockedAt: requireString(value.blockedAt, `${field}.blockedAt`),
    updatedAt: requireString(value.updatedAt, `${field}.updatedAt`),
  };
}

function parseAuditEntry(value: unknown, field: string): ContactBlockAuditEntry {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const action = value.action;
  if (action !== 'block' && action !== 'update' && action !== 'unblock') {
    throw new Error(`${field}.action must be one of: block, update, unblock`);
  }
  return {
    action,
    channelType: requireString(value.channelType, `${field}.channelType`),
    contactId: requireString(value.contactId, `${field}.contactId`),
    ...(value.mode !== undefined ? { mode: parseMode(value.mode, `${field}.mode`) } : {}),
    ...(value.scope !== undefined ? { scope: parseScope(value.scope, `${field}.scope`) } : {}),
    ...(value.reason !== undefined ? { reason: requireString(value.reason, `${field}.reason`) } : {}),
    actor: parseActor(value.actor, `${field}.actor`),
    at: requireString(value.at, `${field}.at`),
  };
}

function parseState(raw: unknown): ContactBlockListState {
  if (!isRecord(raw)) {
    throw new Error('contact-block-list state must be an object');
  }
  if (raw.version !== CONTACT_BLOCK_LIST_VERSION) {
    throw new Error(`contact-block-list version must be ${CONTACT_BLOCK_LIST_VERSION}`);
  }
  const entriesRaw = raw.entries;
  if (!isRecord(entriesRaw)) {
    throw new Error('contact-block-list entries must be an object');
  }
  const entries: Record<string, ContactBlockEntry> = {};
  for (const [key, entryValue] of Object.entries(entriesRaw)) {
    const entry = parseEntry(entryValue, `entries["${key}"]`);
    // Rebuild the key deterministically so a hand-edited file cannot desync the
    // key from its (channelType, contactId) — the gateway looks up by that pair.
    entries[entryKey(entry.channelType, entry.contactId)] = entry;
  }
  const auditRaw = raw.audit;
  if (!Array.isArray(auditRaw)) {
    throw new Error('contact-block-list audit must be an array');
  }
  const audit = auditRaw.map((value, index) => parseAuditEntry(value, `audit[${index}]`));
  return {
    version: CONTACT_BLOCK_LIST_VERSION,
    updatedAt: requireString(raw.updatedAt, 'updatedAt'),
    entries,
    audit,
  };
}

function emptyState(now: Date): ContactBlockListState {
  return {
    version: CONTACT_BLOCK_LIST_VERSION,
    updatedAt: now.toISOString(),
    entries: {},
    audit: [],
  };
}

function cloneEntry(entry: ContactBlockEntry): ContactBlockEntry {
  return { ...entry, blockedBy: { ...entry.blockedBy } };
}

export class ContactBlockListStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: ContactBlockListState;
  private lastMtimeMs: number | null = null;

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  /**
   * Set (or upgrade) a block on a channel-local contact id. Idempotent per
   * (channelType, contactId): re-blocking updates mode/scope/reason in place.
   */
  block(input: ContactBlockInput): ContactBlockEntry {
    this.reloadIfChanged();
    const channelType = requireString(input.channelType, 'channelType');
    const contactId = requireString(input.contactId, 'contactId');
    const mode = parseMode(input.mode, 'mode');
    const scope = input.scope === undefined ? 'all' : parseScope(input.scope, 'scope');
    const actor = parseActor(input.actor, 'actor');
    const reason = optionalString(input.reason, 'reason');
    const canonicalContactId = optionalString(input.canonicalContactId, 'canonicalContactId');
    const displayName = optionalString(input.displayName, 'displayName');
    const nowIso = this.now().toISOString();
    const key = entryKey(channelType, contactId);
    const existing: ContactBlockEntry | undefined = Object.prototype.hasOwnProperty.call(this.state.entries, key)
      ? this.state.entries[key]
      : undefined;
    const entry: ContactBlockEntry = {
      channelType,
      contactId,
      ...(canonicalContactId ? { canonicalContactId } : existing?.canonicalContactId ? { canonicalContactId: existing.canonicalContactId } : {}),
      ...(displayName ? { displayName } : existing?.displayName ? { displayName: existing.displayName } : {}),
      mode,
      scope,
      ...(reason ? { reason } : {}),
      blockedBy: existing ? existing.blockedBy : actor,
      blockedAt: existing ? existing.blockedAt : nowIso,
      updatedAt: nowIso,
    };
    const audit: ContactBlockAuditEntry = {
      action: existing ? 'update' : 'block',
      channelType,
      contactId,
      mode,
      scope,
      ...(reason ? { reason } : {}),
      actor,
      at: nowIso,
    };
    this.state = {
      version: CONTACT_BLOCK_LIST_VERSION,
      updatedAt: nowIso,
      entries: { ...this.state.entries, [key]: entry },
      audit: [...this.state.audit, audit],
    };
    this.persist();
    return cloneEntry(entry);
  }

  /**
   * Remove a block. Only ever explicit — no code path calls this automatically.
   * Returns false (and records nothing) when there was no matching block.
   */
  unblock(input: ContactUnblockInput): boolean {
    this.reloadIfChanged();
    const channelType = requireString(input.channelType, 'channelType');
    const contactId = requireString(input.contactId, 'contactId');
    const actor = parseActor(input.actor, 'actor');
    const reason = optionalString(input.reason, 'reason');
    const key = entryKey(channelType, contactId);
    if (!Object.prototype.hasOwnProperty.call(this.state.entries, key)) {
      return false;
    }
    const nowIso = this.now().toISOString();
    const nextEntries = { ...this.state.entries };
    delete nextEntries[key];
    const audit: ContactBlockAuditEntry = {
      action: 'unblock',
      channelType,
      contactId,
      ...(reason ? { reason } : {}),
      actor,
      at: nowIso,
    };
    this.state = {
      version: CONTACT_BLOCK_LIST_VERSION,
      updatedAt: nowIso,
      entries: nextEntries,
      audit: [...this.state.audit, audit],
    };
    this.persist();
    return true;
  }

  get(channelType: string, contactId: string): ContactBlockEntry | null {
    this.reloadIfChanged();
    const key = entryKey(requireString(channelType, 'channelType'), requireString(contactId, 'contactId'));
    const entry = this.state.entries[key];
    if (entry === undefined) return null;
    return cloneEntry(entry);
  }

  list(): ContactBlockEntry[] {
    this.reloadIfChanged();
    return Object.values(this.state.entries)
      .map(cloneEntry)
      .sort((left, right) => right.blockedAt.localeCompare(left.blockedAt));
  }

  listAudit(): ContactBlockAuditEntry[] {
    this.reloadIfChanged();
    return this.state.audit.map((entry) => ({ ...entry, actor: { ...entry.actor } }));
  }

  /**
   * Gateway inbound decision. DMs from a blocked contact drop; group messages
   * downgrade to observe-only (the companion ignores them without disrupting
   * the room for everyone else). Scope narrows which surfaces the block covers.
   */
  evaluate(input: ContactBlockEvaluateInput): ContactBlockDecision {
    this.reloadIfChanged();
    const channelType = requireString(input.channelType, 'channelType');
    const contactId = requireString(input.contactId, 'contactId');
    const key = entryKey(channelType, contactId);
    const entry = this.state.entries[key];
    if (entry === undefined) {
      return { action: 'allow' };
    }
    const appliesToDm = entry.scope === 'dm' || entry.scope === 'all';
    const appliesToGroup = entry.scope === 'group' || entry.scope === 'all';
    if (input.isDirectMessage) {
      if (!appliesToDm) return { action: 'allow' };
      return {
        action: 'drop',
        mode: entry.mode,
        scope: entry.scope,
        ...(entry.reason ? { reason: entry.reason } : {}),
        entry: cloneEntry(entry),
      };
    }
    if (!appliesToGroup) return { action: 'allow' };
    return {
      action: 'observe',
      mode: entry.mode,
      scope: entry.scope,
      ...(entry.reason ? { reason: entry.reason } : {}),
      entry: cloneEntry(entry),
    };
  }

  private reloadIfChanged(): void {
    if (!existsSync(this.filePath)) {
      // File removed out from under us: reset to empty rather than serving a
      // stale in-memory block list.
      if (this.lastMtimeMs !== null) {
        this.state = emptyState(this.now());
        this.lastMtimeMs = null;
      }
      return;
    }
    const mtimeMs = statSync(this.filePath).mtimeMs;
    if (this.lastMtimeMs !== null && mtimeMs === this.lastMtimeMs) {
      return;
    }
    this.state = this.load();
  }

  private load(): ContactBlockListState {
    if (!existsSync(this.filePath)) {
      this.lastMtimeMs = null;
      return emptyState(this.now());
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    const parsed = parseState(JSON.parse(raw) as unknown);
    this.lastMtimeMs = statSync(this.filePath).mtimeMs;
    return parsed;
  }

  private persist(): void {
    writeJsonAtomic(this.filePath, this.state);
    if (existsSync(this.filePath)) {
      this.lastMtimeMs = statSync(this.filePath).mtimeMs;
    }
  }
}
