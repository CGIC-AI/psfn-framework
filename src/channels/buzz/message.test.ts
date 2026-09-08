import type { Event as NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';

import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { MESSAGE_AUTHOR_SOURCE_CLASSES } from '../../shared/contracts/message-addressing.js';
import { resolveBuzzAuthorSourceClass, toBuzzSubstrateMessage } from './message.js';

// Invented relay and keys: reserved documentation host plus obviously
// synthetic 64-hex pubkeys. Nothing here corresponds to a real Nostr identity.
const RELAY_URL = 'wss://relay.example.invalid';
const COMPANION_PUBKEY = 'a'.repeat(64);
const AUTHOR_PUBKEY = 'b'.repeat(64);

function buzzEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'c'.repeat(64),
    pubkey: AUTHOR_PUBKEY,
    created_at: 1_700_000_000,
    kind: 9,
    tags: [['h', 'room-1']],
    content: 'is anyone looking at the migration?',
    sig: 'd'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

async function translate(event: NostrEvent = buzzEvent()) {
  return await toBuzzSubstrateMessage(event, {
    relayUrl: RELAY_URL,
    companionId: 'companion-1',
    companionPubkey: COMPANION_PUBKEY,
    authorIsMachine: false,
    intakeScreening: null,
  });
}

describe('resolveBuzzAuthorSourceClass', () => {
  it('floors an unknown room author to the least-privileged chat class', () => {
    expect(resolveBuzzAuthorSourceClass(false)).toBe('public_contact');
  });

  it('answers the same DM-conditioned question Discord and Telegram answer', () => {
    // The cross-connector policy shape (psfn-framework-vprcm): the trust class
    // is a function of "is this a private conversation", never of which
    // connector translated the event. Telegram's `resolveInboundSourceClass` is
    // literally this expression; Discord's `resolveMessageSourceClass` reduces
    // to it once its operator/primary-user/sibling-bot lookups all miss.
    const telegramShaped = (isDirectMessage: boolean): string => (
      isDirectMessage ? 'regular_contact' : 'public_contact'
    );
    for (const isDirectMessage of [true, false]) {
      expect(resolveBuzzAuthorSourceClass(isDirectMessage))
        .toBe(telegramShaped(isDirectMessage));
    }
  });

  it('never returns a class outside the canonical chat-author ladder', () => {
    for (const isDirectMessage of [true, false]) {
      expect(MESSAGE_AUTHOR_SOURCE_CLASSES)
        .toContain(resolveBuzzAuthorSourceClass(isDirectMessage));
    }
  });
});

describe('toBuzzSubstrateMessage author trust class', () => {
  it('gives an unknown Buzz room author the public_contact floor', async () => {
    const message = await translate();
    expect(message.isDirectMessage).toBe(false);
    expect(message.routing?.addressing?.authorClass).toEqual({
      sourceClass: 'public_contact',
      roomRole: 'unknown',
      roomSize: 'unknown',
    });
  });

  it('passes body screening the identical class it puts on the envelope', async () => {
    // The two used to be one literal repeated twice; they must stay one value,
    // so a future trust change cannot drift the screening class away from the
    // participation class.
    const screened: string[] = [];
    const event = buzzEvent();
    const intakeScreening = {
      screen: async (text: string, input: { sourceClass: string }) => {
        screened.push(input.sourceClass);
        return { effectiveText: text, snapshot: null };
      },
    } as unknown as IntakeScreeningService;
    const message = await toBuzzSubstrateMessage(event, {
      relayUrl: RELAY_URL,
      companionId: 'companion-1',
      companionPubkey: COMPANION_PUBKEY,
      authorIsMachine: false,
      intakeScreening,
    });
    expect(screened).toEqual(['public_contact']);
    expect(message.routing?.addressing?.authorClass.sourceClass).toBe('public_contact');
  });

  it('keeps the floor for a threaded reply and for a companion mention', async () => {
    const rootId = 'e'.repeat(64);
    const parentId = 'f'.repeat(64);
    const message = await translate(buzzEvent({
      tags: [
        ['h', 'room-1'],
        ['e', rootId, RELAY_URL, 'root'],
        ['e', parentId, RELAY_URL, 'reply'],
        ['p', COMPANION_PUBKEY],
      ],
    }));
    expect(message.routing?.responseMode).toBe('respond');
    expect(message.routing?.addressing?.authorClass.sourceClass).toBe('public_contact');
  });
});
