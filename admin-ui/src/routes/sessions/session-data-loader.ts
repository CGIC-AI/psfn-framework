import type {
  AdminSessionDetailData,
  AdminSessionListData,
  AdminSessionMessagesData,
} from '$lib/types';

export interface SessionIndexLoadOptions {
  getCached(): Promise<AdminSessionListData | null>;
  revalidate(): Promise<AdminSessionListData>;
  onList(data: AdminSessionListData, source: 'cache' | 'revalidated'): void;
}

export async function loadSessionIndex(options: SessionIndexLoadOptions): Promise<void> {
  const cached = await options.getCached();
  if (cached) options.onList(cached, 'cache');
  const fresh = await options.revalidate();
  options.onList(fresh, 'revalidated');
}

export interface SelectedSessionLoadOptions {
  sessionId: string;
  loadCachedMessages(sessionId: string): Promise<AdminSessionMessagesData | null>;
  loadMessages(sessionId: string): Promise<AdminSessionMessagesData>;
  loadDetail(sessionId: string): Promise<AdminSessionDetailData>;
  onMessages(
    data: AdminSessionMessagesData,
    source: 'cache' | 'revalidated',
  ): void | Promise<void>;
  onDetail(data: AdminSessionDetailData): void | Promise<void>;
}

export async function loadSelectedSessionData(options: SelectedSessionLoadOptions): Promise<void> {
  const cached = await options.loadCachedMessages(options.sessionId);
  if (cached) await options.onMessages(cached, 'cache');
  await Promise.all([
    options.loadMessages(options.sessionId).then(data => options.onMessages(data, 'revalidated')),
    options.loadDetail(options.sessionId).then(options.onDetail),
  ]);
}
