import assert from 'node:assert/strict';
import test from 'node:test';
import { createRosterLoader, type RosterPageResult } from './roster-loader';

interface TestRoom {
  channelId: string;
}

interface TestMember {
  contactId: string;
}

interface Harness {
  loadRoster: (room: TestRoom, offset?: number) => Promise<void>;
  resolvers: Map<string, (result: RosterPageResult<TestMember>) => void>;
  rejecters: Map<string, (error: Error) => void>;
  state: {
    selected: TestRoom | null;
    offset: number;
    members: TestMember[];
    total: number;
    loading: boolean;
    error: string;
    errorToasts: string[];
  };
}

function makeHarness(): Harness {
  const resolvers = new Map<string, (result: RosterPageResult<TestMember>) => void>();
  const rejecters = new Map<string, (error: Error) => void>();
  const state: Harness['state'] = {
    selected: null,
    offset: 0,
    members: [],
    total: 0,
    loading: false,
    error: '',
    errorToasts: [],
  };
  const loadRoster = createRosterLoader<TestRoom, TestMember>({
    fetchRoster: (room, offset) => new Promise((resolve, reject) => {
      const key = `${room.channelId}:${offset}`;
      resolvers.set(key, resolve);
      rejecters.set(key, reject);
    }),
    onStart: (room, offset) => {
      state.selected = room;
      state.offset = offset;
      state.loading = true;
      state.error = '';
    },
    onResult: (result) => {
      state.members = result.members;
      state.total = result.total;
    },
    onError: (message) => {
      state.error = message;
      state.errorToasts.push(message);
    },
    onSettled: () => {
      state.loading = false;
    },
  });
  return { loadRoster, resolvers, rejecters, state };
}

test('a slow response for a previously selected room never overwrites the current roster', async () => {
  const harness = makeHarness();
  const roomA: TestRoom = { channelId: 'room-a' };
  const roomB: TestRoom = { channelId: 'room-b' };

  const loadA = harness.loadRoster(roomA);
  const loadB = harness.loadRoster(roomB);
  assert.equal(harness.state.selected, roomB);
  assert.equal(harness.state.loading, true);

  harness.resolvers.get('room-b:0')!({ members: [{ contactId: 'b-1' }], total: 1 });
  await loadB;
  assert.deepEqual(harness.state.members, [{ contactId: 'b-1' }]);
  assert.equal(harness.state.total, 1);
  assert.equal(harness.state.loading, false);

  // Room A's slower response arrives after room B was selected and loaded.
  harness.resolvers.get('room-a:0')!({ members: [{ contactId: 'a-1' }, { contactId: 'a-2' }], total: 2 });
  await loadA;
  assert.equal(harness.state.selected, roomB);
  assert.deepEqual(harness.state.members, [{ contactId: 'b-1' }]);
  assert.equal(harness.state.total, 1);
  assert.equal(harness.state.loading, false);
});

test('out-of-order pagination responses only apply the latest page', async () => {
  const harness = makeHarness();
  const room: TestRoom = { channelId: 'room-a' };

  const loadPage1 = harness.loadRoster(room, 50);
  const loadPage2 = harness.loadRoster(room, 100);
  assert.equal(harness.state.offset, 100);

  harness.resolvers.get('room-a:100')!({ members: [{ contactId: 'p2-1' }], total: 120 });
  await loadPage2;
  harness.resolvers.get('room-a:50')!({ members: [{ contactId: 'p1-1' }], total: 120 });
  await loadPage1;

  assert.equal(harness.state.offset, 100);
  assert.deepEqual(harness.state.members, [{ contactId: 'p2-1' }]);
  assert.equal(harness.state.loading, false);
});

test('stale request failures do not surface errors over the current selection', async () => {
  const harness = makeHarness();
  const roomA: TestRoom = { channelId: 'room-a' };
  const roomB: TestRoom = { channelId: 'room-b' };

  const loadA = harness.loadRoster(roomA);
  const loadB = harness.loadRoster(roomB);

  harness.resolvers.get('room-b:0')!({ members: [{ contactId: 'b-1' }], total: 1 });
  await loadB;
  harness.rejecters.get('room-a:0')!(new Error('roster fetch failed'));
  await loadA;

  assert.equal(harness.state.error, '');
  assert.deepEqual(harness.state.errorToasts, []);
  assert.deepEqual(harness.state.members, [{ contactId: 'b-1' }]);
  assert.equal(harness.state.loading, false);
});

test('failures of the current request still surface an error and stop loading', async () => {
  const harness = makeHarness();
  const room: TestRoom = { channelId: 'room-a' };

  const load = harness.loadRoster(room);
  harness.rejecters.get('room-a:0')!(new Error('roster fetch failed'));
  await load;

  assert.equal(harness.state.error, 'roster fetch failed');
  assert.deepEqual(harness.state.errorToasts, ['roster fetch failed']);
  assert.equal(harness.state.loading, false);
});
