export type LetterParty = 'companion' | 'partner';

export const LETTER_STATES = ['draft', 'placed', 'read', 'archived'] as const;
export type LetterState = typeof LETTER_STATES[number];

export interface LetterRecord {
  id: string;
  author: LetterParty;
  recipient: LetterParty;
  subject: string;
  body: string;
  state: LetterState;
  createdAt: number;
  updatedAt: number;
  placedAt?: number;
  readAt?: number;
  archivedAt?: number;
}

export interface CreateLetterInput {
  id: string;
  author: LetterParty;
  recipient: LetterParty;
  subject: string;
  body: string;
  state: 'draft' | 'placed';
  createdAt: number;
}

export interface ListLettersInput {
  party: LetterParty;
  direction?: 'inbox' | 'outbox';
  states?: readonly LetterState[];
  limit: number;
}

export interface LetterStorePort {
  create(input: CreateLetterInput): Promise<LetterRecord>;
  get(id: string): Promise<LetterRecord | null>;
  list(input: ListLettersInput): Promise<LetterRecord[]>;
  place(id: string, actor: LetterParty, at: number): Promise<LetterRecord>;
  markRead(id: string, reader: LetterParty, at: number): Promise<LetterRecord>;
  archive(id: string, actor: LetterParty, at: number): Promise<LetterRecord>;
  countWaiting(recipient: LetterParty): Promise<number>;
  close(): Promise<void>;
}

export const LETTER_L0_CHANNEL_ID = 'letters:bin';

export interface LetterSessionMetadata {
  type: 'letter';
  schemaVersion: 1;
  event: 'composed' | 'read';
  letterId: string;
  author: LetterParty;
  recipient: LetterParty;
  subject: string;
}

export function parseLetterSessionMetadata(metadata?: string): LetterSessionMetadata | null {
  if (!metadata) return null;
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      record.type !== 'letter'
      || record.schemaVersion !== 1
      || (record.event !== 'composed' && record.event !== 'read')
      || typeof record.letterId !== 'string'
      || (record.author !== 'companion' && record.author !== 'partner')
      || (record.recipient !== 'companion' && record.recipient !== 'partner')
      || typeof record.subject !== 'string'
    ) return null;
    return record as unknown as LetterSessionMetadata;
  } catch {
    return null;
  }
}
