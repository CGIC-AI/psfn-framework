export type Awaitable<T> = T | Promise<T>;
import type {
  PendingFollowUp,
  PendingFollowUpActivateOptions,
  PendingFollowUpCreateInput,
  PendingFollowUpDampenOptions,
  PendingFollowUpListOptions,
} from './pending-follow-up-types.js';

export interface PendingFollowUpQuarantineInput {
  reason: string;
  raw: unknown;
  followUpId?: string;
  source?: string;
  quarantinedAt?: string;
}

export interface PendingFollowUpQuarantineRecord {
  id: string;
  reason: string;
  raw: unknown;
  quarantinedAt: string;
  followUpId?: string;
  source?: string;
}

export interface PendingFollowUpQuarantineListOptions {
  followUpId?: string;
  source?: string;
  limit?: number;
}

export interface PendingFollowUpStorePort {
  enqueue(input: PendingFollowUpCreateInput): Awaitable<PendingFollowUp | null>;
  peek(id: string): Awaitable<PendingFollowUp | null>;
  dequeue(
    id: string,
    options?: PendingFollowUpActivateOptions,
  ): Awaitable<PendingFollowUp | null>;
  dampen?(id: string, options: PendingFollowUpDampenOptions): Awaitable<PendingFollowUp | null>;
  quarantine(input: PendingFollowUpQuarantineInput): Awaitable<PendingFollowUpQuarantineRecord>;
  list(options?: PendingFollowUpListOptions): Awaitable<PendingFollowUp[]>;
  listQuarantined(
    options?: PendingFollowUpQuarantineListOptions,
  ): Awaitable<PendingFollowUpQuarantineRecord[]>;
}

export function createPendingFollowUpStorePort(
  store: PendingFollowUpStorePort,
): PendingFollowUpStorePort {
  return {
    enqueue: async (input) => await store.enqueue(input),
    peek: async (id) => await store.peek(id),
    dequeue: async (id, options) => await store.dequeue(id, options),
    ...(store.dampen
      ? { dampen: async (id, options) => await store.dampen!(id, options) }
      : {}),
    quarantine: async (input) => await store.quarantine(input),
    list: async (options) => await store.list(options),
    listQuarantined: async (options) => await store.listQuarantined(options),
  };
}
