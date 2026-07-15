import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionDetailPath,
  buildSessionMessagesPath,
  buildSessionTurnDetailPath,
  clearSessionListCache,
  getCachedSessionList,
  revalidateSessionList,
  SESSION_MESSAGE_PAGE_SIZE,
} from './sessions';

describe('session admin endpoint paths', () => {
  beforeEach(() => {
    clearSessionListCache();
  });

  it('builds bounded session-message requests with cursor pagination', () => {
    expect(SESSION_MESSAGE_PAGE_SIZE).toBe(100);
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      beforeId: 42,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100&beforeId=42');
  });

  it('omits nullable cursor params for the initial newest-message page', () => {
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      beforeId: null,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100');
  });

  it('requests the lean initial page (compaction kept, turns dropped) via includeTurns=false', () => {
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      includeTurns: false,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100&includeTurns=false');
  });

  it('omits includeTurns when the caller keeps the default turns payload', () => {
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      includeTurns: true,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100');
  });

  it('sends messagesOnly for cheap pagination pages', () => {
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      beforeId: 42,
      messagesOnly: true,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100&beforeId=42&messagesOnly=true');
  });

  it('builds a bounded per-turn detail path', () => {
    expect(buildSessionTurnDetailPath('api:session one', 'turn 123'))
      .toBe('/api/admin/sessions/api%3Asession%20one/turns/turn%20123');
  });

  it('builds a focused selected-session detail path', () => {
    expect(buildSessionDetailPath('api:session one'))
      .toBe('/api/admin/sessions/api%3Asession%20one/detail');
  });

  it('keeps a lightweight session-list result in the current Garden client session', async () => {
    const payload = {
      channels: [{
        sessionId: 'api:cached',
        channelId: 'api:cached',
        messageCount: 2,
        lastActivityAt: 1_700_000_000_000,
      }],
    };
    const fetchList = vi.fn(async () => payload);

    expect(getCachedSessionList()).toBeNull();
    await expect(revalidateSessionList(fetchList)).resolves.toEqual(payload);
    expect(fetchList).toHaveBeenCalledOnce();
    expect(getCachedSessionList()).toEqual(payload);
  });
});
