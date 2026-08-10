import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  apiDelete: vi.fn(),
  apiFetch: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  throwIfNotOk: async (res: Response) => {
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  },
}));

import { apiPost as apiPostImport } from '$lib/api/client';
import { revealMemoryEscalated } from './memory.js';

const apiPost = vi.mocked(apiPostImport);

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = 'mem-42';
const CSRF_TOKEN = 'a'.repeat(43);

function stubCompanionGardenRoute(pathname = `/companions/${COMPANION_A}/garden/memory`): void {
  vi.stubGlobal('window', { location: { pathname } });
}

function csrfResponse(token: unknown = CSRF_TOKEN): Response {
  return new Response(JSON.stringify({ csrfToken: token }), { status: 200 });
}

function grantResponse(): Response {
  return new Response(JSON.stringify({
    grantId: '22222222-2222-4222-8222-222222222222',
    routeId: 'memory.reveal',
    expiresAt: new Date(0).toISOString(),
  }), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => await callback(),
    },
  });
  apiPost.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('revealMemoryEscalated', () => {
  it('mints one audited grant for the exact reveal route and spends it on the reveal', async () => {
    stubCompanionGardenRoute();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(grantResponse());
    vi.stubGlobal('fetch', fetchMock);
    apiPost.mockResolvedValue({ memory: { id: MEMORY_ID }, scopeAssignments: [] });

    await expect(revealMemoryEscalated(MEMORY_ID, '  reviewing a welfare report  '))
      .resolves.toMatchObject({ memory: { id: MEMORY_ID } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/fleet-auth/session/csrf');
    const [grantPath, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(grantPath).toBe('/v1/fleet-auth/escalation/grant');
    expect(grantInit.credentials).toBe('include');
    expect((grantInit.headers as Record<string, string>)['X-PSFN-CSRF']).toBe(CSRF_TOKEN);
    expect(JSON.parse(String(grantInit.body))).toEqual({
      companionId: COMPANION_A,
      method: 'POST',
      target: `/api/admin/memory/${MEMORY_ID}/reveal`,
      reason: 'reviewing a welfare report',
    });
    expect(apiPost).toHaveBeenCalledWith(
      `/api/admin/memory/${MEMORY_ID}/reveal`,
      { reason: 'reviewing a welfare report' },
      {
        headers: { 'x-psfn-escalation-grant': '22222222-2222-4222-8222-222222222222' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('refuses a blank or control-character reason before any ceremony runs', async () => {
    stubCompanionGardenRoute();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revealMemoryEscalated(MEMORY_ID, '   ')).rejects.toThrow(/escalation reason/u);
    await expect(revealMemoryEscalated(MEMORY_ID, 'bad' + String.fromCharCode(7) + 'reason'))
      .rejects.toThrow(/escalation reason/u);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('refuses to escalate outside an authorized companion Garden route', async () => {
    stubCompanionGardenRoute('/memory');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revealMemoryEscalated(MEMORY_ID, 'reviewing a welfare report'))
      .rejects.toThrow(/authorized companion Garden route/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed CSRF token', async () => {
    stubCompanionGardenRoute();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(csrfResponse('short')));

    await expect(revealMemoryEscalated(MEMORY_ID, 'reviewing a welfare report'))
      .rejects.toThrow(/ceremony unavailable/u);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('surfaces the gateway refusal verbatim and never reveals without a grant', async () => {
    stubCompanionGardenRoute();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(new Response('Escalation reason is invalid', { status: 400 })));

    await expect(revealMemoryEscalated(MEMORY_ID, 'reviewing a welfare report'))
      .rejects.toThrow(/Escalation reason is invalid/u);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('fails closed when the grant response carries no grant id', async () => {
    stubCompanionGardenRoute();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ routeId: 'memory.reveal' }), { status: 200 })));

    await expect(revealMemoryEscalated(MEMORY_ID, 'reviewing a welfare report'))
      .rejects.toThrow(/grant response is malformed/u);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
