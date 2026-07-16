import { describe, expect, it, vi } from 'vitest';
import type {
  AdminSessionDetailData,
  AdminSessionListData,
  AdminSessionMessagesData,
} from '$lib/types';
import {
  loadSelectedSessionData,
  loadSessionIndex,
} from './session-data-loader';

const cachedList: AdminSessionListData = {
  channels: [{
    sessionId: 'api:cached',
    channelId: 'api:cached',
    messageCount: 1,
    lastActivityAt: 1_700_000_000_000,
  }],
};

const freshList: AdminSessionListData = {
  channels: [{
    sessionId: 'api:fresh',
    channelId: 'api:fresh',
    messageCount: 2,
    lastActivityAt: 1_700_000_000_100,
  }],
};

function transcript(content: string, id: number): AdminSessionMessagesData {
  return {
    sessionId: 'api:selected',
    channelId: 'api:selected',
    messages: [{
      id,
      channelId: 'api:selected',
      role: 'user',
      content,
      timestamp: 1_700_000_000_000 + id,
    }],
    pagination: {
      limit: 100,
      beforeId: null,
      nextBeforeId: null,
      hasMoreOlder: false,
      totalMessages: 1,
      returnedMessages: 1,
    },
    messageOntologyViews: [],
    roleEnvelopePreviews: [],
    compactionAuditViews: [],
    turns: [],
  };
}

describe('sessions page data loading', () => {
  it('issues one list request on an initial visit', async () => {
    const revalidate = vi.fn(async () => freshList);
    const onList = vi.fn();

    await loadSessionIndex({
      getCached: async () => null,
      revalidate,
      onList,
    });

    expect(revalidate).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenCalledWith(freshList, 'revalidated');
  });

  it('renders the session cache immediately on repeat navigation and then conditionally revalidates once', async () => {
    let resolveRevalidation: ((data: AdminSessionListData) => void) | undefined;
    const revalidate = vi.fn(() => new Promise<AdminSessionListData>((resolve) => {
      resolveRevalidation = resolve;
    }));
    const onList = vi.fn();

    const loading = loadSessionIndex({
      getCached: async () => cachedList,
      revalidate,
      onList,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onList).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenLastCalledWith(cachedList, 'cache');
    expect(revalidate).toHaveBeenCalledOnce();

    if (!resolveRevalidation) throw new Error('List revalidation did not start');
    resolveRevalidation(freshList);
    await loading;

    expect(onList).toHaveBeenCalledTimes(2);
    expect(onList).toHaveBeenLastCalledWith(freshList, 'revalidated');
  });

  it('loads contact detail only after selection and preserves it alongside the selected messages', async () => {
    const detail: AdminSessionDetailData = {
      channel: {
        sessionId: 'api:selected',
        channelId: 'api:selected',
        messageCount: 1,
        linkedContactId: 'contact-1',
        linkedContactName: 'Selected Person',
      },
    };
    const messages = transcript('hello', 1);
    const loadCachedMessages = vi.fn(async () => null);
    const loadMessages = vi.fn(async () => messages);
    const loadDetail = vi.fn(async () => detail);
    const onMessages = vi.fn();
    const onDetail = vi.fn();

    expect(loadDetail).not.toHaveBeenCalled();

    await loadSelectedSessionData({
      sessionId: 'api:selected',
      loadCachedMessages,
      loadMessages,
      loadDetail,
      onMessages,
      onDetail,
    });

    expect(loadMessages).toHaveBeenCalledOnce();
    expect(loadCachedMessages).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledWith('api:selected');
    expect(onMessages).toHaveBeenCalledWith(messages, 'revalidated');
    expect(onDetail).toHaveBeenCalledWith(detail);
  });

  it('renders a persisted transcript before its conditional refresh resolves', async () => {
    const cached = transcript('cached', 1);
    const fresh = transcript('fresh', 2);
    let resolveMessages: ((data: AdminSessionMessagesData) => void) | undefined;
    const loadMessages = vi.fn(() => new Promise<AdminSessionMessagesData>((resolve) => {
      resolveMessages = resolve;
    }));
    const onMessages = vi.fn();
    const loading = loadSelectedSessionData({
      sessionId: 'api:selected',
      loadCachedMessages: async () => cached,
      loadMessages,
      loadDetail: async () => ({
        channel: {
          sessionId: 'api:selected',
          channelId: 'api:selected',
          messageCount: 2,
        },
      }),
      onMessages,
      onDetail: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onMessages).toHaveBeenCalledWith(cached, 'cache');
    expect(loadMessages).toHaveBeenCalledOnce();

    if (!resolveMessages) throw new Error('Transcript revalidation did not start');
    resolveMessages(fresh);
    await loading;
    expect(onMessages).toHaveBeenLastCalledWith(fresh, 'revalidated');
  });
});
