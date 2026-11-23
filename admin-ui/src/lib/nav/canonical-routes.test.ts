import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  canonicalConversationsPath,
  canonicalGardenDestination,
  canonicalPlacesPath,
  resolveConversationsTab,
  resolvePlacesTab,
} from './canonical-routes';

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('Conversations tabs have canonical, directly addressable URLs', () => {
  assert.equal(resolveConversationsTab(new URLSearchParams()), 'live');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=live')), 'live');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=sessions')), 'sessions');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=recovery')), 'recovery');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=unknown')), 'live');
  assert.equal(canonicalConversationsPath('live'), '/chat');
  assert.equal(canonicalConversationsPath('sessions'), '/chat?tab=sessions');
  assert.equal(canonicalConversationsPath('recovery'), '/chat?tab=recovery');
});

test('Places tabs have canonical, directly addressable URLs', () => {
  assert.equal(resolvePlacesTab(new URLSearchParams()), 'physical');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=virtual')), 'virtual');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=satellites')), 'satellites');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=unknown')), 'physical');
  assert.equal(canonicalPlacesPath('physical'), '/places');
  assert.equal(canonicalPlacesPath('virtual'), '/places?tab=virtual');
  assert.equal(canonicalPlacesPath('satellites'), '/places?tab=satellites');
});

test('legacy location pages redirect to their corresponding Places tab', () => {
  assert.equal(canonicalGardenDestination('/rooms', '', ''), '/places?tab=virtual');
  assert.equal(canonicalGardenDestination('/satellites', '', ''), '/places?tab=satellites');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/rooms`, '', ''),
    `/companions/${COMPANION_ID}/garden/places?tab=virtual`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/satellites`, '', ''),
    `/companions/${COMPANION_ID}/garden/places?tab=satellites`,
  );
});

test('legacy conversation, session, and model-room links redirect to unified Conversations tabs', () => {
  assert.equal(canonicalGardenDestination('/model-room', '', ''), '/chat');
  assert.equal(canonicalGardenDestination('/sessions', '', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/session-recovery', '', ''), '/chat?tab=recovery');
  assert.equal(canonicalGardenDestination('/transcripts', '', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/chat', '?tab=transcripts', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/chat', '', '#transcripts'), '/chat?tab=sessions');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/model-room`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/sessions`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat?tab=sessions`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/session-recovery`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat?tab=recovery`,
  );
  assert.equal(
    canonicalGardenDestination(
      `/companions/${COMPANION_ID}/garden/chat`,
      '?tab=transcripts',
      '',
    ),
    `/companions/${COMPANION_ID}/garden/chat?tab=sessions`,
  );
  assert.equal(canonicalGardenDestination('/chat', '', ''), null);
  assert.equal(canonicalGardenDestination('/chat', '?tab=sessions', ''), null);
  assert.equal(canonicalGardenDestination('/chat', '?tab=recovery', ''), null);
  assert.equal(canonicalGardenDestination('/places', '?tab=virtual', ''), null);
});

test('the shared Garden layout applies canonical redirects before old surfaces can load data', () => {
  const layout = readFileSync(
    fileURLToPath(new URL('../../routes/+layout.svelte', import.meta.url)),
    'utf8',
  );

  assert.match(layout, /canonicalGardenDestination\(\s*gardenPathname,/u);
  assert.match(layout, /window\.location\.replace\(destination\)/u);
});
