import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import {
  SHARD_DIRECTORY_LIMITS,
  ShardDirectoryDeniedError,
  ShardDirectoryOperationalError,
  type ShardChatMessage,
  type ShardChatResponse,
  type ShardDirectoryEntry,
  type ShardDirectoryPort,
} from '../../shared/contracts/shard-directory.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { deriveShardRoutingEnvelope } from '../../shared/routing/envelope.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';

export interface ShardDirectoryDeployment {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly startedAt: number;
  readonly state: 'registering' | 'ready' | 'degraded' | 'offline';
  readonly health: 'healthy' | 'degraded' | 'offline';
}

export interface ShardDirectoryRuntime {
  readonly agentLoop: SubstrateAgent;
  readonly channelId: string;
}

export interface ShardDirectoryOptions {
  readonly parentCompanionId: () => CompanionId;
  readonly refreshDeployments: () => void;
  readonly deployments: () => readonly ShardDirectoryDeployment[];
  readonly intakeScreening: Pick<IntakeScreeningService, 'screenSync'> | null;
}

interface ActiveShardChatRuntime extends ShardDirectoryRuntime {
  readonly history: ShardChatMessage[];
  readonly interactions: Set<string>;
}

/**
 * Canonical live-shard directory and isolated human chat ingress.
 *
 * The manager owns deployment lifecycle; this focused module owns only the
 * server-visible projection and one chat runtime per live deployment.
 */
export class LiveShardDirectory implements ShardDirectoryPort {
  private readonly runtimes = new Map<string, ActiveShardChatRuntime>();

  constructor(private readonly options: ShardDirectoryOptions) {}

  register(shardId: string, runtime: ShardDirectoryRuntime): void {
    if (this.runtimes.has(shardId)) {
      throw new Error(`Shard directory runtime already exists for "${shardId}"`);
    }
    this.runtimes.set(shardId, {
      ...runtime,
      history: [],
      interactions: new Set<string>(),
    });
  }

  release(shardId: string): void {
    this.runtimes.delete(shardId);
  }

  ownerOfLiveShard(shardId: string): CompanionId | undefined {
    return this.operation(() => {
      this.options.refreshDeployments();
      const shard = this.findDeployment(shardId);
      return shard && shard.state !== 'offline' && this.runtimes.has(shardId)
        ? this.options.parentCompanionId()
        : undefined;
    });
  }

  listShards(parentCompanionId: CompanionId): readonly ShardDirectoryEntry[] {
    return this.operation(() => {
      this.assertParent(parentCompanionId);
      this.options.refreshDeployments();
      return Object.freeze(
        this.options.deployments()
          .filter(shard => shard.state !== 'offline' && this.runtimes.has(shard.id))
          .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
          .slice(0, SHARD_DIRECTORY_LIMITS.maxEntries)
          .map(shard => {
            const projection = projectDirectoryText(shard, this.options.intakeScreening);
            return Object.freeze({
              shardId: shard.id,
              label: projection.label,
              purpose: projection.purpose,
              availability: shard.state === 'registering'
                ? 'starting' as const
                : shard.state === 'ready' && shard.health === 'healthy'
                  ? 'available' as const
                  : 'degraded' as const,
              startedAt: shard.startedAt,
            });
          }),
      );
    });
  }

  readShardChatHistory(
    parentCompanionId: CompanionId,
    shardId: string,
  ): readonly ShardChatMessage[] {
    return this.operation(() => {
      const runtime = this.requireLiveRuntime(parentCompanionId, shardId);
      return Object.freeze(runtime.history.map(message => Object.freeze({
        ...message,
        attribution: Object.freeze({ ...message.attribution }),
      })));
    });
  }

  async sendShardChat(input: Readonly<{
    parentCompanionId: CompanionId;
    shardId: string;
    requestId: string;
    content: string;
    attachment: HubDeviceAttachmentSnapshot;
  }>): Promise<ShardChatResponse> {
    return await this.asyncOperation(async () => {
      const runtime = this.requireLiveRuntime(input.parentCompanionId, input.shardId);
      const shard = this.findDeployment(input.shardId);
      if (!shard || shard.state !== 'ready' || shard.health !== 'healthy') {
        throw new ShardDirectoryDeniedError('Selected shard is unavailable');
      }
      const actor = input.attachment.actor;
      if (actor.kind !== 'human' || actor.companionId !== input.parentCompanionId
        || input.attachment.channel.companionId !== input.parentCompanionId
        || input.attachment.deviceActor.principal.companionId !== input.parentCompanionId) {
        throw new ShardDirectoryDeniedError(
          'Selected shard chat requires a current human parent attachment',
        );
      }
      const content = input.content.trim();
      if (!content || content.length > SHARD_DIRECTORY_LIMITS.maxMessageCharacters) {
        throw new ShardDirectoryDeniedError('Selected shard chat content is invalid');
      }
      runtime.interactions.add(input.requestId);
      const timestamp = Date.now();
      const attribution = Object.freeze({
        parentCompanionId: input.parentCompanionId,
        shardId: input.shardId,
      });
      try {
        const response = await runtime.agentLoop.handleMessage({
          id: input.requestId,
          channelId: runtime.channelId,
          channelType: 'companion-ui',
          authorId: actor.principalId,
          authorName: 'Authenticated fleet human',
          content,
          timestamp: new Date(timestamp),
          isDirectMessage: true,
          routing: {
            source: 'companion-ui',
            channelPrivacy: 'private',
            canonicalContactId: actor.contact.contactId,
            hubDeviceAttachment: input.attachment,
            cancellationId: input.requestId,
            gateway: deriveShardRoutingEnvelope({
              companionId: input.parentCompanionId,
              shardId: input.shardId,
            }),
          },
        });
        appendBoundedHistory(runtime.history, {
          id: input.requestId,
          role: 'user',
          content,
          createdAt: timestamp,
          attribution,
        });
        appendBoundedHistory(runtime.history, {
          id: response.metadata.turnId ?? `${input.requestId}:response`,
          role: 'assistant',
          content: response.content,
          createdAt: Date.now(),
          attribution,
        });
        return Object.freeze({
          content: response.content,
          channelId: response.channelId,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
          attribution,
        });
      } finally {
        runtime.interactions.delete(input.requestId);
      }
    });
  }

