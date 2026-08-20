import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  canonicalGardenDestination,
  canonicalPlacesPath,
  resolvePlacesTab,
} from './canonical-routes';

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

test('legacy transcript links redirect to the canonical Sessions browser', () => {
  assert.equal(canonicalGardenDestination('/transcripts', '', ''), '/sessions');
  assert.equal(canonicalGardenDestination('/chat', '?tab=transcripts', ''), '/sessions');
  assert.equal(canonicalGardenDestination('/chat', '', '#transcripts'), '/sessions');
  assert.equal(
    canonicalGardenDestination(
      `/companions/${COMPANION_ID}/garden/chat`,
      '?tab=transcripts',
      '',
    ),
    `/companions/${COMPANION_ID}/garden/sessions`,
  );
  assert.equal(canonicalGardenDestination('/chat', '', ''), null);
  assert.equal(canonicalGardenDestination('/places', '?tab=virtual', ''), null);
});

test('the shared Garden layout applies canonical redirects before old surfaces can load data', () => {
  const layout = readFileSync(
    fileURLToPath(new URL('../../routes/+layout.svelte', import.meta.url)),
    'utf8',
  );

  assert.match(layout, /canonicalGardenDestination\(/u);
  assert.match(layout, /window\.location\.replace\(destination\)/u);
});
