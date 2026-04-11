import type { SessionEntry } from '../types.js';

export interface PreCompactionExtractionContext {
  channelId: string;
  entries: SessionEntry[];
  canonicalContactId?: string;
}

export type PreCompactionExtractionHandler = (
  context: PreCompactionExtractionContext,
) => Promise<void>;
