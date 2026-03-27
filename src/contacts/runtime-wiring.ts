import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../persistence/db-adapter.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import { ContactStore } from './store.js';
import type { ChannelPrivacyLevel } from './types.js';
import {
  createContactLinkIdentityTool,
  createContactListTool,
  createContactLookupTool,
  createContactNoteTool,
  createContactSetChannelPrivacyTool,
  createContactSetTrustTool,
} from './tools.js';

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
  exportDir?: string;
}

export async function wireContactRuntime(
  target: ContactRuntimeTarget,
  adapter: DatabaseAdapter,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): Promise<ContactStore> {
  const contactStore = new ContactStore(adapter, primaryUserId, {
    exportDir: options.exportDir,
  });
  await contactStore.init();
  target.contactStore = contactStore;

  const trimmedPrimaryUserId = primaryUserId?.trim();
  if (trimmedPrimaryUserId && options.bootstrapPrimaryIdentityLinks?.length) {
    const primaryContact = await contactStore.resolveUserId(trimmedPrimaryUserId);
    for (const link of options.bootstrapPrimaryIdentityLinks) {
      const channel = link.channel.trim();
      const userId = link.userId.trim();
      if (!channel || !userId) continue;
      await contactStore.linkChannelIdentity(
        primaryContact.id,
        channel,
        userId,
        link.privacyLevel ? { privacyLevel: link.privacyLevel } : undefined,
      );
    }
  }

  target.registerTool(createContactSetTrustTool(contactStore), 'extended');
  target.registerTool(createContactSetChannelPrivacyTool(contactStore), 'extended');
  target.registerTool(createContactNoteTool(contactStore), 'extended');
  target.registerTool(createContactLinkIdentityTool(contactStore), 'extended');
  target.registerTool(createContactLookupTool(contactStore));
  target.registerTool(createContactListTool(contactStore));

  return contactStore;
}

/** @deprecated Use the async version with DatabaseAdapter */
export function wireContactRuntimeSync(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): ContactStore {
  const contactStore = new ContactStore(db as unknown as DatabaseAdapter, primaryUserId, {
    exportDir: options.exportDir,
  });
  target.contactStore = contactStore;

  target.registerTool(createContactSetTrustTool(contactStore), 'extended');
  target.registerTool(createContactSetChannelPrivacyTool(contactStore), 'extended');
  target.registerTool(createContactNoteTool(contactStore), 'extended');
  target.registerTool(createContactLinkIdentityTool(contactStore), 'extended');
  target.registerTool(createContactLookupTool(contactStore));
  target.registerTool(createContactListTool(contactStore));

  return contactStore;
}
