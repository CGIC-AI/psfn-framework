import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  externalMemorySessionId,
  parseExternalMemoryBinding,
  type ExternalMemoryBinding,
  type ExternalMemoryReceipt,
} from '../../../shared/contracts/external-memory.js';
import { writeFileDurableAtomicSync } from '../../../shared/utils/fs.js';

const text = Type.String({ minLength: 1 });
const strict = { additionalProperties: false } as const;
const entrySchema = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  content: Type.String(),
  authorId: text,
  authorName: text,
  timestamp: Type.Integer({ minimum: 0 }),
  metadata: text,
}, strict);
const recordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  receiptId: text,
  binding: Type.Object({ bodyId: text, companionId: text, contactId: text }, strict),
  sessionId: text,
  eventId: text,
  contentHash: text,
  operation: Type.Union([Type.Literal('ingest'), Type.Literal('remember')]),
  entries: Type.Array(entrySchema),
  messageIds: Type.Array(Type.Integer({ minimum: 1 })),
  afterMessageId: Type.Integer({ minimum: 0 }),
  completed: Type.Boolean(),
}, strict);

export type ExternalMemoryIntakeRecord = Static<typeof recordSchema>;

export function externalMemoryReceiptId(
  binding: ExternalMemoryBinding, sessionId: string, eventId: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    binding.companionId, binding.bodyId, binding.contactId, sessionId, eventId,
  ])).digest('hex');
}

export function externalMemoryReceipt(record: ExternalMemoryIntakeRecord): ExternalMemoryReceipt {
  return {
    receiptId: record.receiptId,
    bodyId: record.binding.bodyId,
    companionId: record.binding.companionId,
    sessionId: record.sessionId,
    eventId: record.eventId,
    status: 'accepted',
  };
}

/** Screened evidence and durable processing intent, under the companion data root. */
export class ExternalMemoryIntakeStore {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid external memory receipt ID');
    return join(this.directory, `${id}.json`);
  }

  read(id: string): ExternalMemoryIntakeRecord | undefined {
    const file = this.path(id);
    if (!existsSync(file)) return undefined;
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Value.Check(recordSchema, value)) throw new Error('Invalid external memory intake record');
    parseExternalMemoryBinding(value.binding);
    if (value.receiptId !== id
      || externalMemoryReceiptId(value.binding, value.sessionId, value.eventId) !== id
      || (!value.completed && (value.entries.length === 0 || value.messageIds.length > value.entries.length))) {
      throw new Error('External memory receipt identity mismatch');
    }
    return value;
  }

  write(record: ExternalMemoryIntakeRecord, exclusive = false): void {
    if (!Value.Check(recordSchema, record)) throw new Error('Invalid external memory intake record');
    writeFileDurableAtomicSync(this.path(record.receiptId), JSON.stringify(record), { exclusive });
  }

  *pending(): Iterable<ExternalMemoryIntakeRecord> {
    if (!existsSync(this.directory)) return;
    for (const file of readdirSync(this.directory).sort()) {
      if (!file.endsWith('.json')) continue;
      const record = this.read(file.slice(0, -'.json'.length));
      if (record && !record.completed) yield record;
    }
  }

  channelId(record: ExternalMemoryIntakeRecord): string {
    return externalMemorySessionId(record.binding, record.sessionId);
  }
}
