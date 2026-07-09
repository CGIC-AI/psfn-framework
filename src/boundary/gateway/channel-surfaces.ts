import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { DiscordAdapter } from '../../channels/discord/adapter.js';
import type { TelegramAdapter } from '../../channels/telegram/adapter.js';
import { ChannelAdapterRegistry } from '../../channels/backplane/registry-port.js';
import { startDiscordWithRetry } from './discord-startup.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import type { GatewayServer } from './server.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ContactBlockGate } from './contact-block-gate.js';
import { assertDiscordAccountTokensConfigured } from '../../channels/backplane/config.js';
import {
  createDiscordChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from '../../app/startup/composition/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
  type RuntimeChannelLifecycleLogger,
} from '../../app/startup/support/channel-lifecycle.js';

/** One per-companion discord bot account surface (multi-companion W1-P2). */
export interface GatewayDiscordAccountSurface {
  accountId: string;
  companionId: string;
  adapter: DiscordAdapter;
}

export interface GatewayChannelSurfaces {
  /**
   * Single-account adapter, or the primary (first configured) account in
   * multi-account mode — used for gateway-level surfaces (operator
   * notifications, voice modules) that predate per-companion accounts.
   */
  discord: DiscordAdapter;
  /** Present only in multi-account mode; includes the primary account. */
  discordAccounts?: GatewayDiscordAccountSurface[];
  telegram?: TelegramAdapter;
}

/** All discord adapter instances owned by the gateway, in configured order. */
function listDiscordAdapters(surfaces: GatewayChannelSurfaces): DiscordAdapter[] {
  return surfaces.discordAccounts?.map(account => account.adapter) ?? [surfaces.discord];
}

export interface LoadGatewayChannelSurfacesInput {
  config: SubstrateConfig;
  bootstrap: GatewayBootstrapInput;
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  /**
   * Cognition intake firewall (htm9.2): screens parsed Discord document
   * attachment text at ingest. Null when intake-policy mode is 'off'.
   */
  intakeScreening: IntakeScreeningService | null;
  log: RuntimeChannelLifecycleLogger;
}

export interface GatewayChannelStartupLogger extends RuntimeChannelLifecycleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

export async function initGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
): Promise<void> {
  if (surfaces.telegram) {
    await surfaces.telegram.init();
  }
  for (const discord of listDiscordAdapters(surfaces)) {
    await discord.init();
  }
}

