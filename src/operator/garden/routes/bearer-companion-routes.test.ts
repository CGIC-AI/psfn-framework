import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { GardenRequestContext } from '../garden-request-context.js';
import type { AdminSettingsService } from '../services/types.js';
import { buildAdminBearerCompanionRoutes } from './bearer-companion-routes.js';

class CapturingResponse {
  statusCode = 0;
  body = '';

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
  }
}

const requestBoundCompanionId = '11111111-1111-4111-8111-111111111111';

function requestContext(): GardenRequestContext {
  return {
    resource: { companionId: requestBoundCompanionId },
  } as unknown as GardenRequestContext;
}

function postRoute(service: Partial<AdminSettingsService>) {
  const route = buildAdminBearerCompanionRoutes({
    settingsService: service as AdminSettingsService,
  }).find(candidate => candidate.method === 'POST');
  if (!route) throw new Error('Bearer companion POST route is missing');
  return route;
}

describe('Bearer API companion pin route', () => {
  it('pins only the companion bound by the trusted request context', () => {
    const setBearerApiCompanionPin = vi.fn().mockReturnValue({
      ok: true,
      message: 'Pinned',
    });
    const getBearerApiCompanionPin = vi.fn().mockReturnValue({
      pinnedCompanionId: requestBoundCompanionId,
      companions: [],
      restartRequired: true,
    });
    const route = postRoute({ setBearerApiCompanionPin, getBearerApiCompanionPin });
    const response = new CapturingResponse();

    route.handle(
      {} as IncomingMessage,
      response as unknown as ServerResponse,
      {},
      requestContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(setBearerApiCompanionPin).toHaveBeenCalledWith(requestBoundCompanionId);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      data: { pinnedCompanionId: requestBoundCompanionId },
    });
  });

  it('fails closed when no authoritative companion context exists', () => {
    const setBearerApiCompanionPin = vi.fn();
    const route = postRoute({ setBearerApiCompanionPin });
    const response = new CapturingResponse();

    route.handle(
      {} as IncomingMessage,
      response as unknown as ServerResponse,
      {},
    );

    expect(response.statusCode).toBe(403);
    expect(setBearerApiCompanionPin).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toEqual({
      error: 'Companion-bound request context is required',
    });
  });
});
