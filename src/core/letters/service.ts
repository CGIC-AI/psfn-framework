import { randomUUID } from 'node:crypto';

import type { SessionStore } from '../../persistence/sessions/store.js';
import {
  LETTER_L0_CHANNEL_ID,
  type LetterParty,
  type LetterRecord,
  type LetterSessionMetadata,
  type LetterState,
  type LetterStorePort,
} from './contracts.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export interface LetterServiceOptions {
  store: LetterStorePort;
  sessionStore: Pick<SessionStore, 'append'>;
  now?: () => number;
  createId?: () => string;
}

export interface ComposeLetterInput {
  /** Stable caller-owned id for idempotent authored delivery (for example, a durable disposition outbox). */
  id?: string;
  author: LetterParty;
  recipient: LetterParty;
  subject: string;
  body: string;
  draft?: boolean;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Letter ${field} must not be empty`);
  return normalized;
}

function assertDirected(author: LetterParty, recipient: LetterParty): void {
  if (author === recipient) throw new Error('A letter must be directed to the other party');
}

function eventMetadata(letter: LetterRecord, event: LetterSessionMetadata['event']): string {
  return JSON.stringify({
    type: 'letter',
    schemaVersion: 1,
    event,
    letterId: letter.id,
    author: letter.author,
    recipient: letter.recipient,
    subject: letter.subject,
  } satisfies LetterSessionMetadata);
}

export class LetterService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: LetterServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async compose(input: ComposeLetterInput): Promise<LetterRecord> {
    assertDirected(input.author, input.recipient);
    const subject = requireText(input.subject, 'subject');
    const body = requireText(input.body, 'body');
    if (input.id) {
      const existing = await this.options.store.get(input.id);
      if (existing) {
        const requestedState = input.draft === true ? 'draft' : 'placed';
        const stateMatches = requestedState === 'draft'
          ? existing.state === 'draft'
          : existing.state !== 'draft';
        if (
          existing.author !== input.author
          || existing.recipient !== input.recipient
          || existing.subject !== subject
          || existing.body !== body
          || !stateMatches
        ) {
          throw new Error(`Letter id ${input.id} is already bound to different authored content`);
        }
        return existing;
      }
    }
    const createdAt = this.now();
    const letter = await this.options.store.create({
      id: input.id ?? this.createId(),
      author: input.author,
      recipient: input.recipient,
      subject,
      body,
      state: input.draft === true ? 'draft' : 'placed',
      createdAt,
    });
    this.options.sessionStore.append({
      channelId: LETTER_L0_CHANNEL_ID,
      role: letter.author === 'companion' ? 'assistant' : 'user',
      content: letter.body,
      authorId: letter.author,
      authorName: letter.author === 'companion' ? 'Companion' : 'Partner',
      timestamp: createdAt,
      metadata: eventMetadata(letter, 'composed'),
    });
    return letter;
  }

  async place(id: string, actor: LetterParty): Promise<LetterRecord> {
    return this.options.store.place(id, actor, this.now());
  }

  async read(id: string, reader: LetterParty): Promise<LetterRecord> {
    const letter = await this.options.store.markRead(id, reader, this.now());
    const timestamp = letter.readAt ?? this.now();
    this.options.sessionStore.append({
      channelId: LETTER_L0_CHANNEL_ID,
      role: reader === 'companion' ? 'assistant' : 'user',
      content: `Read letter: ${letter.subject}`,
      authorId: reader,
      authorName: reader === 'companion' ? 'Companion' : 'Partner',
      timestamp,
      metadata: eventMetadata(letter, 'read'),
    });
    return letter;
  }

  async archive(id: string, actor: LetterParty): Promise<LetterRecord> {
    return this.options.store.archive(id, actor, this.now());
  }

  async list(input: {
    party: LetterParty;
    direction?: 'inbox' | 'outbox';
    states?: readonly LetterState[];
    limit?: number;
  }): Promise<LetterRecord[]> {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(`Letter list limit must be between 1 and ${MAX_LIST_LIMIT}`);
    }
    return this.options.store.list({ ...input, limit });
  }

  get(id: string): Promise<LetterRecord | null> {
    return this.options.store.get(id);
  }

  countWaiting(recipient: LetterParty): Promise<number> {
    return this.options.store.countWaiting(recipient);
  }
}
