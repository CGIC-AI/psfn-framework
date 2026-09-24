import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('ExternalMemoryIntake');

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

  private receiptIds(): string[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter(file => file.endsWith('.json'))
      .sort()
      .map(file => file.slice(0, -'.json'.length));
  }

  /**
   * Every not-yet-completed receipt (cin6q). One unreadable or corrupt receipt
   * is reported and skipped so it cannot abort recovery of the others; it is
   * left in place (never auto-deleted) for operator inspection.
   */
  *pending(): Iterable<ExternalMemoryIntakeRecord> {
    for (const receiptId of this.receiptIds()) {
      let record: ExternalMemoryIntakeRecord | undefined;
      try {
        record = this.read(receiptId);
      } catch (error) {
        log.error('Skipping unreadable external memory intake receipt during recovery', {
          receiptId,
          error: toErrorMessage(error),
        });
        continue;
      }
      if (record && !record.completed) yield record;
    }
  }

  /**
   * Age out completed receipts (cin6q). A completed receipt is the idempotency
   * record for its event id, so it is kept for the retention window and removed
   * only after its last write is older than `olderThanMs`. Pending and
   * unreadable receipts are never pruned. Returns the number removed.
   */
  pruneCompleted(olderThanMs: number): number {
    let removed = 0;
    for (const receiptId of this.receiptIds()) {
      const file = this.path(receiptId);
      let record: ExternalMemoryIntakeRecord | undefined;
      try {
        record = this.read(receiptId);
      } catch {
        // Unreadable receipts are reported by pending() and never pruned.
        continue;
      }
      if (!record?.completed || statSync(file).mtimeMs >= olderThanMs) continue;
      unlinkSync(file);
      removed += 1;
    }
    return removed;
  }

  channelId(record: ExternalMemoryIntakeRecord): string {
    return externalMemorySessionId(record.binding, record.sessionId);
  }
}
