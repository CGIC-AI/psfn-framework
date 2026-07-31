import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGardenDenialsForTests,
  getGardenDenialBucketCountForTests,
  getGardenDenialsLastHour,
  recordGardenDenial,
} from './garden-denial-observability.js';

describe('Garden denial observability', () => {
  afterEach(() => {
    clearGardenDenialsForTests();
    vi.useRealTimers();
  });

  it('logs safe structured denial context and maintains a rolling one-hour count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const logger = { warn: vi.fn() };

    recordGardenDenial(logger, {
      reasonCode: 'request_body_forbidden',
      status: 400,
      routeId: 'GET /api/admin/dashboard',
      action: 'garden.read',
    });
    recordGardenDenial(logger, {
      reasonCode: 'subject_bound_session_required',
      status: 403,
      routeId: 'GET /session-recovery',
      action: 'recovery.begin',
      principalId: 'principal-a',
    });

    expect(logger.warn).toHaveBeenNthCalledWith(1, 'Fleet Garden request denied', {
      reasonCode: 'request_body_forbidden',
      reason: 'request_body_forbidden',
      status: 400,
      routeId: 'GET /api/admin/dashboard',
      action: 'garden.read',
      principalId: 'unknown',
    });
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'Fleet Garden request denied', {
      reasonCode: 'subject_bound_session_required',
      reason: 'subject_bound_session_required',
      status: 403,
      routeId: 'GET /session-recovery',
      action: 'recovery.begin',
      principalId: 'principal-a',
    });
    expect(getGardenDenialsLastHour()).toBe(2);

    vi.advanceTimersByTime((60 * 60 * 1_000) + 1);
    expect(getGardenDenialsLastHour()).toBe(0);
  });

  it('keeps metric memory bounded independently of denial volume', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const logger = { warn: vi.fn() };

    for (let index = 0; index < 10_000; index += 1) {
      recordGardenDenial(logger, {
        reasonCode: 'capability_required',
        status: 401,
      });
    }

    expect(getGardenDenialsLastHour()).toBe(10_000);
    expect(getGardenDenialBucketCountForTests()).toBe(1);
  });
});
