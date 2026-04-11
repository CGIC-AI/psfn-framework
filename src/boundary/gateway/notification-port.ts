import type { NotifyNtfyParams, NotifyNtfyResult } from './protocol.js';

export interface NotificationPort {
  notify(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
}
