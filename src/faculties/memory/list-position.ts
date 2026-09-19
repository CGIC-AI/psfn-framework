import { isRecord } from '../../shared/utils/types.js';

/** Exclusive position in a newest-first, id-tiebroken active memory scan. */
export interface MemoryListPosition {
  readonly extractedAt: number;
  readonly memoryId: string;
}

export function assertMemoryListPosition(value: unknown): MemoryListPosition {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.extractedAt)
    || typeof value.memoryId !== 'string'
    || value.memoryId.length === 0
    || value.memoryId !== value.memoryId.trim()) {
    throw new Error('memory list position requires a safe timestamp and canonical memory id');
  }
  return { extractedAt: value.extractedAt as number, memoryId: value.memoryId };
}
