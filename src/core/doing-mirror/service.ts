import { randomUUID } from 'node:crypto';

import type { LetterService } from '../letters/service.js';
import {
  type DoingMirrorDisposition,
  type DoingMirrorDispositionRecord,
  type DoingMirrorItem,
  type DoingMirrorItemType,
  type DoingMirrorSourceItem,
  type DoingMirrorSourcePort,
  type DoingMirrorState,
  type DoingMirrorStorePort,
  type DoingMirrorTransitionInput,
} from './contracts.js';

export interface DoingMirrorServiceOptions {
  store: DoingMirrorStorePort;
  letters: Pick<LetterService, 'compose'>;
  now?: () => number;
  createId?: () => string;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`doing-mirror ${field} must not be empty`);
  return normalized;
}

function normalizeReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function openDisposition(source: DoingMirrorSourceItem): DoingMirrorDisposition {
  return {
    itemType: source.itemType,
    itemId: source.itemId,
    state: 'open',
    version: 0,
    updatedAt: source.createdAt,
    updatedBy: 'companion',
  };
}

function assertTransition(from: DoingMirrorState, to: Exclude<DoingMirrorState, 'open'>): void {
  if (from === 'open' && to !== 'considering') {
    throw new Error('open disposition can only move to considering');
  }
  if (from === 'considering' && to !== 'done' && to !== 'declined') {
    throw new Error('considering disposition can only move to done or declined');
  }
  if (from === 'done' || from === 'declined') {
    throw new Error(`${from} disposition is terminal`);
  }
}

function samePendingTransition(
  record: DoingMirrorDispositionRecord,
  input: DoingMirrorTransitionInput,
  reason: string | undefined,
  subject: string,
  body: string,
): boolean {
  return record.state === input.state
    && record.reason === reason
    && record.notification.subject === subject
    && record.notification.body === body;
}

function assertSource(source: DoingMirrorSourceItem, itemType: DoingMirrorItemType): void {
  if (source.itemType !== itemType) {
    throw new Error(`doing-mirror source registered for ${itemType} returned ${source.itemType}`);
  }
  if (!source.itemId.trim() || !source.ref.trim() || !source.title.trim()) {
    throw new Error(`doing-mirror ${itemType} source returned an incomplete item`);
  }
  if (source.origin.provenanceRefs.length === 0) {
    throw new Error(`doing-mirror ${itemType} source did not prove companion origin`);
  }
  if (!Number.isFinite(source.createdAt) || source.createdAt < 0) {
    throw new Error(`doing-mirror ${itemType} source returned an invalid createdAt`);
  }
}

export class DoingMirrorService {
  private readonly sources = new Map<DoingMirrorItemType, DoingMirrorSourcePort>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: DoingMirrorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  registerSource(source: DoingMirrorSourcePort): void {
    if (this.sources.has(source.itemType)) {
      throw new Error(`doing-mirror item type ${source.itemType} is already registered`);
    }
    this.sources.set(source.itemType, source);
  }

  async list(): Promise<DoingMirrorItem[]> {
    const sourceGroups = await Promise.all(
      [...this.sources.values()].map(source => source.list()),
    );
    const dispositions = await this.options.store.list();
    const byKey = new Map(dispositions.map(record => [this.key(record.itemType, record.itemId), record]));
    const seen = new Set<string>();
    const items = sourceGroups.flatMap((group) => group.map((source) => {
      assertSource(source, source.itemType);
      const key = this.key(source.itemType, source.itemId);
      if (seen.has(key)) throw new Error(`doing-mirror source returned duplicate item ${key}`);
      seen.add(key);
      return {
        source,
        disposition: byKey.get(key) ?? openDisposition(source),
      };
    }));
    return items.sort((left, right) => (
      right.disposition.updatedAt - left.disposition.updatedAt
      || left.source.ref.localeCompare(right.source.ref)
    ));
  }

  async get(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorItem> {
    const sourcePort = this.requireSource(itemType);
    const source = await sourcePort.get(requireText(itemId, 'itemId'));
    if (!source) throw new Error(`doing-mirror ${itemType} item was not found`);
    assertSource(source, itemType);
    const disposition = await this.options.store.get(itemType, source.itemId);
    return { source, disposition: disposition ?? openDisposition(source) };
  }

  async transition(input: DoingMirrorTransitionInput): Promise<DoingMirrorItem> {
    const reason = normalizeReason(input.reason);
    if (input.state === 'declined' && !reason) {
      throw new Error('declined disposition requires a reason');
    }
    const subject = requireText(input.subject, 'Letter subject');
    const body = requireText(input.body, 'Letter body');
    const current = await this.get(input.itemType, input.itemId);

    if (current.disposition.state === input.state) {
      if (!samePendingTransition(current.disposition, input, reason, subject, body)) {
        throw new Error(`doing-mirror ${input.itemType} transition conflicts with the stored disposition`);
      }
      const delivered = current.disposition.notification.deliveredAt === undefined
        ? await this.deliver(current.disposition)
        : current.disposition;
      return { source: current.source, disposition: delivered };
    }

    assertTransition(current.disposition.state, input.state);
    const persisted = await this.options.store.transition({
      itemType: input.itemType,
      itemId: current.source.itemId,
      expectedState: current.disposition.state,
      expectedVersion: current.disposition.version,
      state: input.state,
      ...(reason ? { reason } : {}),
      updatedAt: this.now(),
      letterId: this.createId(),
      letterSubject: subject,
      letterBody: body,
    });
    const delivered = await this.deliver(persisted);
    return { source: current.source, disposition: delivered };
  }

  private async deliver(record: DoingMirrorDispositionRecord): Promise<DoingMirrorDispositionRecord> {
    await this.options.letters.compose({
      id: record.notification.letterId,
      author: 'partner',
      recipient: 'companion',
      subject: record.notification.subject,
      body: record.notification.body,
    });
    return await this.options.store.markLetterDelivered(
      record.itemType,
      record.itemId,
      record.notification.letterId,
      this.now(),
    );
  }

  private requireSource(itemType: DoingMirrorItemType): DoingMirrorSourcePort {
    const source = this.sources.get(itemType);
    if (!source) throw new Error(`doing-mirror item type ${itemType} is not registered`);
    return source;
  }

  private key(itemType: DoingMirrorItemType, itemId: string): string {
    return `${itemType}:${itemId}`;
  }
}
