import { randomUUID } from 'node:crypto';
import type { WikiStorePort } from './types.js';
import {
  parseCompanionWishDocument,
  requireOperatorWishResponse,
  requireWishBeadId,
  requireWishContext,
  requireWishId,
  requireWishText,
  type CompanionWish,
  type CompanionWishState,
} from './personal-wishlist-contracts.js';

export {
  COMPANION_WISH_STATES,
  MAX_OPERATOR_RESPONSE_CHARS,
  MAX_WISH_CONTEXT_CHARS,
  MAX_WISH_TEXT_CHARS,
  parseCompanionWishDocument,
} from './personal-wishlist-contracts.js';
export type {
  CompanionWish,
  CompanionWishState,
} from './personal-wishlist-contracts.js';

const WISHLIST_TAG = 'wishlist:companion-authored';

function wishDocumentId(id: string): string {
  return `wishlist.wish.${id}`;
}

function hasWishlistTag(tags: readonly string[]): boolean {
  return tags.some(tag => tag === WISHLIST_TAG);
}

export class PersonalWishlist {
  constructor(
    private readonly store: WikiStorePort,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  listWishes(states?: readonly CompanionWishState[]): CompanionWish[] {
    const requestedStates = states ? new Set(states) : null;
    return this.store.list()
      .filter(entry => hasWishlistTag(entry.tags))
      .map((entry) => {
        const document = this.store.get(entry.id);
        if (!document) throw new Error(`wishlist entry disappeared during listing: ${entry.id}`);
        return parseCompanionWishDocument(document);
      })
      .filter(wish => !requestedStates || requestedStates.has(wish.state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getWish(refOrId: string): CompanionWish {
    const id = requireWishId(refOrId.replace(/^wish:/u, ''));
    const document = this.store.get(wishDocumentId(id));
    if (!document) throw new Error(`wish not found: wish:${id}`);
    return parseCompanionWishDocument(document);
  }

  createWish(input: { text: string; context?: string }): CompanionWish {
    const id = requireWishId(this.createId());
    if (this.store.get(wishDocumentId(id))) throw new Error(`wish already exists: wish:${id}`);
    const timestamp = this.now().toISOString();
    const wish: CompanionWish = {
      schemaVersion: 1,
      kind: 'companion_wish',
      id,
      ref: `wish:${id}`,
      text: requireWishText(input.text, 'wish text'),
      ...(input.context !== undefined
        ? { context: requireWishContext(input.context, 'wish context') }
        : {}),
      state: 'open',
      visibility: 'primary_contact',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.persist(wish, 'agent:personal-wishlist');
    return wish;
  }

  acknowledgeWish(refOrId: string): CompanionWish {
    const current = this.getWish(refOrId);
    if (current.state !== 'open') return current;
    const timestamp = this.nextTimestamp(current);
    const acknowledged: CompanionWish = {
      ...current,
      state: 'acknowledged',
      acknowledgedAt: timestamp,
      updatedAt: timestamp,
    };
    this.persist(acknowledged, 'operator:personal-wishlist');
    return acknowledged;
  }

  respondToWish(refOrId: string, response: string): CompanionWish {
    const current = this.getWish(refOrId);
    const timestamp = this.nextTimestamp(current);
    const responded: CompanionWish = {
      ...current,
      state: current.state === 'open' ? 'acknowledged' : current.state,
      acknowledgedAt: current.acknowledgedAt ?? timestamp,
      operatorResponse: requireOperatorWishResponse(response),
      updatedAt: timestamp,
    };
    this.persist(responded, 'operator:personal-wishlist');
    return responded;
  }

  planWish(refOrId: string, beadId: string): CompanionWish {
    const current = this.getWish(refOrId);
    if (current.state === 'done') throw new Error(`${current.ref} is already done`);
    if (current.state === 'planned') return current;
    const timestamp = this.nextTimestamp(current);
    const planned: CompanionWish = {
      ...current,
      state: 'planned',
      acknowledgedAt: current.acknowledgedAt ?? timestamp,
      plannedAt: timestamp,
      beadId: requireWishBeadId(beadId),
      updatedAt: timestamp,
    };
    this.persist(planned, 'operator:personal-wishlist');
    return planned;
  }

  completeWish(refOrId: string): CompanionWish {
    const current = this.getWish(refOrId);
    if (current.state === 'done') return current;
    const timestamp = this.nextTimestamp(current);
    const completed: CompanionWish = {
      ...current,
      state: 'done',
      acknowledgedAt: current.acknowledgedAt ?? timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    this.persist(completed, 'operator:personal-wishlist');
    return completed;
  }

  private persist(wish: CompanionWish, updatedBy: string): void {
    this.store.upsert({
      id: wishDocumentId(wish.id),
      title: `Wish: ${wish.text.slice(0, 80)}`,
      body: JSON.stringify(wish, null, 2),
      tags: [WISHLIST_TAG, wish.ref, `wish-state:${wish.state}`],
      sourceClass: 'companion_authored_note',
      sensitivity: 'personal',
      summary: `${wish.state}: ${wish.text}`,
      updatedBy,
    });
  }

  private nextTimestamp(current: CompanionWish): string {
    const timestamp = this.now().toISOString();
    if (timestamp.localeCompare(current.updatedAt) < 0) {
      throw new Error('wishlist clock moved backwards; refusing to persist an invalid transition');
    }
    return timestamp;
  }
}
