import type {
  AdminSessionDetailData,
  AdminSessionListData,
  AdminSessionMessagesData,
} from '$lib/types';

export interface SessionIndexLoadOptions {
  getCached(): AdminSessionListData | null;
  revalidate(): Promise<AdminSessionListData>;
  onList(data: AdminSessionListData, source: 'cache' | 'revalidated'): void;
}

export async function loadSessionIndex(options: SessionIndexLoadOptions): Promise<void> {
  const cached = options.getCached();
  if (cached) options.onList(cached, 'cache');
  const fresh = await options.revalidate();
  options.onList(fresh, 'revalidated');
}

export interface SelectedSessionLoadOptions {
  sessionId: string;
  loadMessages(sessionId: string): Promise<AdminSessionMessagesData>;
  loadDetail(sessionId: string): Promise<AdminSessionDetailData>;
  onMessages(data: AdminSessionMessagesData): void | Promise<void>;
  onDetail(data: AdminSessionDetailData): void | Promise<void>;
}

export async function loadSelectedSessionData(options: SelectedSessionLoadOptions): Promise<void> {
  await Promise.all([
    options.loadMessages(options.sessionId).then(options.onMessages),
    options.loadDetail(options.sessionId).then(options.onDetail),
  ]);
}
