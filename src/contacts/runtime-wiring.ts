import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import { createLegacyAliasTelemetryEmitter } from '../tools/legacy-alias-telemetry.js';
import { ContactStore } from './store.js';
import type { ChannelPrivacyLevel } from './types.js';
import { createContactToolWithOptions } from './tools.js';

export interface ContactRuntimeTarget {
  contactStore: ContactStore | null;
  registerTool: ToolRegistrar;
}

export interface ContactRuntimeIdentityLink {
  channel: string;
  userId: string;
  privacyLevel?: ChannelPrivacyLevel;
}

export interface ContactRuntimeOptions {
  bootstrapPrimaryIdentityLinks?: ContactRuntimeIdentityLink[];
  eventBus?: EventBus;
  exportDir?: string;
}

export function wireContactRuntime(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): ContactStore {
  const contactStore = new ContactStore(db, primaryUserId, {
    exportDir: options.exportDir,
  });
  target.contactStore = contactStore;

  const trimmedPrimaryUserId = primaryUserId?.trim();
  if (trimmedPrimaryUserId && options.bootstrapPrimaryIdentityLinks?.length) {
    const primaryContact = contactStore.resolveUserId(trimmedPrimaryUserId);
    for (const link of options.bootstrapPrimaryIdentityLinks) {
      const channel = link.channel.trim();
      const userId = link.userId.trim();
      if (!channel || !userId) continue;
      contactStore.linkChannelIdentity(
        primaryContact.id,
        channel,
        userId,
        link.privacyLevel ? { privacyLevel: link.privacyLevel } : undefined,
      );
    }
  }

  target.registerTool(createContactToolWithOptions(contactStore, {
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(options.eventBus),
  }));

  return contactStore;
}