  interruptShardChat(input: Readonly<{
    parentCompanionId: CompanionId;
    shardId: string;
    interactionId: string;
  }>): Readonly<{
    interrupted: boolean;
    interactionId: string;
    attribution: Readonly<{ parentCompanionId: CompanionId; shardId: string }>;
  }> {
    return this.operation(() => {
      const runtime = this.requireLiveRuntime(input.parentCompanionId, input.shardId);
      const ownsInteraction = runtime.interactions.has(input.interactionId);
      const result = ownsInteraction
        ? runtime.agentLoop.cancelTurn(input.interactionId)
        : { status: 'not_found' as const };
      return Object.freeze({
        interrupted: ownsInteraction && result.status === 'signaled',
        interactionId: input.interactionId,
        attribution: Object.freeze({
          parentCompanionId: input.parentCompanionId,
          shardId: input.shardId,
        }),
      });
    });
  }

  private operation<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      return rethrowShardDirectoryFailure(error);
    }
  }

  private async asyncOperation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return rethrowShardDirectoryFailure(error);
    }
  }

  private assertParent(parentCompanionId: CompanionId): void {
    if (parentCompanionId !== this.options.parentCompanionId()) {
      throw new ShardDirectoryDeniedError('Shard parent binding denied');
    }
  }

  private findDeployment(shardId: string): ShardDirectoryDeployment | undefined {
    return this.options.deployments().find(shard => shard.id === shardId);
  }

  private requireLiveRuntime(
    parentCompanionId: CompanionId,
    shardId: string,
  ): ActiveShardChatRuntime {
    this.assertParent(parentCompanionId);
    this.options.refreshDeployments();
    const shard = this.findDeployment(shardId);
    const runtime = this.runtimes.get(shardId);
    if (!shard || !runtime || shard.state === 'offline') {
      throw new ShardDirectoryDeniedError('Selected shard is unavailable');
    }
    return runtime;
  }
}

function rethrowShardDirectoryFailure(error: unknown): never {
  if (
    error instanceof ShardDirectoryDeniedError
    || error instanceof ShardDirectoryOperationalError
  ) {
    throw error;
  }
  throw new ShardDirectoryOperationalError(error);
}

function appendBoundedHistory(history: ShardChatMessage[], message: ShardChatMessage): void {
  history.push(Object.freeze({
    ...message,
    attribution: Object.freeze({ ...message.attribution }),
  }));
  const overflow = history.length - SHARD_DIRECTORY_LIMITS.maxHistoryEntries;
  if (overflow > 0) history.splice(0, overflow);
}

function projectDirectoryText(
  shard: ShardDirectoryDeployment,
  screening: Pick<IntakeScreeningService, 'screenSync'> | null,
): Readonly<{ label: string; purpose: string }> {
  if (!screening) {
    return { label: 'Active shard', purpose: 'Task details withheld' };
  }
  const project = (
    value: string,
    maxCharacters: number,
    fallback: string,
    field: 'label' | 'purpose',
  ): string => {
    const screened = screening.screenSync(value, {
      sourceClass: 'subagent_output',
      origin: { ref: `shard-directory:${shard.id}:${field}` },
      scope: 'all',
      subject: { kind: 'body' },
    });
    const sensitive = screened.action === 'block'
      || screened.action === 'quarantine'
      || screened.report.scannerErrors.length > 0
      || screened.report.riskLabels.some(label => (
        label.startsWith('pii/')
        || label.startsWith('secrets/')
        || label.startsWith('exfil/')
      ));
    return sensitive
      ? fallback
      : normalizeDirectoryText(screened.report.sanitizedText, maxCharacters, fallback);
  };
  return {
    label: project(
      shard.name,
      SHARD_DIRECTORY_LIMITS.maxLabelCharacters,
      'Active shard',
      'label',
    ),
    purpose: project(
      shard.task,
      SHARD_DIRECTORY_LIMITS.maxPurposeCharacters,
      'Task details withheld',
      'purpose',
    ),
  };
}

function normalizeDirectoryText(
  value: string,
  maxCharacters: number,
  fallback: string,
): string {
  const normalized = value
    .replaceAll(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
}
