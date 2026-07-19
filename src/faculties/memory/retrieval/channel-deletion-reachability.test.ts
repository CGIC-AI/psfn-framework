import { describe, expect, it } from 'vitest';
import type { PurrMemory, RetrievalAccessScope } from '../types.js';
import { memoryMatchesScopeQuery } from '../types.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import { evaluateRetrievalAccessDecision } from './access.js';

/**
 * Regression coverage for the ratified channel-deletion / archive semantics
 * (free-time social-autonomy adjudication S11, R10.2/R10.3):
 *
 *   "Channel deletion: memories and artifacts survive and remain accessible."
 *   Room-bound artifacts become unshareable-for-lack-of-audience, not lost, and
 *   nothing about deletion rewrites L0/L2. Contacts are archived, never deleted;
 *   their memories and gates persist.
 *
 * The historical bug this pins against: retrieval that required the source
 * channel to still be active, so deleting a channel silently stranded its
 * memories. These tests codify that reachability is NEVER a function of whether
 * the source channel still exists — the only exclusion levers are explicit
 * soft-delete / supersession (enforced at the store), the opt-in focus
 * scope-query, and audience-disclosure gates (which are about who may be told,
 * not whether the companion can reach the memory).
 */

const PRIMARY_CONTACT_ID = 'contact-primary';
const PRIMARY_DM_ID = 'discord:dm:primary';
const DELETED_ROOM_ID = 'discord:guild:deleted-room';

const COMPANION_SELF_ACCESS_SCOPES = [
  'companion_self_creation',
  'companion_self_reflection',
] satisfies readonly RetrievalAccessScope[];

