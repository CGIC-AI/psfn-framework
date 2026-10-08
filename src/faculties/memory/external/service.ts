import { EXTERNAL_MEMORY_CHANNEL } from '../../../shared/routing/external-memory-channel.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { createHash } from 'node:crypto';
import { createDmConversationScope } from '../../../core/session/conversation-scope.js';
import { v7 as uuidv7 } from 'uuid';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import { resolvePreferredContactName } from '../../../core/contacts/preferred-name.js';
import type { PostTurnActionRuntime } from '../../../core/agent/post-turn-action-runtime.js';
import type { MemoryProvider } from '../../../core/agent/contracts.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  buildSessionMetadataWithIntakeScreening,
  parseIntakeScreeningMetadata,
} from '../../../core/session/intake-screening-metadata.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  externalMemorySessionId,
  parseExternalMemoryExecuteParams,
  type ExternalMemoryBinding,
  type ExternalMemoryExecuteParams,
  type ExternalMemoryExecuteResult,
  type ExternalMemoryRequest,
} from '../../../shared/contracts/external-memory.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { MemoryWriter } from '../writer.js';
import type { PurrMemory } from '../types.js';
import { isCurrentMemory } from '../current-memory.js';
import { createSubjectAuthorizedMemoryStore } from '../subject-authorized-store.js';
import { partitionVisibleMemories } from '../tools/visibility.js';
import {
  filterQuarantinedMemories,
  type MemorySessionQuarantineFilter,
} from '../retrieval/session-quarantine.js';
import {
  ExternalMemoryIntakeStore,
  externalMemoryReceipt,
  externalMemoryReceiptId,
  type ExternalMemoryIntakeRecord,
} from './intake-store.js';

const log = createComponentLogger('ExternalMemory');
const actionKind = 'memory.external.process';

interface ExternalMemoryServiceOptions {
  companionId: string;
  companionName: string;
  refreshChannelPolicy: () => void;
  intakeStore: ExternalMemoryIntakeStore;
  sessions: Pick<SessionStore, 'append' | 'getRecent' | 'getEntriesInRange' | 'flushSessionJournal'>;
  contacts: Pick<ContactStorePort, 'getById' | 'linkChannelIdentity' | 'recordChannelActivity'>;
  memoryStore: MemoryStorePort;
  memoryProvider: MemoryProvider | null;
  writer: Pick<MemoryWriter, 'write'>;
  screening: IntakeScreeningService | null;
  quarantine: MemorySessionQuarantineFilter;
  actions: PostTurnActionRuntime;
  retryDelayMs: number;
  /** How long a completed receipt is kept as the event-id idempotency record (cin6q). */
  completedReceiptRetentionMs: number;
  now?: () => number;
  searchLimit: number;
  goals: () => string;
  extract: (input: {
    sessionId: string; entries: readonly SessionEntry[]; canonicalContactId: string;
  }) => Promise<unknown>;
}

type ExternalMemoryMutation = Extract<ExternalMemoryRequest, { eventId: string }>;

