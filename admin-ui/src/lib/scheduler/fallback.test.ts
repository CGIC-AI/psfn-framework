import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '$lib/api/errors';
import { schedulerLoadErrorMessage, shouldUseSchedulerFallback } from './fallback';

test('shouldUseSchedulerFallback only allows missing-endpoint ApiError responses', () => {
  assert.equal(shouldUseSchedulerFallback(new ApiError(404, 'Not Found')), true);
  assert.equal(shouldUseSchedulerFallback(new ApiError(401, 'Unauthorized')), false);
  assert.equal(shouldUseSchedulerFallback(new ApiError(500, 'Internal Server Error')), false);
});

test('shouldUseSchedulerFallback rejects network and non-ApiError failures', () => {
  assert.equal(shouldUseSchedulerFallback(new TypeError('Failed to fetch')), false);
  assert.equal(shouldUseSchedulerFallback(new Error('socket hang up')), false);
  assert.equal(
    shouldUseSchedulerFallback({ status: 404, statusText: 'Not Found' }),
    false,
  );
});

test('schedulerLoadErrorMessage preserves explicit error messages', () => {
  assert.equal(schedulerLoadErrorMessage(new Error('Failed to fetch')), 'Failed to fetch');
  assert.equal(schedulerLoadErrorMessage('unexpected'), 'Failed to load scheduler data');
});
