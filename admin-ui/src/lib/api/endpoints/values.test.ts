import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  throwIfNotOk: async (response: Response) => {
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  },
}));

import { apiPost as apiPostImport } from '$lib/api/client';
import {
  beginJournalPrivacyBreakGlass,
  decideJournalPrivacyBreakGlass,
} from './values';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CSRF_TOKEN = 'a'.repeat(43);
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const CONFIRM_TOKEN = 'b'.repeat(64);
const EXPIRES_AT = '2099-08-03T12:01:00.000Z';

const apiPost = vi.mocked(apiPostImport);

function companionGarden(): void {
  vi.stubGlobal('window', {
    location: { pathname: `/companions/${COMPANION_ID}/garden/values` },
  });
}

function rawCeremonyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), {
      status: 200,
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      grantId: GRANT_ID,
      routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
      expiresAt: EXPIRES_AT,
    }), { status: 200 }));
}

beforeEach(() => {
  companionGarden();
  apiPost.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('journal privacy break-glass client', () => {
  it('binds the audited grant and confirmation to one exact journal stream', async () => {
    const fetchMock = rawCeremonyFetch();
    vi.stubGlobal('fetch', fetchMock);
    apiPost.mockResolvedValueOnce({
      ok: true,
      confirmToken: CONFIRM_TOKEN,
      expiresAt: EXPIRES_AT,
    });

    await expect(beginJournalPrivacyBreakGlass({
      stream: 'reflection-daily',
      reasonCategory: 'safety_intervention',
      reason: '  Verify an urgent welfare anomaly.  ',
    })).resolves.toEqual({
      stream: 'reflection-daily',
      reasonCategory: 'safety_intervention',
      reason: 'Verify an urgent welfare anomaly.',
      confirmToken: CONFIRM_TOKEN,
      expiresAt: EXPIRES_AT,
      expiresAtMs: Date.parse(EXPIRES_AT),
    });

    const [, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(grantInit.body).toBe(JSON.stringify({
      companionId: COMPANION_ID,
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/reflection-daily/confirm',
      reason: 'Verify an urgent welfare anomaly.',
    }));
    expect(apiPost).toHaveBeenCalledWith(
      '/api/admin/privacy-break-glass/journal/reflection-daily/confirm',
      {
        reasonCategory: 'safety_intervention',
        reason: 'Verify an urgent welfare anomaly.',
      },
      { headers: { 'x-psfn-escalation-grant': GRANT_ID } },
    );
  });

  it('consumes the exact confirmation once through the decision route and returns its disclosure', async () => {
    apiPost.mockResolvedValueOnce({
      ok: true,
      disclosure: {
        kind: 'journal',
        journal: {
          stream: 'values-journal',
          entries: [{ id: 'value-1', reflection: 'Private values entry' }],
        },
      },
    });

    await expect(decideJournalPrivacyBreakGlass({
      stream: 'values-journal',
      reasonCategory: 'incident_response',
      reason: 'Investigate a possible compromise.',
      confirmToken: CONFIRM_TOKEN,
      expiresAt: EXPIRES_AT,
      expiresAtMs: Date.parse(EXPIRES_AT),
    })).resolves.toEqual({
      stream: 'values-journal',
      entries: [{ id: 'value-1', reflection: 'Private values entry' }],
    });

    expect(apiPost).toHaveBeenCalledWith(
      '/api/admin/privacy-break-glass/journal/values-journal/decide',
      {
        reasonCategory: 'incident_response',
        reason: 'Investigate a possible compromise.',
        confirmToken: CONFIRM_TOKEN,
      },
    );
  });

  it('refuses an expired confirmation or a mismatched disclosure stream', async () => {
    await expect(decideJournalPrivacyBreakGlass({
      stream: 'reflection-journal',
      reasonCategory: 'data_repair',
      reason: 'Repairing corrupt journal metadata.',
      confirmToken: CONFIRM_TOKEN,
      expiresAt: '2000-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2000-01-01T00:00:00.000Z'),
    })).rejects.toThrow(/confirmation expired/u);
    expect(apiPost).not.toHaveBeenCalled();

    apiPost.mockResolvedValueOnce({
      ok: true,
      disclosure: {
        kind: 'journal',
        journal: { stream: 'reflection-daily', entries: [] },
      },
    });
    await expect(decideJournalPrivacyBreakGlass({
      stream: 'reflection-journal',
      reasonCategory: 'data_repair',
      reason: 'Repairing corrupt journal metadata.',
      confirmToken: CONFIRM_TOKEN,
      expiresAt: EXPIRES_AT,
      expiresAtMs: Date.parse(EXPIRES_AT),
    })).rejects.toThrow(/response is malformed/u);
  });
});