/** A companion-bound memory surface. It never enters the foreground action loop. */
export class ExternalMemoryService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ExternalMemoryServiceOptions) {
    options.actions.registerHandler(actionKind, async action => {
      const receiptId = action.payload.receiptId;
      if (typeof receiptId !== 'string') throw new Error('Missing external memory receipt');
      try {
        await this.process(receiptId);
      } catch (error) {
        log.error('External memory processing remains pending', { receiptId, error: String(error) });
        return { detail: 'External memory evidence remains durable; processing will retry',
          rescheduleAt: Date.now() + options.retryDelayMs };
      }
    }, { executionMode: 'background', runtimeClass: 'maintenance_reflection' });
  }

  private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(key);
    const next = previous ? previous.then(work, work) : work();
    this.inFlight.set(key, next);
    try { return await next; } finally {
      if (this.inFlight.get(key) === next) this.inFlight.delete(key);
    }
  }

  private async contact(binding: ExternalMemoryBinding): Promise<Contact> {
    if (binding.companionId !== this.options.companionId) {
      throw new Error('External memory companion binding does not match this core');
    }
    const contact = await this.options.contacts.getById(binding.contactId);
    if (!contact || contact.id !== binding.contactId || contact.archivedAt) {
      throw new Error('External memory requires a live configured contact');
    }
    return contact;
  }

  private assertActive(channelId: string): void {
    if (this.options.quarantine.isSessionRetiredOrQuarantined(channelId)) {
      throw new Error('External memory session is retired or quarantined');
    }
  }

  async execute(input: ExternalMemoryExecuteParams): Promise<ExternalMemoryExecuteResult> {
    const { binding, request } = parseExternalMemoryExecuteParams(input);
    this.options.refreshChannelPolicy();
    const disclosure = classifyChannelDisclosure(EXTERNAL_MEMORY_CHANNEL, { isDirectMessage: true });
    const contact = await this.contact(binding);
    const channelId = externalMemorySessionId(binding, request.sessionId);
    this.assertActive(channelId);
    return runWithRequestContext({
      companionId: binding.companionId,
      channelId,
      sessionId: channelId,
      viewerMemorySubjectContactId: contact.id,
      viewerTrustLevel: contact.trustLevel,
      viewerChannelPrivacy: disclosure.channelPrivacy,
      viewerIsDirectMessage: true,
      requesterProvenance: 'human',
    }, async () => {
      if (request.operation === 'ingest' || request.operation === 'remember') {
        return this.serialized(channelId, () => this.accept(binding, request, contact));
      }
      if (request.operation === 'context') {
        if (!this.options.memoryProvider) throw new Error('Memory retrieval is unavailable');
        // bd9tx: the authenticated one-to-one binding is the DM scope; room
        // visibility derives only from this ConversationScope.
        const recalled = await this.options.memoryProvider.retrieve(
          request.query, channelId, contact.trustLevel,
          { isDirectMessage: true }, contact.id,
          undefined, undefined, undefined, undefined, undefined, undefined,
          createDmConversationScope({ channelId, contact: { contactId: contact.id } }),
        );
        const goals = contact.trustLevel === 'primary' && disclosure.channelPrivacy === 'private' && !disclosure.broadcast
          ? this.options.goals() : '';
        return { context: [goals, recalled].filter(Boolean).join('\n\n') };
      }
      const store = createSubjectAuthorizedMemoryStore(this.options.memoryStore, () => ({
        viewerContactId: contact.id,
      }));
      const candidates = request.operation === 'get'
        ? [await store.getById(request.id)].filter((row): row is PurrMemory => row !== undefined)
        : await store.searchByText(request.query,
          Math.min(request.limit ?? this.options.searchLimit, this.options.searchLimit));
      const current = filterQuarantinedMemories(this.options.quarantine,
        candidates.filter(isCurrentMemory)).memories;
      const visible = partitionVisibleMemories(current, {
        trustLevel: contact.trustLevel, ...disclosure,
        canonicalContactId: contact.id,
      }).visible.map(({ id, text, type }) => ({ id, text, type }));
      return request.operation === 'get'
        ? { memory: visible[0] ?? null }
        : { memories: visible };
    });
  }

  private async prepare(
    binding: ExternalMemoryBinding, request: ExternalMemoryMutation, contact: Contact,
    receiptId: string, contentHash: string,
  ): Promise<ExternalMemoryIntakeRecord> {
    const screening = this.options.screening;
    if (!screening) throw new Error('External memory requires intake screening');
    const channelId = externalMemorySessionId(binding, request.sessionId);
    const timestamp = request.operation === 'ingest' ? request.occurredAt : Date.now();
    if (!Number.isSafeInteger(timestamp) || timestamp > Date.now()) {
      throw new Error('External memory occurrence time must not be in the future');
    }
    const turnId = uuidv7();
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = request.operation === 'ingest'
      ? [{ role: 'user', content: request.user }, { role: 'assistant', content: request.assistant }]
      : [{ role: 'assistant', content: request.text }];
    const entries: ExternalMemoryIntakeRecord['entries'] = [];
    for (const message of messages) {
      const sourceMessageId = `${receiptId}:${message.role}`;
      const sourceClass = message.role === 'assistant' ? 'companion_self'
        : contact.trustLevel === 'primary' ? 'primary_user'
          : contact.trustLevel === 'trusted' ? 'trusted_contact'
            : contact.trustLevel === 'regular' ? 'regular_contact' : 'public_contact';
      const result = await screening.screen(message.content, {
        sourceClass, scope: 'strict',
        origin: { ref: `external:hermes:${sourceMessageId}` },
        sourceChannelId: channelId, sourceMessageId,
        canonicalContactId: contact.id,
        channelPrivacy: classifyChannelDisclosure(EXTERNAL_MEMORY_CHANNEL, { isDirectMessage: true }).channelPrivacy,
        atMs: timestamp,
      });
      if (result.withheld) {
        // An ingest with any withheld message is refused whole, exactly like
        // remember: withheld text must never be archived into the durable
        // session (psfn-framework-fyzor), and archiving half an exchange
        // would misrepresent the conversation.
        throw new Error(request.operation === 'remember'
          ? 'External memory note was withheld by intake policy'
          : 'External conversation was withheld by intake policy');
      }
      const metadata = buildSessionMetadataWithIntakeScreening(JSON.stringify({
        type: 'observed_message',
        turn: { turnId, sourceMessageId },
        conversationOrigin: { schemaVersion: 1, kind: 'direct_message' },
        externalOrigin: { schemaVersion: 1, runtime: 'hermes', ...binding,
          ...(request.source ? { source: request.source } : {}),
          sessionId: request.sessionId, eventId: request.eventId, receiptId, role: message.role },
      }), { mode: result.mode, withheld: result.withheld, envelopes: [result.snapshot] });
      entries.push({ role: message.role, content: result.effectiveText, metadata, timestamp,
        authorId: message.role === 'user' ? contact.id : binding.companionId,
        authorName: message.role === 'user'
          ? resolvePreferredContactName(contact) ?? contact.displayName
          : this.options.companionName });
    }
    return { schemaVersion: 1, receiptId, binding, sessionId: request.sessionId,
      ...(request.source ? { source: request.source } : {}),
      eventId: request.eventId, contentHash, operation: request.operation, entries,
      afterMessageId: this.options.sessions.getRecent(channelId, 1)[0]?.id ?? 0,
      messageIds: [], completed: false };
  }

  private async archive(record: ExternalMemoryIntakeRecord): Promise<void> {
    if (record.completed || record.operation !== 'ingest') return;
    // A durable intake prepared before withheld ingests were refused must not
    // reach the session either.
    if (record.entries.some(entry => parseIntakeScreeningMetadata(entry.metadata)?.withheld !== false)) {
      throw new Error('External conversation was withheld by intake policy');
    }
    const channelId = this.options.intakeStore.channelId(record);
    this.assertActive(channelId);
    const tail = this.options.sessions.getEntriesInRange(
      channelId, record.afterMessageId + 1, Number.MAX_SAFE_INTEGER,
    );
    const messageIds = record.entries.map((entry, index) => {
      const existing = tail.find(candidate => candidate.metadata === entry.metadata);
      const storedId = record.messageIds[index];
      if (storedId !== undefined && existing?.id !== storedId) {
        throw new Error('External conversation evidence is unavailable; refusing to recreate retired evidence');
      }
      if (existing && (existing.content !== entry.content || existing.role !== entry.role)) {
        throw new Error('External conversation evidence does not match its durable intake');
      }
      return existing?.id ?? this.options.sessions.append({ ...entry, channelId,
        channelVisibility: classifyChannelDisclosure(EXTERNAL_MEMORY_CHANNEL, { isDirectMessage: true }).channelPrivacy });
    });
    this.options.sessions.flushSessionJournal(channelId);
    record.messageIds = messageIds;
    this.options.intakeStore.write(record);
    // The credential's contact binding is also the stable attribution used by
    // the contact card and subject-scoped session views. Persist it only after
    // screened evidence is durable, and require success before acknowledging.
    const privacy = classifyChannelDisclosure(EXTERNAL_MEMORY_CHANNEL, { isDirectMessage: true }).channelPrivacy;
    const linked = await this.options.contacts.linkChannelIdentity(record.binding.contactId,
      EXTERNAL_MEMORY_CHANNEL, record.binding.bodyId, { privacyLevel: privacy });
    if (linked !== 'linked' && linked !== 'already_linked') {
      throw new Error('External memory channel identity does not match its configured contact');
    }
    await this.options.contacts.recordChannelActivity(
      record.binding.contactId, EXTERNAL_MEMORY_CHANNEL, channelId, privacy,
    );
  }

  private enqueue(record: ExternalMemoryIntakeRecord): void {
    if (record.completed) return;
    if (!this.options.actions.getStatus().persistence.enabled) {
      throw new Error('External memory requires durable deferred-action persistence');
    }
    const result = this.options.actions.enqueue({
      id: `external-memory:${record.receiptId}`, kind: actionKind,
      payload: { receiptId: record.receiptId }, dedupeKey: `external-memory:${record.receiptId}`,
      channelId: this.options.intakeStore.channelId(record), sourceMessageId: record.receiptId,
      inferredAt: record.entries[0]!.timestamp,
    });
    if (result === 'dropped_budget') throw new Error('External memory processing queue is full');
  }

  private async accept(
    binding: ExternalMemoryBinding, request: ExternalMemoryMutation, contact: Contact,
  ): Promise<ExternalMemoryExecuteResult> {
    const receiptId = externalMemoryReceiptId(binding, request.sessionId, request.eventId);
    const contentIdentity: unknown[] = request.operation === 'ingest'
      ? [request.operation, request.sessionId, request.eventId, request.user, request.assistant, request.occurredAt]
      : [request.operation, request.sessionId, request.eventId, request.text];
    // Preserve legacy receipt hashes; source-bearing retries bind their sender too.
    if (request.source) contentIdentity.push([
      request.source.platform, request.source.userId, request.source.chatId, request.source.chatType,
    ]);
    const contentHash = createHash('sha256').update(JSON.stringify(contentIdentity)).digest('hex');
    let record = this.options.intakeStore.read(receiptId);
    if (record && record.contentHash !== contentHash) {
      throw new Error('External memory event ID was already used for different content');
    }
    if (!record) {
      record = await this.prepare(binding, request, contact, receiptId, contentHash);
      this.options.intakeStore.write(record, true);
    }
    await this.archive(record);
    this.enqueue(record);
    return { receipt: externalMemoryReceipt(record) };
  }

  private async process(receiptId: string): Promise<void> {
    const initial = this.options.intakeStore.read(receiptId);
    if (!initial) throw new Error('External memory evidence is missing');
    const channelId = this.options.intakeStore.channelId(initial);
    // Serialize retries of this receipt, but let new exchanges in the same
    // conversation archive while a model is extracting earlier evidence.
    await this.serialized(`processing:${receiptId}`, async () => {
      const record = this.options.intakeStore.read(receiptId)!;
      if (record.completed) return;
      this.options.refreshChannelPolicy();
      await this.contact(record.binding);
      this.assertActive(channelId);
      await this.serialized(channelId, () => this.archive(record));
      if (record.operation === 'ingest') {
        const entries = record.messageIds.flatMap(id => this.options.sessions.getEntriesInRange(channelId, id, id));
        if (entries.length !== record.entries.length) throw new Error('External conversation evidence is incomplete');
        await this.options.extract({ sessionId: channelId, entries, canonicalContactId: record.binding.contactId });
      } else {
        const entry = record.entries[0]!;
        const screening = parseIntakeScreeningMetadata(entry.metadata);
        if (!screening || screening.withheld) throw new Error('External memory note was withheld by intake policy');
        await this.options.writer.write({ text: entry.content, type: 'semantic',
          sourceRef: `external:hermes:${receiptId}`, sourceType: 'tool_write',
          provenance: { channelId, sessionId: channelId, companionId: record.binding.companionId,
            actor: 'companion', toolName: 'psfn_memory_remember', toolCallId: record.eventId,
            triggerContactId: record.binding.contactId, sourceConversationAt: entry.timestamp },
          intakeEnvelopes: screening.envelopes });
      }
      record.completed = true;
      record.entries = [];
      this.options.intakeStore.write(record);
    });
  }

  /** Replay durable intents after restart, including the append-before-receipt crash window. */
  async recover(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const pruned = this.options.intakeStore.pruneCompleted(now - this.options.completedReceiptRetentionMs);
    if (pruned > 0) log.info('Pruned completed external memory intake receipts', { pruned });
    for (const record of this.options.intakeStore.pending()) {
      await this.serialized(this.options.intakeStore.channelId(record), async () => {
        if (record.binding.companionId !== this.options.companionId) {
          throw new Error('External memory recovery belongs to another companion');
        }
        this.enqueue(record);
      });
    }
  }
}