export async function loadGatewayChannelSurfaces(
  input: LoadGatewayChannelSurfacesInput,
): Promise<GatewayChannelSurfaces> {
  const discordChannelConfig = input.bootstrap.channelsConfig.discord;
  const accountConfigs = discordChannelConfig.accounts ?? [];
  const multiAccount = accountConfigs.length > 0;
  if (multiAccount) {
    // Fail closed before constructing any adapter: a configured account whose
    // token env var is unset must stop gateway startup, never degrade.
    assertDiscordAccountTokensConfigured(discordChannelConfig);
  }

  const gatewayChannelRegistry = new ChannelAdapterRegistry();
  const accountRegistryIds = accountConfigs.map(account => `discord:${account.accountId}`);
  const discordEntries = multiAccount
    ? accountConfigs.map((account, index) => {
      const selfRegistryId = accountRegistryIds[index]!;
      return createDiscordChannelAdapterFactoryEntry({
        config: input.config,
        eventBus: input.eventBus,
        eligibilityGate: input.eligibilityGate,
        personalFilesDir: input.bootstrap.workspaceRoot,
        intakeScreening: input.intakeScreening,
        allowedBotUserIds: account.allowedBotUserIds,
        account: {
          accountId: account.accountId,
          token: account.token,
          // Live sibling lookup through the registry: every other companion
          // account's logged-in bot user id counts as a sibling companion bot.
          siblingBotUserIds: () => accountRegistryIds
            .filter(registryId => registryId !== selfRegistryId)
            .map(registryId => gatewayChannelRegistry
              .optional<DiscordAdapter>(registryId)?.getBotUserId())
            .filter((botUserId): botUserId is string => Boolean(botUserId)),
        },
      });
    })
    : [
      createDiscordChannelAdapterFactoryEntry({
        config: input.config,
        discordConfig: discordChannelConfig,
        eventBus: input.eventBus,
        eligibilityGate: input.eligibilityGate,
        personalFilesDir: input.bootstrap.workspaceRoot,
        intakeScreening: input.intakeScreening,
      }),
    ];
  const gatewayChannelManifest = buildChannelAdapterFactoryManifest([
    ...discordEntries,
    createTelegramChannelAdapterFactoryEntry({
      config: input.bootstrap.channelsConfig.telegram,
      eventBus: input.eventBus,
      personalFilesDir: input.bootstrap.workspaceRoot,
      intakeScreening: input.intakeScreening,
    }),
  ]);

  await loadChannelAdaptersFromManifest(
    gatewayChannelRegistry,
    gatewayChannelManifest,
    () => undefined,
    input.log,
    input.eligibilityGate,
  );

  if (multiAccount) {
    const discordAccounts: GatewayDiscordAccountSurface[] = accountConfigs.map((account, index) => ({
      accountId: account.accountId,
      companionId: account.companionId,
      adapter: requireChannelAdapter<DiscordAdapter>(gatewayChannelRegistry, accountRegistryIds[index]!),
    }));
    return {
      discord: discordAccounts[0]!.adapter,
      discordAccounts,
      telegram: getOptionalChannelAdapter<TelegramAdapter>(gatewayChannelRegistry, 'telegram') ?? undefined,
    };
  }

  return {
    discord: requireChannelAdapter<DiscordAdapter>(gatewayChannelRegistry, 'discord'),
    telegram: getOptionalChannelAdapter<TelegramAdapter>(gatewayChannelRegistry, 'telegram') ?? undefined,
  };
}

export interface WireGatewayChannelMessagesInput {
  discord: Pick<DiscordAdapter, 'onMessage'>;
  /**
   * Multi-account mode (W1-P2): wire each account's adapter with its own
   * accountId so inbound messages route to exactly that account's companion.
   * The primary `discord` adapter is part of this list and must not be wired
   * separately when accounts are present.
   */
  discordAccounts?: Array<{ accountId: string; adapter: Pick<DiscordAdapter, 'onMessage'> }>;
  telegram?: Pick<TelegramAdapter, 'onMessage'>;
  gateway: Pick<GatewayServer, 'notifyChannelMessage' | 'requestAgentVoiceStream'>;
  serializeMessage: (message: SubstrateMessage) => Record<string, unknown>;
  /**
   * Companion-initiated block gate (htm9.16). When present, inbound from a
   * blocked contact is dropped (DM) or downgraded to observe-only (group)
   * here at the gateway, before the message is forwarded to the agent process.
   */
  blockGate?: ContactBlockGate;
}

