import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { MessageHandlerOptions } from '../backplane/types.js';
import type {
  ChannelPlugin,
  ChannelPluginHostContext,
  ChannelPluginInstance,
  ChannelPluginLoadedSection,
  ChannelPluginRegistry,
} from './types.js';

export interface ChannelPluginHostOptions {
  registry: ChannelPluginRegistry;
  sections: Readonly<Record<string, ChannelPluginLoadedSection>>;
  vault: CredentialVaultPort;
  contextFor: (pluginId: string, section: ChannelPluginLoadedSection) => ChannelPluginHostContext;
}

export interface ChannelPluginWiredInstance {
  id: string;
  instance: ChannelPluginInstance;
}

export interface ChannelPluginMessageWiring {
  requestAgentVoiceStream: (
    message: SubstrateMessage,
    options?: { signal?: AbortSignal },
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
  #started = 0;

  private constructor(instances: readonly ChannelPluginWiredInstance[]) {
    this.#instances.push(...instances);
  }

  static async load(options: ChannelPluginHostOptions): Promise<ChannelPluginHost> {
    const created: ChannelPluginWiredInstance[] = [];
    try {
      for (const plugin of options.registry.list()) {
        const section = options.sections[plugin.manifest.id];
        if (!section?.enabled) continue;
        created.push({
          id: plugin.manifest.id,
          instance: await instantiatePlugin(plugin, section, options),
        });
      }
      return new ChannelPluginHost(created);
    } catch (error) {
      await stopInstances(created);
      throw error;
    }
  }

  list(): readonly ChannelPluginWiredInstance[] {
    return this.#instances;
  }

  get(id: string): ChannelPluginInstance | undefined {
    return this.#instances.find(entry => entry.id === id)?.instance;
  }

  async initialize(): Promise<void> {
    for (const [index, entry] of this.#instances.entries()) {
      try {
        await entry.instance.adapter.init();
      } catch (error) {
        await stopInstances(this.#instances.slice(0, index + 1));
        throw new Error(
          `Channel plugin "${entry.id}" failed to initialize: ${String(error)}`,
          { cause: error },
        );
      }
    }
  }

  async start(): Promise<void> {
    this.#started = 0;
    for (const entry of this.#instances) {
      try {
        await entry.instance.adapter.start();
        this.#started += 1;
      } catch (error) {
        // Stop the adapter whose start just failed plus every adapter that
        // started before it, mirroring the initialize() rollback contract.
        await stopInstances(this.#instances.slice(0, this.#started + 1));
        this.#started = 0;
        throw new Error(
          `Channel plugin "${entry.id}" failed to start: ${String(error)}`,
          { cause: error },
        );
      }
    }
  }

  async stop(): Promise<void> {
    const running = this.#instances.slice(0, this.#started);
    this.#started = 0;
    await stopInstances(running);
  }

  wireMessages(wiring: ChannelPluginMessageWiring): void {
    for (const { id, instance } of this.#instances) {
      instance.onOperatorAlert?.(async alert => {
        await wiring.notifyOperator({
          sender: { kind: 'system', provenance: `system.channels.${id}_failure` },
          title: alert.title,
          message: alert.message,
          priority: 5,
          idempotencyKey: alert.idempotencyKey,
        });
      });
      const onMessage = instance.adapter.onMessage;
      if (typeof onMessage !== 'function') {
        throw new Error(`Channel plugin "${id}" is missing onMessage bootstrap hook`);
      }
      onMessage.call(instance.adapter, async (message: SubstrateMessage, options?: MessageHandlerOptions) => {
        const result = options?.signal
          ? await wiring.requestAgentVoiceStream(message, { signal: options.signal })
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

async function stopInstances(entries: readonly ChannelPluginWiredInstance[]): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await entry.instance.adapter.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Channel plugin host failed to stop one or more plugins');
  }
}
