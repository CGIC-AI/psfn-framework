import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  throwIfNotOk: async (res: Response) => {
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  },
}));

import { apiPost as apiPostImport } from '$lib/api/client';
import {
  confirmIntakeQuarantineDecision,
  decideIntakeQuarantine,
} from './intake.js';

const apiPost = vi.mocked(apiPostImport);

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = 'env-42';
const CSRF_TOKEN = 'a'.repeat(43);

function stubCompanionGardenRoute(pathname = `/companions/${COMPANION_A}/garden/cognitive-security/approvals`): void {
  vi.stubGlobal('window', { location: { pathname } });
}

function csrfResponse(token: unknown = CSRF_TOKEN): Response {
  return new Response(JSON.stringify({ csrfToken: token }), { status: 200 });
}

function grantResponse(routeId: string): Response {
  return new Response(JSON.stringify({
    grantId: '22222222-2222-4222-8222-222222222222',
    routeId,
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

describe('confirmIntakeQuarantineDecision', () => {
  it('mints one audited grant for the exact confirm route and spends it on the confirm', async () => {
    stubCompanionGardenRoute();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(grantResponse('cogsec.manage'));
    vi.stubGlobal('fetch', fetchMock);
    apiPost.mockResolvedValue({
      ok: true,
      confirmToken: 'deadbeef',
      expiresAtMs: 1,
      summary: 'This will discard the held content for source-class.',
    });

    await expect(confirmIntakeQuarantineDecision(ITEM_ID, {
      action: 'discard',
    }, 'verified false positive; dropping clears the queue')).resolves.toMatchObject({ ok: true });

    const [grantPath, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(grantPath).toBe('/v1/fleet-auth/escalation/grant');
    expect(JSON.parse(String(grantInit.body))).toEqual({
      companionId: COMPANION_A,
      method: 'POST',
      target: `/api/admin/intake/quarantine/${ITEM_ID}/confirm`,
      reason: 'verified false positive; dropping clears the queue',
    });
    expect(apiPost).toHaveBeenCalledWith(
      `/api/admin/intake/quarantine/${ITEM_ID}/confirm`,
      { action: 'discard' },
      {
        headers: { 'x-psfn-escalation-grant': '22222222-2222-4222-8222-222222222222' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('refuses a blank reason before any ceremony runs', async () => {
    stubCompanionGardenRoute();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmIntakeQuarantineDecision(ITEM_ID, {
      action: 'discard',
    }, '   ')).rejects.toThrow(/escalation reason/u);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('decideIntakeQuarantine', () => {
  it('mints a fresh grant for the exact decide route and keeps release-raw distinct from discard', async () => {
    stubCompanionGardenRoute();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(grantResponse('cogsec.manage'));
    vi.stubGlobal('fetch', fetchMock);
    apiPost.mockResolvedValue({ ok: true, item: { id: ITEM_ID }, message: 'Released raw' });

    await expect(decideIntakeQuarantine(ITEM_ID, {
      action: 'release_raw',
      confirmToken: 'deadbeef',
      reason: 'Operator reviewed and approved verbatim re-delivery',
    })).resolves.toMatchObject({ ok: true });

    const [grantPath, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(grantPath).toBe('/v1/fleet-auth/escalation/grant');
    expect(JSON.parse(String(grantInit.body))).toEqual({
      companionId: COMPANION_A,
      method: 'POST',
      target: `/api/admin/intake/quarantine/${ITEM_ID}/decide`,
      reason: 'Operator reviewed and approved verbatim re-delivery',
    });
    // The action stays a distinct body field: the ceremony authorizes the
    // endpoint, it never collapses release-raw into discard.
    expect(apiPost).toHaveBeenCalledWith(
      `/api/admin/intake/quarantine/${ITEM_ID}/decide`,
      {
        action: 'release_raw',
        confirmToken: 'deadbeef',
        reason: 'Operator reviewed and approved verbatim re-delivery',
      },
      {
        headers: { 'x-psfn-escalation-grant': '22222222-2222-4222-8222-222222222222' },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('fails closed when the grant mint is refused and never reaches the decide', async () => {
    stubCompanionGardenRoute();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(csrfResponse())
      .mockResolvedValueOnce(new Response('Escalation reason is invalid', { status: 400 })));

    await expect(decideIntakeQuarantine(ITEM_ID, {
      action: 'discard',
      confirmToken: 'deadbeef',
      reason: 'drop',
    })).rejects.toThrow(/Escalation reason is invalid/u);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
