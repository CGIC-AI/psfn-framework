import { describe, expect, it, vi } from 'vitest';
import { AdminAuditTimelineStore } from './audit-timeline.js';

describe('AdminAuditTimelineStore', () => {
  it('parses filters with sane defaults', () => {
    const store = new AdminAuditTimelineStore();
    const filters = store.parseFilters(new URLSearchParams());
    expect(filters).toEqual({
      actionType: 'all',
      decision: 'all',
      timeRange: '24h',
    });
  });

  it('falls back when unknown filters are provided', () => {
    const store = new AdminAuditTimelineStore();
    const filters = store.parseFilters(new URLSearchParams({
      actionType: 'not-a-type',
      decision: 'maybe',
      timeRange: 'forever',
    }));
    expect(filters).toEqual({
      actionType: 'all',
      decision: 'all',
      timeRange: '24h',
    });
  });

  it('filters by action type and decision', () => {
    const store = new AdminAuditTimelineStore();
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Allowed tool call',
    });
    store.append({
      actionType: 'memory_mutation',
      decision: 'denied',
      narrative: 'Denied memory mutation',
    });

    const filtered = store.list({
      actionType: 'memory_mutation',
      decision: 'denied',
      timeRange: 'all',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].narrative).toContain('Denied memory mutation');
  });

  it('filters by time range', () => {
    const store = new AdminAuditTimelineStore();
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_700_000_000_000);
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Old event',
    });

    nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 60 * 60 * 1_000));
    store.append({
      actionType: 'tool_invocation',
      decision: 'allowed',
      narrative: 'Recent event',
    });

    const recentOnly = store.list({
      actionType: 'all',
      decision: 'all',
      timeRange: '1h',
    });
    expect(recentOnly).toHaveLength(1);
    expect(recentOnly[0].narrative).toContain('Recent event');

    const all = store.list({
      actionType: 'all',
      decision: 'all',
      timeRange: 'all',
    });
    expect(all).toHaveLength(2);

    nowSpy.mockRestore();
  });
});
