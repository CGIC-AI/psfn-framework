import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetModelUsageData } from '../services/fleet-model-usage-service.js';
import { handleFleetModelUsageRoute } from './fleet-model-usage-routes.js';

class CapturingResponse {
  status = 0;
  body = '';

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

describe('fleet model-usage route', () => {
  it('parses the bounded fleet range query and returns the service payload', async () => {
    const payload = {
      resolvedRange: {
        range: 'custom', timezone: 'UTC', sinceMs: 10, untilMs: 20, bucket: 'hour',
        boundary: '[sinceMs, untilMs)', calendarWeekStartsOn: 'monday',
      },
      totals: null,
      perCompanion: [],
      timeSeries: [],
      coverage: { available: 0, unavailable: 1, complete: false },
    } as FleetModelUsageData;
    const getFleetModelUsage = vi.fn(async () => payload);
    const request = {
      url: '/api/admin/fleet-model-usage?range=custom&timezone=UTC&sinceMs=10&untilMs=20&bucket=hour',
      headers: {},
    } as IncomingMessage;
    const response = new CapturingResponse();

    handleFleetModelUsageRoute(
      request,
      response as unknown as ServerResponse,
      { getFleetModelUsage },
    );
    await vi.waitFor(() => expect(response.body).not.toBe(''));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(payload);
    expect(getFleetModelUsage).toHaveBeenCalledWith({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 10,
      untilMs: 20,
      bucket: 'hour',
    });
  });

  it('rejects detail filters that do not belong on the fleet aggregate', () => {
    const response = new CapturingResponse();
    const getFleetModelUsage = vi.fn();

    handleFleetModelUsageRoute(
      { url: '/api/admin/fleet-model-usage?model=private-model', headers: {} } as IncomingMessage,
      response as unknown as ServerResponse,
      { getFleetModelUsage },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Fleet model usage supports only range, timezone, sinceMs, untilMs, and bucket query parameters.',
    });
    expect(getFleetModelUsage).not.toHaveBeenCalled();
  });
});
