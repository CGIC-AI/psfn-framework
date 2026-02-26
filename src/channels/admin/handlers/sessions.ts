import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminSessionsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  sessionList(): string {
    return this.legacy.sessionList();
  }

  sessionMessages(channelId: string): string {
    return this.legacy.sessionMessages(channelId);
  }

  sessionMessagesFragment(channelId: string): string {
    return this.legacy.sessionMessagesFragment(channelId);
  }
}
