import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client', () => ({
  apiGet: vi.fn(),
  apiGetConditional: vi.fn(),
  apiPost: vi.fn(),
  throwIfNotOk: async (response: Response) => {
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  },
}));

import { apiPost as apiPostImport } from '$lib/api/client';
import {
  applyCogSecRemediation,
  previewCogSecRemediation,
  resetSourceChannelSession,
} from './sessions.js';

const apiPost = vi.mocked(apiPostImport);
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const CSRF_TOKEN = 'a'.repeat(43);

const remediationInput = {
  caseId: 'case-one',
  sourceChannelId: 'discord:channel-one',
  affectedLogicalSessionIds: ['logical-session-one'],
  affectedMessageRanges: [],
  type: 'content_poisoning' as const,
  severity: 'high' as const,
  reason: '  remove poisoned context  ',
  actor: 'browser-supplied-actor',
  cutEpoch: true,
};

beforeEach(() => {
  vi.stubGlobal('window', {
    location: { pathname: `/companions/${COMPANION_ID}/garden/cognitive-security/remediation` },
  });
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
  apiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ceremonyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: CSRF_TOKEN }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      grantId: GRANT_ID,
      routeId: 'sessions.repair',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 200 }));
}

describe('escalated session repair actions', () => {
  it.each([
    ['preview', '/api/admin/session-routes/cogsec/preview', previewCogSecRemediation],
    ['apply', '/api/admin/session-routes/cogsec/apply', applyCogSecRemediation],
  ] as const)('mints and spends an exact grant for CogSec %s', async (_name, target, action) => {
    const fetchMock = ceremonyFetch();
    vi.stubGlobal('fetch', fetchMock);

    await action(remediationInput);

    const [, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(grantInit.body))).toEqual({
      companionId: COMPANION_ID,
      method: 'POST',
      target,
      reason: 'remove poisoned context',
    });
    expect(apiPost).toHaveBeenCalledWith(target, expect.objectContaining({
      reason: remediationInput.reason,
    }), {
      headers: { 'x-psfn-escalation-grant': GRANT_ID },
      signal: expect.any(AbortSignal),
    });
  });

  it('mints and spends an exact grant for session reset', async () => {
    const fetchMock = ceremonyFetch();
    vi.stubGlobal('fetch', fetchMock);

    await resetSourceChannelSession({
      sourceChannelId: 'discord:channel-one',
      reason: '  operator reset  ',
      actor: 'browser-supplied-actor',
      mode: 'fresh_split',
    });

    const [, grantInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(grantInit.body))).toEqual(expect.objectContaining({
      target: '/api/admin/session-routes/reset',
      reason: 'operator reset',
    }));
    expect(apiPost).toHaveBeenCalledWith('/api/admin/session-routes/reset', expect.objectContaining({
      reason: '  operator reset  ',
    }), expect.objectContaining({
      headers: { 'x-psfn-escalation-grant': GRANT_ID },
    }));
  });

  it('fails before the protected request when the reason is blank', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyCogSecRemediation({ ...remediationInput, reason: '   ' }))
      .rejects.toThrow(/escalation reason/u);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
