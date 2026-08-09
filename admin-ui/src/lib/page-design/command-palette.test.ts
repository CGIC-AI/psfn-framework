import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  OPEN_COMMAND_PALETTE_EVENT,
  requestCommandPalette,
} from './command-palette';

test('requests the shared command palette through the window event contract', () => {
  const target = new EventTarget();
  let requests = 0;
  target.addEventListener(OPEN_COMMAND_PALETTE_EVENT, () => {
    requests += 1;
  });

  assert.equal(requestCommandPalette(target), true);
  assert.equal(requests, 1);
});
