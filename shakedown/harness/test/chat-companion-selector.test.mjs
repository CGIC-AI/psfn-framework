// cx97d: every harness-bearer chat dispatch on a fleet run carries the
// companion selector, so a follower-targeted Layer A never lands on the
// pinned primary. Behavioural checks for the dispatch helpers, plus a source
// scan that fails if any chat path bypasses them.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareCaseChatDispatch } from '../lib/case-dispatch-auth.mjs';
import { COMPANION_SELECTOR_HEADER } from '../lib/probe.mjs';

const FOLLOWER = '22222222-2222-4222-8222-222222222222';
const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

function dispatch(overrides = {}) {
  return prepareCaseChatDispatch({
    defaultApiKey: 'harness-key',
    defaultApiUserId: 'testing-harness',
    sessionId: 'session-1',
    extraHeaders: { 'x-testing-harness-run-id': 'run-1' },
    companionId: FOLLOWER,
    ...overrides,
  });
}

test('chatCase dispatches under the harness bearer carry the selector on every attempt', () => {
  const prepared = dispatch({
    extraHeaders: { 'X-PSFN-Companion-ID': '11111111-1111-4111-8111-111111111111' },
    resolveAttemptHeaders: () => ({ 'X-PSFN-Hub-Device-Assertion': 'a.b.c' }),
  });
  assert.equal(prepared.headers[COMPANION_SELECTOR_HEADER], FOLLOWER);
  assert.equal(prepared.headers['X-PSFN-Companion-ID'], undefined, 'a case cannot retarget its dispatch');
  assert.equal(prepared.resolveHeaders()[COMPANION_SELECTOR_HEADER], FOLLOWER);
});

test('a satellite-credential dispatch never carries the harness selector', () => {
  const prepared = dispatch({
    resolveDispatchAuth: () => ({ apiKey: 'satellite-key', apiUserId: 'satellite-user' }),
  });
  assert.equal(prepared.headers[COMPANION_SELECTOR_HEADER], undefined);
  assert.equal(prepared.headers.Authorization, 'Bearer satellite-key');
});

test('the pinned local target sends no selector; a malformed companion fails closed', () => {
  assert.equal(dispatch({ companionId: null }).headers[COMPANION_SELECTOR_HEADER], undefined);
  assert.throws(() => dispatch({ companionId: 'vega' }), /RFC 4122/);
});

function harnessSources(dir = HARNESS_ROOT) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ['test', 'node_modules'].includes(name) ? [] : harnessSources(path);
    }
    return path.endsWith('.mjs') ? [path] : [];
  });
}

test('no harness chat path bypasses the selector-binding dispatch helpers', () => {
  const selectorBinders = new Set(['lib/probe.mjs', 'lib/case-dispatch-auth.mjs']);
  // Local-only bootstrap (bootstrap-local.mjs): the pinned target has no selector.
  const localOnly = new Set(['lib/bootstrap-services.mjs']);
  for (const file of harnessSources()) {
    const rel = relative(HARNESS_ROOT, file);
    const source = readFileSync(file, 'utf8');
    if (!selectorBinders.has(rel)) {
      assert.doesNotMatch(source, /\bbuildChatHeaders\b/u, `${rel} must dispatch through a selector-binding helper`);
    }
    if (rel === 'live-system-shakedown.mjs') {
      const builders = source.split('createChatHeaderBuilder(').slice(1);
      assert.ok(builders.length > 0);
      for (const call of builders) {
        assert.match(call.slice(0, 400), /companionId/u, 'the case chat-header builder binds COMPANION_ID');
      }
      const dispatches = source.split('prepareCaseChatDispatch(').slice(1);
      assert.ok(dispatches.length > 0);
      for (const call of dispatches) {
        assert.match(call.slice(0, 800), /companionId: CONFIG\.companionId/u, 'chatCase binds COMPANION_ID');
      }
    } else if (!localOnly.has(rel) && !selectorBinders.has(rel)) {
      assert.doesNotMatch(source, /createChatHeaderBuilder\(|prepareCaseChatDispatch\(/u, `${rel} builds its own chat headers`);
    }
  }
  const bootstrapUsers = harnessSources()
    .filter((file) => readFileSync(file, 'utf8').includes('bootstrap-services.mjs'))
    .map((file) => relative(HARNESS_ROOT, file));
  assert.deepEqual(bootstrapUsers, ['bootstrap-local.mjs']);
});