export function wireGatewayChannelMessages(input: WireGatewayChannelMessagesInput): void {
  const emptyAck = (channelId: string) => ({
    content: '',
    channelId,
    metadata: {
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    },
  });

  const wireDiscordInbound = (
    adapter: Pick<DiscordAdapter, 'onMessage'>,
    accountId?: string,
  ): void => {
    adapter.onMessage(async (message) => {
      // htm9.16 backstop: enforce companion blocks before anything crosses the
      // RPC boundary to the agent process.
      let outbound = message;
      if (input.blockGate) {
        const decision = input.blockGate.evaluate(message);
        if (decision.action === 'drop') {
          // Blocked DM: soft blocks emit an operator-visible cogsec event, hard
          // blocks stay silent. Either way the agent never sees the message.
          input.blockGate.recordSoftBlockEnforcement(message, decision);
          return emptyAck(message.channelId);
        }
        if (decision.action === 'observe') {
          // Blocked group message: the companion ignores it (observe-only)
          // rather than dropping and disrupting the room for everyone else.
          input.blockGate.recordSoftBlockEnforcement(message, decision);
          outbound = {
            ...message,
            routing: { ...(message.routing ?? {}), responseMode: 'observe' as const },
          };
        }
      }
      // Single-companion mode broadcasts (historic behavior); multi-companion
      // mode delivers to exactly the companion owning the discord surface —
      // per bot account when accounts are configured — and fails closed on
      // any routing ambiguity.
      const payload = { message: input.serializeMessage(outbound) };
      if (accountId) {
        input.gateway.notifyChannelMessage('discord', 'discord.message', payload, accountId);
      } else {
        input.gateway.notifyChannelMessage('discord', 'discord.message', payload);
      }
      return emptyAck(message.channelId);
    });
  };

  if (input.discordAccounts && input.discordAccounts.length > 0) {
    for (const account of input.discordAccounts) {
      wireDiscordInbound(account.adapter, account.accountId);
    }
  } else {
    wireDiscordInbound(input.discord);
  }

  if (!input.telegram) {
    return;
  }
  if (typeof input.telegram.onMessage !== 'function') {
    throw new Error('Telegram adapter is missing onMessage bootstrap hook');
  }

  input.telegram.onMessage(async (message) => {
    // htm9.16 backstop: a blocked telegram DM is dropped before it reaches the
    // agent. Group observe-downgrade is not modeled on the telegram
    // request/response path; blocked group messages fall through unchanged.
    if (input.blockGate) {
      const decision = input.blockGate.evaluate(message);
      if (decision.action === 'drop') {
        input.blockGate.recordSoftBlockEnforcement(message, decision);
        return emptyAck(message.channelId);
      }
    }
    const result = await input.gateway.requestAgentVoiceStream(message);
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

export async function startGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
  bootstrap: GatewayBootstrapInput,
  log: GatewayChannelStartupLogger,
): Promise<void> {
  const discordAdapters = listDiscordAdapters(surfaces);
  for (const [index, discord] of discordAdapters.entries()) {
    const accountId = surfaces.discordAccounts?.[index]?.accountId;
    let discordStartAttempts = 0;
    await startDiscordWithRetry(
      async () => {
        discordStartAttempts += 1;
        await discord.start();
      },
      {
        baseDelayMs: bootstrap.discordStartRetry.baseDelayMs,
        maxDelayMs: bootstrap.discordStartRetry.maxDelayMs,
        maxAttempts: bootstrap.discordStartRetry.maxAttempts,
        onRetry: ({ attempt, delayMs, maxAttempts, error }) => {
          const rawCode = (error as Error & { code?: unknown }).code;
          const code = typeof rawCode === 'string' ? rawCode : undefined;
          log.warn('Discord startup failed; retrying', {
            attempt,
            ...(accountId ? { accountId } : {}),
            ...(maxAttempts > 0 ? { maxAttempts } : { maxAttempts: 'unbounded' }),
            delayMs,
            ...(code ? { code } : {}),
            error: error.message,
          });
        },
      },
    );
    if (discordStartAttempts > 1) {
      log.info('Discord startup recovered after retries', {
        attempts: discordStartAttempts,
        ...(accountId ? { accountId } : {}),
      });
    }
  }
  if (surfaces.discordAccounts && surfaces.discordAccounts.length > 0) {
    log.info('Discord multi-account surfaces started', {
      accounts: surfaces.discordAccounts.map(account => ({
        accountId: account.accountId,
        companionId: account.companionId,
        botUserId: account.adapter.getBotUserId(),
      })),
    });
  }

  if (!surfaces.telegram) {
    return;
  }

  await surfaces.telegram.start();
  log.info('Telegram gateway bridge enabled', {
    mode: bootstrap.channelsConfig.telegram.mode,
    allowlistSize: bootstrap.channelsConfig.telegram.allowedUsers.length,
  });
}

export async function stopGatewayChannelSurfaces(
  surfaces: GatewayChannelSurfaces,
): Promise<void> {
  await surfaces.telegram?.stop();
  for (const discord of [...listDiscordAdapters(surfaces)].reverse()) {
    await discord.stop();
  }
}
