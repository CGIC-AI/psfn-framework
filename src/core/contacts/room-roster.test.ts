import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';

// ── Room roster (E4.1) ──
// Bounded known-members queries over contact_channel_activity. These prove:
//   - membership (incl. members who have NOT spoken recently: old activity row)
//   - last-seen-desc ordering + limit/offset pagination
//   - the query is bounded — a large contact table never inflates a roster page,
//     and the result is the roster projection, not a full hydrated Contact.

const PRIMARY_USER_ID = 'primary-1';

function setActivityTimestamps(
  db: Database.Database,
  contactId: string,
  channelId: string,
  firstSeen: string,
  lastSeen: string,
): void {
  db.prepare(
    'UPDATE contact_channel_activity SET first_seen = ?, last_seen = ? WHERE contact_id = ? AND channel_id = ?',
  ).run(firstSeen, lastSeen, contactId, channelId);
}

describe('ContactStore room roster', () => {
  let db: Database.Database;
  let store: ContactStore;

  const ROOM_X = 'discord:room-x';
  const ROOM_Y = 'discord:room-y';

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);

    const alice = store.upsert({ displayName: 'Alice', trustLevel: 'trusted', relationshipType: 'friend' });
    const bob = store.upsert({ displayName: 'Bob', trustLevel: 'regular', relationshipType: 'acquaintance' });
    const carol = store.upsert({ displayName: 'Carol', trustLevel: 'regular', relationshipType: 'stranger' });
    const dave = store.upsert({ displayName: 'Dave', trustLevel: 'trusted', relationshipType: 'friend' });

    // Room X: three known members.
    store.recordChannelActivity(alice.id, 'discord', ROOM_X, 'invite_only');
    store.recordChannelActivity(bob.id, 'discord', ROOM_X, 'invite_only');
    store.recordChannelActivity(carol.id, 'discord', ROOM_X, 'invite_only');
    // Deterministic activity timeline: Carol newest, Alice middle, Bob oldest
    // (Bob has NOT spoken recently, but is still a known member — must appear).
    setActivityTimestamps(db, bob.id, ROOM_X, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    setActivityTimestamps(db, alice.id, ROOM_X, '2024-03-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');
    setActivityTimestamps(db, carol.id, ROOM_X, '2024-05-01T00:00:00.000Z', '2024-07-01T00:00:00.000Z');

    // Room Y: single member, most recent overall activity.
    store.recordChannelActivity(dave.id, 'discord', ROOM_Y, 'private');
    setActivityTimestamps(db, dave.id, ROOM_Y, '2024-08-01T00:00:00.000Z', '2024-08-01T00:00:00.000Z');

    // Contacts with NO room activity — must never inflate a roster (bounded).
    for (let i = 0; i < 25; i += 1) {
      store.upsert({ displayName: `Noise ${i}`, trustLevel: 'regular', relationshipType: 'stranger' });
    }
  });

  it('lists known rooms with member counts, ordered by last activity desc', () => {
    const rooms = store.listKnownRooms();
    expect(rooms.map(r => r.channelId)).toEqual([ROOM_Y, ROOM_X]);
    const roomX = rooms.find(r => r.channelId === ROOM_X);
    expect(roomX).toMatchObject({ channel: 'discord', memberCount: 3, lastActivity: '2024-07-01T00:00:00.000Z' });
    expect(roomX?.firstActivity).toBe('2020-01-01T00:00:00.000Z');
    expect(store.countKnownRooms()).toBe(2);
  });

  it('returns roster ordered by last-seen desc including members who have not spoken recently', () => {
    const roster = store.listRoomRoster(ROOM_X);
    expect(roster.map(m => m.displayName)).toEqual(['Carol', 'Alice', 'Bob']);
    // Bob's row is old but present.
    const bob = roster.find(m => m.displayName === 'Bob');
    expect(bob?.lastSeen).toBe('2020-01-01T00:00:00.000Z');
    // Joined contact columns are present.
    expect(roster.find(m => m.displayName === 'Alice')).toMatchObject({
      trustLevel: 'trusted',
      relationshipType: 'friend',
      channel: 'discord',
      channelId: ROOM_X,
      privacyLevel: 'invite_only',
    });
  });

  it('paginates the roster with limit/offset and reports total via count', () => {
    expect(store.countRoomRoster(ROOM_X)).toBe(3);
    const page1 = store.listRoomRoster(ROOM_X, { limit: 2, offset: 0 });
    expect(page1.map(m => m.displayName)).toEqual(['Carol', 'Alice']);
    const page2 = store.listRoomRoster(ROOM_X, { limit: 2, offset: 2 });
    expect(page2.map(m => m.displayName)).toEqual(['Bob']);
  });

  it('is bounded: only room members appear and the projection is not a full Contact', () => {
    const roster = store.listRoomRoster(ROOM_X);
    // 25 noise contacts + Dave (room Y) exist but never appear in room X.
    expect(roster).toHaveLength(3);
    // Roster projection carries only the columns the surface needs — NOT the
    // hydrated Contact shape (no channelIdentities / conversationChannels).
    const sample = roster[0] as Record<string, unknown>;
    expect(sample).not.toHaveProperty('channelIdentities');
    expect(sample).not.toHaveProperty('conversationChannels');
    expect(Object.keys(sample).sort()).toEqual(
      ['channel', 'channelId', 'contactId', 'displayName', 'firstSeen', 'lastSeen', 'privacyLevel', 'relationshipType', 'trustLevel'].sort(),
    );
  });

  it('respects the channel filter when channelIds could collide across channels', () => {
    const other = store.upsert({ displayName: 'Eve', trustLevel: 'regular', relationshipType: 'stranger' });
    // Same bare channelId string under a different channel namespace.
    store.recordChannelActivity(other.id, 'telegram', ROOM_X, 'invite_only');
    expect(store.countRoomRoster(ROOM_X)).toBe(4); // both channels share the id
    expect(store.countRoomRoster(ROOM_X, { channel: 'discord' })).toBe(3);
    const discordOnly = store.listRoomRoster(ROOM_X, { channel: 'discord' });
    expect(discordOnly.every(m => m.channel === 'discord')).toBe(true);
  });
});
