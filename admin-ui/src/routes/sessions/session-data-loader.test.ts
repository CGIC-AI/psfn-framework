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

describe('sessions page data loading', () => {
  it('issues one list request on an initial visit', async () => {
    const revalidate = vi.fn(async () => freshList);
    const onList = vi.fn();

    await loadSessionIndex({
      getCached: () => null,
      revalidate,
      onList,
    });

    expect(revalidate).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenCalledWith(freshList, 'revalidated');
  });

  it('renders the session cache immediately on repeat navigation and then conditionally revalidates once', async () => {
    let resolveRevalidation!: (data: AdminSessionListData) => void;
    const revalidate = vi.fn(() => new Promise<AdminSessionListData>((resolve) => {
      resolveRevalidation = resolve;
    }));
    const onList = vi.fn();

    const loading = loadSessionIndex({
      getCached: () => cachedList,
      revalidate,
      onList,
    });

    expect(onList).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenLastCalledWith(cachedList, 'cache');
    expect(revalidate).toHaveBeenCalledOnce();

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
    const messages = {
      sessionId: 'api:selected',
      channelId: 'api:selected',
      messages: [{ id: 1, role: 'user', content: 'hello' }],
    } as AdminSessionMessagesData;
    const loadMessages = vi.fn(async () => messages);
    const loadDetail = vi.fn(async () => detail);
    const onMessages = vi.fn();
    const onDetail = vi.fn();

    expect(loadDetail).not.toHaveBeenCalled();

    await loadSelectedSessionData({
      sessionId: 'api:selected',
      loadMessages,
      loadDetail,
      onMessages,
      onDetail,
    });

    expect(loadMessages).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledWith('api:selected');
    expect(onMessages).toHaveBeenCalledWith(messages);
    expect(onDetail).toHaveBeenCalledWith(detail);
  });
});
