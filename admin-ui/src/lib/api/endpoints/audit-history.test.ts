import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditHistoryDetailPath,
  getAuditHistory,
  getAuditHistoryDetail,
} from './audit-history';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audit history endpoints', () => {
  it('keeps list and per-entry raw detail on separate requests', async () => {
    const entryId = `audit_${'a'.repeat(43)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry: { id: entryId }, raw: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await getAuditHistory({
      actionType: 'all',
      decision: 'all',
      timeRange: '24h',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/admin/audit/history?');

    await getAuditHistoryDetail(entryId);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/admin/audit/history/${entryId}`);
  });

  it('URL-encodes the opaque detail id as a single path segment', () => {
    expect(buildAuditHistoryDetailPath('audit_a/b c'))
      .toBe('/api/admin/audit/history/audit_a%2Fb%20c');
  });
});
