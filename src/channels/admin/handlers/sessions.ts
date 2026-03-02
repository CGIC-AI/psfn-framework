import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import * as tpl from '../templates.js';

export class AdminSessionsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  sessionList(): string {
    const legacy = this.legacy as any;
    const channels = legacy.sessionStore.listChannels();
    const contacts = legacy.contactStore?.listAll() ?? [];
    const renderedChannels = channels.map((channel: any) => {
      const linkedContact = legacy.getLinkedContactForSession(channel.channelId, contacts);
      if (!linkedContact) return channel;
      return {
        ...channel,
        linkedContactId: linkedContact.id,
        linkedContactName: linkedContact.displayName,
      };
    });
    return tpl.layout('Conversation Roots', tpl.sessionListPage(renderedChannels), 'sessions');
  }

  sessionMessages(channelId: string): string {
    const legacy = this.legacy as any;
    const messages = legacy.sessionManager.getRecentMessages(channelId, 100);
    const compactionAuditViews = legacy.buildCompactionAuditViews(channelId);
    return tpl.layout(
      `Session: ${channelId}`,
      tpl.sessionMessagesPage(channelId, messages, compactionAuditViews),
      'sessions',
    );
  }

  sessionMessagesFragment(channelId: string): string {
    const legacy = this.legacy as any;
    const messages = legacy.sessionManager.getRecentMessages(channelId, 100);
    return messages.map((message: any) => tpl.messageCard(message)).join('');
  }
}
