import type Database from 'better-sqlite3';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import { ContactStore } from './store.js';
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

export function wireContactRuntime(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
): ContactStore {
  const contactStore = new ContactStore(db, primaryUserId);
  target.contactStore = contactStore;

  target.registerTool(createContactSetTrustTool(contactStore), 'extended');
  target.registerTool(createContactSetChannelPrivacyTool(contactStore), 'extended');
  target.registerTool(createContactNoteTool(contactStore), 'extended');
  target.registerTool(createContactLinkIdentityTool(contactStore), 'extended');
  target.registerTool(createContactLookupTool(contactStore));
  target.registerTool(createContactListTool(contactStore));

  return contactStore;
}
