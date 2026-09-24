import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ChannelSurfaceSupervisor } from '../backplane/channel-isolation.js';
import type { MessageHandlerOptions } from '../backplane/types.js';
import type {
  ChannelPlugin,
  ChannelPluginHostContext,
  ChannelPluginInstance,
  ChannelPluginLoadedSection,
  ChannelPluginRegistry,
  ChannelPluginAccountRoute,
} from './types.js';

export interface ChannelPluginHostOptions {
  registry: ChannelPluginRegistry;
  sections: Readonly<Record<string, ChannelPluginLoadedSection>>;
  vault: CredentialVaultPort;
  contextFor: (pluginId: string, section: ChannelPluginLoadedSection) => ChannelPluginHostContext;
  /** Per-instance isolation: one plugin's failure never reaches another. */
  supervisor: ChannelSurfaceSupervisor;
}

export interface ChannelPluginWiredInstance {
  id: string;
  pluginId: string;
  accountId?: string;
  companionId?: CompanionId;
  instance: ChannelPluginInstance;
}

export interface ChannelPluginMessageWiring {
  requestAgentVoiceStream: (
    message: SubstrateMessage,
    options?: { signal?: AbortSignal; channelAccountRoute?: ChannelPluginAccountRoute },
  ) => Promise<Pick<AgentResponse, 'content' | 'channelId' | 'attachments'> & {
    model: string;
    durationMs: number;
  }>;
  notifyOperator: (input: {
    sender: { kind: 'system'; provenance: string };
    title: string;
    message: string;
    priority: number;
    idempotencyKey: string;
  }) => Promise<unknown>;
}

export class ChannelPluginHost {
  readonly #instances: ChannelPluginWiredInstance[] = [];
  readonly #supervisor: ChannelSurfaceSupervisor;

  private constructor(
    instances: readonly ChannelPluginWiredInstance[],
    supervisor: ChannelSurfaceSupervisor,
  ) {
    this.#instances.push(...instances);
    this.#supervisor = supervisor;
  }

  /**
   * Instantiates every enabled plugin account. An account that cannot be
   * constructed (missing credential, invalid adapter) refuses to run itself:
   * it is disabled and reported while every other account still loads.
   */
  static async load(options: ChannelPluginHostOptions): Promise<ChannelPluginHost> {
    const created: ChannelPluginWiredInstance[] = [];
    for (const plugin of options.registry.list()) {
      const section = options.sections[plugin.manifest.id];
      if (!section?.enabled) continue;
      const accounts = section.instances && section.instances.length > 0
        ? section.instances.map(account => ({
          id: `${plugin.manifest.id}:${account.id}`,
          accountId: account.id,
          section: {
            id: plugin.manifest.id,
            enabled: true,
            config: account.config,
            credentials: account.credentials,
            ...(account.companionId ? { companionId: account.companionId } : {}),
          } satisfies ChannelPluginLoadedSection,
        }))
        : [{ id: plugin.manifest.id, accountId: undefined, section }];
      for (const account of accounts) {
        const companionId = account.section.companionId;
        try {
          created.push({
            id: account.id,
            pluginId: plugin.manifest.id,
            ...(account.accountId ? { accountId: account.accountId } : {}),
            ...(companionId ? { companionId } : {}),
            instance: await instantiatePlugin(plugin, account.section, options),
          });
        } catch (error) {
          options.supervisor.disable(
            { surfaceId: account.id, ...(companionId ? { companionId } : {}) },
            'load',
            error,
          );
        }
      }
    }
    return new ChannelPluginHost(created, options.supervisor);
  }

  list(): readonly ChannelPluginWiredInstance[] {
    return this.#instances;
  }

  /** Instances currently running (not degraded, disabled, or stopped). */
  listRunning(): readonly ChannelPluginWiredInstance[] {
    return this.#instances.filter(entry => this.#supervisor.stateOf(entry.id) === 'running');
  }

  get(id: string): ChannelPluginInstance | undefined {
    return this.#instances.find(entry => entry.id === id)?.instance;
  }

  async initialize(): Promise<void> {
    for (const entry of this.#instances) {
      await this.#supervisor.init(surfaceOf(entry), () => entry.instance.adapter.init());
    }
  }

  /**
   * Starts every plugin independently. A failed start releases that plugin
   * alone (its own stop) and, when retryable, retries it in the background.
   */
  async start(onStarted?: (entry: ChannelPluginWiredInstance) => void): Promise<void> {
    for (const entry of this.#instances) {
      await this.#supervisor.start({
        ...surfaceOf(entry),
        start: () => entry.instance.adapter.start(),
        cleanup: () => entry.instance.adapter.stop(),
        ...(onStarted ? { onStarted: () => onStarted(entry) } : {}),
      });
    }
  }

  async stop(): Promise<void> {
    for (const entry of [...this.#instances].reverse()) {
      await this.#supervisor.stop(surfaceOf(entry), () => entry.instance.adapter.stop());
    }
  }

  wireMessages(wiring: ChannelPluginMessageWiring): void {
    for (const entry of this.#instances) {
      const { id, pluginId, accountId, instance } = entry;
      const onMessage = instance.adapter.onMessage;
      if (typeof onMessage !== 'function') {
        // The plugin cannot receive messages: it refuses to run, alone.
        this.#supervisor.disable(
          surfaceOf(entry),
          'load',
          new Error(`Channel plugin "${id}" is missing onMessage bootstrap hook`),
        );
        continue;
      }
      instance.onOperatorAlert?.(async alert => {
        await wiring.notifyOperator({
          sender: { kind: 'system', provenance: `system.channels.${pluginId}_failure` },
          title: alert.title,
          message: alert.message,
          priority: 5,
          idempotencyKey: alert.idempotencyKey,
        });
      });
      onMessage.call(instance.adapter, async (message: SubstrateMessage, options?: MessageHandlerOptions) => {
        const requestOptions = {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(accountId ? { channelAccountRoute: { pluginId, accountId } } : {}),
        };
        const result = Object.keys(requestOptions).length > 0
          ? await wiring.requestAgentVoiceStream(message, requestOptions)
          : await wiring.requestAgentVoiceStream(message);
        return {
          content: result.content,
          channelId: result.channelId,
          ...(result.attachments ? { attachments: result.attachments } : {}),
          metadata: {
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: result.durationMs,
          },
        };
      });
    }
  }
}

async function instantiatePlugin(
  plugin: ChannelPlugin,
  section: ChannelPluginLoadedSection,
  options: ChannelPluginHostOptions,
): Promise<ChannelPluginInstance> {
  const secrets: Record<string, string> = {};
  for (const need of section.credentials) {
    secrets[need.id] = options.vault.resolveRequired(need.reference, need.description);
  }
  const instance = await plugin.create({
    config: section.config,
    secrets,
    context: options.contextFor(plugin.manifest.id, section),
  });
  if (instance.adapter.id !== plugin.manifest.id) {
    throw new Error(
      `Channel plugin "${plugin.manifest.id}" constructed adapter id "${instance.adapter.id}"`,
    );
  }
  return instance;
}

function surfaceOf(entry: ChannelPluginWiredInstance): { surfaceId: string; companionId?: CompanionId } {
  return {
    surfaceId: entry.id,
    ...(entry.companionId ? { companionId: entry.companionId } : {}),
  };
}
