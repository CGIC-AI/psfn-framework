import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSessionRecoveryInitialLoader } from './initial-loader';

interface TestRoute {
  sourceChannelId: string;
}

interface TestChannel {
  channelId: string;
}

interface TestCogSecEvent {
  id: string;
}

test('initial session recovery load fetches routes and exits loading', async () => {
  const calls: string[] = [];
  const state = {
    routes: [] as TestRoute[],
    channels: [] as TestChannel[],
    events: [] as TestCogSecEvent[],
    selectedSourceChannelId: '',
    loading: true,
    error: 'stale error',
  };
  const load = createSessionRecoveryInitialLoader<TestRoute, TestChannel, TestCogSecEvent>({
    fetchRoutes: async () => {
      calls.push('routes');
      return {
        routes: [{ sourceChannelId: 'discord:room-1' }],
        channels: [{ channelId: 'discord:room-1' }],
      };
    },
    fetchCogSecEvents: async () => {
      calls.push('cogsec');
      return { events: [{ id: 'event-1' }] };
    },
    getSelectedSourceChannelId: () => state.selectedSourceChannelId,
    onStart: () => {
      state.loading = true;
      state.error = '';
    },
    onRoutes: (data) => {
      state.routes = data.routes;
      state.channels = data.channels;
    },
    onCogSecEvents: (events) => {
      state.events = events;
    },
    onSelectSourceChannelId: (sourceChannelId) => {
      state.selectedSourceChannelId = sourceChannelId;
    },
    onError: (message) => {
      state.error = message;
    },
    onSettled: () => {
      state.loading = false;
    },
  });

  await load();

  assert.deepEqual(calls, ['routes', 'cogsec']);
  assert.deepEqual(state.routes, [{ sourceChannelId: 'discord:room-1' }]);
  assert.deepEqual(state.channels, [{ channelId: 'discord:room-1' }]);
  assert.deepEqual(state.events, [{ id: 'event-1' }]);
  assert.equal(state.selectedSourceChannelId, 'discord:room-1');
  assert.equal(state.error, '');
  assert.equal(state.loading, false);
});

test('session recovery route wires the initial loader to onMount', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf-8');
  assert.match(source, /onMount\(\(\) => \{\s*void loadRoutes\(\);\s*\}\);/s);
});
