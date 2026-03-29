import type Database from 'better-sqlite3';
import type { ContactStorePort } from './contact-store-port.js';
import { ContactStore, type ContactStoreOptions } from './store.js';

export function createSQLiteContactStore(
  db: Database.Database,
  primaryUserId?: string,
  options: ContactStoreOptions = {},
): ContactStorePort {
  return new ContactStore(db, primaryUserId, options);
}
