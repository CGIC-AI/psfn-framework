import type Database from 'better-sqlite3';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ContactStorePort } from './contact-store-port.js';
import type { ChannelPrivacyLevel } from './types.js';
import { createSQLiteContactStore } from './sqlite-adapter.js';
import {
  createContactTool,
  createContactLinkIdentityTool,
  createContactNoteTool,
  createContactSetChannelPrivacyTool,
  createContactSetTrustTool,
} from './tools.js';

export interface ContactRuntimeTarget {
  contactStore: ContactStorePort | null;
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

export async function registerContactRuntime(
  target: ContactRuntimeTarget,
  contactStore: ContactStorePort,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): Promise<ContactStorePort> {
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

  target.registerTool(createContactTool(contactStore));
  target.registerTool(createContactSetTrustTool(contactStore), 'extended');
  target.registerTool(createContactSetChannelPrivacyTool(contactStore), 'extended');
  target.registerTool(createContactNoteTool(contactStore), 'extended');
  target.registerTool(createContactLinkIdentityTool(contactStore), 'extended');

  return contactStore;
}

export async function wireContactRuntime(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
  options: ContactRuntimeOptions = {},
): Promise<ContactStorePort> {
  const contactStore = createSQLiteContactStore(db, primaryUserId, {
    exportDir: options.exportDir,
  });
  return await registerContactRuntime(target, contactStore, primaryUserId, options);
}
