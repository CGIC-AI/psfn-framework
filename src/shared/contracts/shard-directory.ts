import type { HubDeviceAttachmentSnapshot } from './hub-device-ingress.js';
import type { CompanionId } from '../routing/companion-id.js';

export const SHARD_DIRECTORY_LIMITS = Object.freeze({
  maxEntries: 64,
  maxHistoryEntries: 100,
  maxLabelCharacters: 128,
  maxPurposeCharacters: 240,
  maxMessageCharacters: 65_536,
});

export type ShardDirectoryAvailability = 'starting' | 'available' | 'degraded';

export class ShardDirectoryDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShardDirectoryDeniedError';
  }
}

export class ShardDirectoryOperationalError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('Shard directory operation failed');
    this.name = 'ShardDirectoryOperationalError';
    this.cause = cause;
  }
}

export interface ShardDirectoryEntry {
  readonly shardId: string;
  readonly label: string;
  readonly purpose: string;
  readonly availability: ShardDirectoryAvailability;
  readonly startedAt: number;
}

export interface ShardChatAttribution {
  readonly parentCompanionId: CompanionId;
  readonly shardId: string;
}

export interface ShardChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: number;
  readonly attribution: ShardChatAttribution;
}

export interface ShardChatResponse {
  readonly content: string;
  readonly channelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attribution: ShardChatAttribution;
}

/**
 * Server-owned live-shard surface. Callers must provide both the authenticated
 * parent and the shard selector; implementations re-check that exact tuple for
 * every operation.
 */
export interface ShardDirectoryPort {
  ownerOfLiveShard(shardId: string): CompanionId | undefined;
  listShards(parentCompanionId: CompanionId): readonly ShardDirectoryEntry[];
  readShardChatHistory(
    parentCompanionId: CompanionId,
    shardId: string,
  ): readonly ShardChatMessage[];
  sendShardChat(input: Readonly<{
    parentCompanionId: CompanionId;
    shardId: string;
    requestId: string;
    content: string;
    attachment: HubDeviceAttachmentSnapshot;
  }>): Promise<ShardChatResponse>;
  interruptShardChat(input: Readonly<{
    parentCompanionId: CompanionId;
    shardId: string;
    interactionId: string;
  }>): Readonly<{
    interrupted: boolean;
    interactionId: string;
    attribution: ShardChatAttribution;
  }>;
}
