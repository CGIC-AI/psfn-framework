import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGardenDenialsForTests,
  getGardenDenialBucketCountForTests,
  getGardenDenialsLastHour,
  recordGardenDenial,
} from './garden-denial-observability.js';
import { resolveGardenRouteCapability } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import { fleetAuthRoleAllowsAction } from '../../boundary/fleet-auth/role-action-policy.js';

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

  it('attributes Automata authorization denials to the dedicated read action', () => {
    const logger = { warn: vi.fn() };
    const route = resolveGardenRouteCapability('GET', '/api/admin/automata');
    expect(route?.capability.authorization.action).toBe('automata.read');
    expect(fleetAuthRoleAllowsAction('admin', 'automata.read')).toBe(true);
    expect(fleetAuthRoleAllowsAction('member', 'automata.read')).toBe(false);

    recordGardenDenial(logger, {
      reasonCode: 'fleet_authorization_denied',
      status: 403,
      routeId: route?.capability.id,
      action: route?.capability.authorization.action,
      principalId: 'member-a',
    });

    expect(logger.warn).toHaveBeenCalledWith('Fleet Garden request denied', {
      reasonCode: 'fleet_authorization_denied',
      reason: 'fleet_authorization_denied',
      status: 403,
      routeId: 'GET /api/admin/automata',
      action: 'automata.read',
      principalId: 'member-a',
    });
  });
});
