import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { navItems } from '../../../admin-ui/src/lib/nav.js';
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
    const req = makeRequest('GET', '/episodic-memory');
    const res = makeResponse();
    const serveGardenPage = vi.fn();
    const serveGardenBuildAsset = vi.fn();
    const route = vi.fn(() => false);
    const sendNotFound = vi.fn();

    handleAdminRequest(req, res, {
      checkAuth: vi.fn(() => true),
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenBuildAsset,
      serveGardenPage,
      route,
      sendNotFound,
      onRequestError: vi.fn(),
    });

    expect(route).toHaveBeenCalledWith('GET', '/episodic-memory', req, res);
    expect(serveGardenPage).toHaveBeenCalledWith('/episodic-memory', res);
    expect(serveGardenBuildAsset).not.toHaveBeenCalled();
    expect(sendNotFound).not.toHaveBeenCalled();
  });

  it('serves the Garden SPA for nav-advertised client routes on direct load', () => {
    for (const { path } of navItems) {
      const req = makeRequest('GET', path);
      const res = makeResponse();
      const serveGardenPage = vi.fn();
      const serveGardenBuildAsset = vi.fn();
      const sendNotFound = vi.fn();

      handleAdminRequest(req, res, {
        checkAuth: vi.fn(() => true),
        tryServeStaticAsset: vi.fn(() => false),
        isGardenUiEnabled: vi.fn(() => true),
        serveGardenBuildAsset,
        serveGardenPage,
        route: vi.fn(() => false),
        sendNotFound,
        onRequestError: vi.fn(),
      });

      expect(serveGardenPage).toHaveBeenCalledWith(path, res);
      expect(serveGardenBuildAsset).not.toHaveBeenCalled();
      expect(sendNotFound).not.toHaveBeenCalled();
    }
  });

  it('serves the Garden SPA shell at root instead of redirecting', () => {
    const req = makeRequest('GET', '/');
    const res = makeResponse();
    const serveGardenPage = vi.fn();
    const serveGardenBuildAsset = vi.fn();

    handleAdminRequest(req, res, {
      checkAuth: vi.fn(() => true),
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenBuildAsset,
      serveGardenPage,
      route: vi.fn(() => false),
      sendNotFound: vi.fn(),
      onRequestError: vi.fn(),
    });

    expect(serveGardenPage).toHaveBeenCalledWith('/', res);
    expect(serveGardenBuildAsset).not.toHaveBeenCalled();
  });

  it('serves built Garden asset files outside the SPA fallback allowlist', () => {
    const req = makeRequest('GET', '/_app/immutable/entry/start.hash.js');
    const res = makeResponse();
    const serveGardenPage = vi.fn();
    const serveGardenBuildAsset = vi.fn();
    const sendNotFound = vi.fn();

    handleAdminRequest(req, res, {
      checkAuth: vi.fn(() => true),
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenBuildAsset,
      serveGardenPage,
      route: vi.fn(() => false),
      sendNotFound,
      onRequestError: vi.fn(),
    });

    expect(serveGardenBuildAsset).toHaveBeenCalledWith('/_app/immutable/entry/start.hash.js', res);
    expect(serveGardenPage).not.toHaveBeenCalled();
    expect(sendNotFound).not.toHaveBeenCalled();
  });

  it('allows health probes without admin auth while keeping API routes protected', () => {
    const healthReq = makeRequest('GET', '/health');
    const healthRes = makeResponse();
    const checkAuth = vi.fn(() => false);
    const route = vi.fn(() => true);

    handleAdminRequest(healthReq, healthRes, {
      token: 'secret-token',
      checkAuth,
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenBuildAsset: vi.fn(),
      serveGardenPage: vi.fn(),
      route,
      sendNotFound: vi.fn(),
      onRequestError: vi.fn(),
    });

    expect(checkAuth).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledWith('GET', '/health', healthReq, healthRes);

    const apiReq = makeRequest('GET', '/api/admin/dashboard');
    const apiRes = makeResponse();
    const protectedRoute = vi.fn(() => true);

    handleAdminRequest(apiReq, apiRes, {
      token: 'secret-token',
      checkAuth,
      tryServeStaticAsset: vi.fn(() => false),
      isGardenUiEnabled: vi.fn(() => true),
      serveGardenBuildAsset: vi.fn(),
      serveGardenPage: vi.fn(),
      route: protectedRoute,
      sendNotFound: vi.fn(),
      onRequestError: vi.fn(),
    });

    expect(checkAuth).toHaveBeenCalledWith(apiReq, apiRes);
    expect(protectedRoute).not.toHaveBeenCalled();
  });

  it('keeps non-canonical paths out of the Garden SPA fallback', () => {
    for (const path of ['/api/admin/missing', '/health', '/missing', '/missing/memory']) {
      const req = makeRequest('GET', path);
      const res = makeResponse();
      const serveGardenPage = vi.fn();
      const serveGardenBuildAsset = vi.fn();
      const sendNotFound = vi.fn();

      handleAdminRequest(req, res, {
        checkAuth: vi.fn(() => true),
        tryServeStaticAsset: vi.fn(() => false),
        isGardenUiEnabled: vi.fn(() => true),
        serveGardenBuildAsset,
        serveGardenPage,
        route: vi.fn(() => false),
        sendNotFound,
        onRequestError: vi.fn(),
      });

      expect(serveGardenPage).not.toHaveBeenCalled();
      expect(serveGardenBuildAsset).not.toHaveBeenCalled();
      expect(sendNotFound).toHaveBeenCalledWith(path, res);
    }
  });
});