function storedMemory(id: string, channelId: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `memory ${id}`,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: `${channelId}:msg-${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 1,
    tags: ['test'],
    sensitivity: 'personal',
    provenance: { channelId },
    ...overrides,
  };
}

function memory(
  overrides: Partial<Pick<
    PurrMemory,
    | 'sensitivity'
    | 'contactId'
    | 'consentFlags'
    | 'tags'
    | 'provenance'
    | 'scopeRef'
    | 'scopeTags'
  >> = {},
): Pick<
  PurrMemory,
  | 'sensitivity'
  | 'contactId'
  | 'consentFlags'
  | 'tags'
  | 'provenance'
  | 'scopeRef'
  | 'scopeTags'
> {
  return {
    sensitivity: 'personal',
    tags: [],
    ...overrides,
  };
}

describe('channel-deletion memory reachability (adjudication S11/R10.2)', () => {
  describe('store scope-query layer', () => {
    // A memory bound to a now-deleted channel/room. Deleting the channel does
    // not touch the memory's scope metadata.
    const deletedChannelMemory = {
      scopeRef: { kind: 'conversation', id: DELETED_ROOM_ID } as const,
      scopeTags: ['room_context', `channel:${DELETED_ROOM_ID}`],
    };

    it('reaches a deleted-channel memory on the default (no scope query) path', () => {
      // Normal turns pass no scope query unless a focus session is active, so
      // the store applies no scope filter at all — the source channel being
      // gone is irrelevant.
      expect(memoryMatchesScopeQuery(deletedChannelMemory, undefined)).toBe(true);
      expect(memoryMatchesScopeQuery(deletedChannelMemory, { refs: [], tags: [] })).toBe(true);
    });

    it('never treats a deleted source channel as its own exclusion lever', () => {
      // The only way scope filtering can drop this memory is an explicit,
      // caller-supplied focus scope that names a DIFFERENT scope in only-mode.
      // That is the opt-in focus feature, not channel liveness: an active room
      // scope still reaches it, and a non-matching only-scope excludes it the
      // same way it would for a live channel.
      expect(memoryMatchesScopeQuery(deletedChannelMemory, {
        refs: [{ kind: 'conversation', id: DELETED_ROOM_ID }],
        mode: 'only',
      })).toBe(true);
      expect(memoryMatchesScopeQuery(deletedChannelMemory, {
        refs: [{ kind: 'conversation', id: 'discord:guild:some-other-room' }],
        mode: 'only',
      })).toBe(false);
    });
  });

  describe('store retrieval layer (positive proof)', () => {
    // The store has no channels table and no FK from a memory row to a channel
    // row, so "deleting a channel" is, at the persistence layer, simply the
    // absence of any live reference to that channel id. The memory row is
    // untouched. These tests assert retrieval still returns it — the fix that
    // the operator recalls is structural: reachability was decoupled from
    // channel liveness, and this pins it so a regression can't re-couple them.
    const DELETED_CHANNEL = 'discord:guild:deleted-room';

    it('still returns a deleted-channel memory from getMemoriesByChannel and listActiveMemories', () => {
      const store = new InMemoryMemoryStore();
      store.insertMemory(storedMemory('mem-deleted', DELETED_CHANNEL));

      // No "is this channel still active?" precondition exists to fail: the
      // memory is reachable by channel lookup and in the general active set.
      expect(store.getMemoriesByChannel(DELETED_CHANNEL, 10).map(m => m.id)).toEqual(['mem-deleted']);
      expect(store.listActiveMemories().map(m => m.id)).toContain('mem-deleted');
    });

    it('only excludes the memory when it is explicitly soft-deleted, never on channel deletion', () => {
      const store = new InMemoryMemoryStore();
      store.insertMemory(storedMemory('mem-live', DELETED_CHANNEL));

      // Sanity: reachable before any tombstone.
      expect(store.getMemoriesByChannel(DELETED_CHANNEL, 10)).toHaveLength(1);

      // The ONLY lever that removes it is an explicit memory-level soft-delete,
      // which channel deletion does not trigger.
      const version = store.softDeleteMemory('mem-live', { reason: 'test' });
      expect(version).not.toBeNull();
      expect(store.getMemoriesByChannel(DELETED_CHANNEL, 10)).toHaveLength(0);
      expect(store.listActiveMemories().map(m => m.id)).not.toContain('mem-live');
    });
  });

  describe('access-gate layer', () => {
    it.each(COMPANION_SELF_ACCESS_SCOPES)(
      'lets the companion recall her own room-bound memory after the room is deleted (%s)',
      (accessScope) => {
        const decision = evaluateRetrievalAccessDecision(
          memory({
            sensitivity: 'intimate',
            provenance: { channelId: DELETED_ROOM_ID },
            scopeRef: { kind: 'conversation', id: DELETED_ROOM_ID },
            scopeTags: ['room_context'],
          }),
          {
            accessScope,
            trustLevel: 'regular',
            channelPrivacy: 'public',
            broadcast: true,
            canonicalContactId: PRIMARY_CONTACT_ID,
            // Current surface is not (and can never again be) the deleted room.
            roomVisibility: {
              currentChannelId: 'internal:free-time:studio',
              currentIsDirectMessage: false,
            },
          },
        );

        expect(decision).toEqual({ allowed: true });
      },
    );

    it('lets the primary partner recall their own memory from a deleted channel in their DM', () => {
      const decision = evaluateRetrievalAccessDecision(
        memory({
          contactId: PRIMARY_CONTACT_ID,
          provenance: { channelId: DELETED_ROOM_ID },
        }),
        {
          trustLevel: 'primary',
          channelPrivacy: 'private',
          broadcast: false,
          canonicalContactId: PRIMARY_CONTACT_ID,
          roomVisibility: {
            currentChannelId: PRIMARY_DM_ID,
            currentIsDirectMessage: true,
            canonicalContactRoomIds: new Set([PRIMARY_DM_ID]),
          },
        },
      );

      expect(decision).toEqual({ allowed: true });
    });

    it('keeps a deleted other-room memory unshareable to a third party, not resurrected', () => {
      // "Unshareable-for-lack-of-audience, not lost": deletion must not loosen
      // disclosure either. A room-bound intimate memory from a now-deleted room
      // owned by someone else is still withheld when surfaced in a different
      // live room. The memory survives (companion can still reach it above);
      // what is gone is the audience it could be shared with.
      const decision = evaluateRetrievalAccessDecision(
        memory({
          sensitivity: 'intimate',
          contactId: 'contact-other',
          provenance: { channelId: DELETED_ROOM_ID, sourceContactId: 'contact-other' },
          scopeRef: { kind: 'conversation', id: DELETED_ROOM_ID },
          scopeTags: ['room_context'],
        }),
        {
          trustLevel: 'regular',
          channelPrivacy: 'public',
          broadcast: true,
          canonicalContactId: PRIMARY_CONTACT_ID,
          roomVisibility: {
            currentChannelId: 'discord:guild:current-room',
            currentIsDirectMessage: false,
          },
        },
      );

      expect(decision).toEqual({
        allowed: false,
        rejectionKind: 'room_visibility',
        withheldReason: 'room_visibility.blocked',
      });
    });
  });
});
