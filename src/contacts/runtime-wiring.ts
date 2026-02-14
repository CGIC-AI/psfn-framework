import type Database from 'better-sqlite3';
import type { SubstrateTool } from '../types.js';
import { ContactStore } from './store.js';
import {
  createContactListTool,
  createContactLookupTool,
  createContactNoteTool,
  createContactSetTrustTool,
} from './tools.js';

export interface ContactRuntimeTarget {
  contactStore: ContactStore | null;
  registerTool(tool: SubstrateTool): void;
}

export function wireContactRuntime(
  target: ContactRuntimeTarget,
  db: Database.Database,
  primaryUserId?: string,
): ContactStore {
  const contactStore = new ContactStore(db, primaryUserId);
  target.contactStore = contactStore;

  target.registerTool(createContactSetTrustTool(contactStore));
  target.registerTool(createContactNoteTool(contactStore));
  target.registerTool(createContactLookupTool(contactStore));
  target.registerTool(createContactListTool(contactStore));

  return contactStore;
}
