import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAdminRequest } from './server-request-routing.js';

function makeRequest(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: {
      host: 'garden.local',
    },
  } as IncomingMessage;
}

function makeResponse(): ServerResponse {
  return {} as ServerResponse;
}

describe('handleAdminRequest', () => {
  it('serves the Garden SPA for canonical root-served client routes', () => {
    const req = makeRequest('GET', '/memory');
    const res = makeResponse();
    const serveGardenAsset = vi.fn();
    const route = vi.fn(() => false);
    const sendNotFound = vi.fn();

    handleAdminRequest(req, res, {
      checkAuth: vi.fn(() => true),
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenAsset,
      route,
      sendNotFound,
      onRequestError: vi.fn(),
    });

    expect(route).toHaveBeenCalledWith('GET', '/memory', req, res);
    expect(serveGardenAsset).toHaveBeenCalledWith('/memory', res);
    expect(sendNotFound).not.toHaveBeenCalled();
  });

  it('serves the Garden SPA shell at root instead of redirecting', () => {
    const req = makeRequest('GET', '/');
    const res = makeResponse();
    const serveGardenAsset = vi.fn();

    handleAdminRequest(req, res, {
      checkAuth: vi.fn(() => true),
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenAsset,
      route: vi.fn(() => false),
      sendNotFound: vi.fn(),
      onRequestError: vi.fn(),
    });

    expect(serveGardenAsset).toHaveBeenCalledWith('/', res);
  });

  it('keeps non-canonical paths out of the Garden SPA fallback', () => {
    for (const path of ['/api/admin/missing', '/health', '/missing', '/missing/memory']) {
      const req = makeRequest('GET', path);
      const res = makeResponse();
      const serveGardenAsset = vi.fn();
      const sendNotFound = vi.fn();

      handleAdminRequest(req, res, {
        checkAuth: vi.fn(() => true),
        tryServeStaticAsset: vi.fn(() => false),
        isGardenUiEnabled: vi.fn(() => true),
        serveGardenAsset,
        route: vi.fn(() => false),
        sendNotFound,
        onRequestError: vi.fn(),
      });

      expect(serveGardenAsset).not.toHaveBeenCalled();
      expect(sendNotFound).toHaveBeenCalledWith(path, res);
    }
  });
});
