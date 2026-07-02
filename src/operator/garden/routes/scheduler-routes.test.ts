import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { WakeWindowSnapshot } from '../../../core/scheduler/temporal-wakeup.js';
import type { AdminSchedulerApi } from '../admin-contract.js';
import { buildAdminSchedulerRoutes } from './scheduler-routes.js';

const WAKE_WINDOW_PATH = '/api/admin/scheduler/wake-window';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeResponse(captured: CapturedResponse): ServerResponse {
  return {
    writeHead: (status: number) => {
      captured.status = status;
    },
    end: (payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
}

function invokeWakeWindow(scheduler: AdminSchedulerApi | null): CapturedResponse {
  const routes = buildAdminSchedulerRoutes({ scheduler, withBody: () => {} });
  const route = routes.find(r => r.method === 'GET' && r.match(WAKE_WINDOW_PATH) !== null);
  expect(route).toBeDefined();
  const captured: CapturedResponse = { status: 0, body: undefined };
  route!.handle({} as IncomingMessage, fakeResponse(captured), {});
  return captured;
}

function baseSchedulerApi(overrides: Partial<AdminSchedulerApi> = {}): AdminSchedulerApi {
  return {
    listTasks: () => [],
    ...overrides,
  };
}

describe('GET /api/admin/scheduler/wake-window', () => {
  it('returns the current habit wake-window snapshot when available', () => {
    const snapshot: WakeWindowSnapshot = {
      timingMode: 'habit',
      source: 'habit',
      effective: { hour: 7, minute: 0, localTime: '07:00' },
      timeZone: 'UTC',
      window: { startLocalTime: '06:30', endLocalTime: '07:30', medianLocalTime: '07:00' },
      sampleDays: 19,
      configuredLocalTime: '08:00',
    };
    const captured = invokeWakeWindow(baseSchedulerApi({ getWakeWindow: () => snapshot }));
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ available: true, snapshot });
  });

  it('surfaces the fallback reason when the estimate is insufficient', () => {
    const snapshot: WakeWindowSnapshot = {
      timingMode: 'habit',
      source: 'habit_fallback',
      effective: { hour: 8, minute: 0, localTime: '08:00' },
      timeZone: 'UTC',
      sampleDays: 1,
      fallbackReason: 'insufficient_sample_days',
      configuredLocalTime: '08:00',
    };
    const captured = invokeWakeWindow(baseSchedulerApi({ getWakeWindow: () => snapshot }));
    expect(captured.status).toBe(200);
    expect((captured.body as { snapshot: WakeWindowSnapshot }).snapshot.fallbackReason)
      .toBe('insufficient_sample_days');
  });

  it('reports unavailable when the provider yields null', () => {
    const captured = invokeWakeWindow(baseSchedulerApi({ getWakeWindow: () => null }));
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ available: false, snapshot: null });
  });

  it('reports unavailable when the scheduler API lacks the provider', () => {
    const captured = invokeWakeWindow(baseSchedulerApi());
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ available: false, snapshot: null });
  });

  it('reports unavailable when there is no scheduler at all', () => {
    const captured = invokeWakeWindow(null);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ available: false, snapshot: null });
  });
});
