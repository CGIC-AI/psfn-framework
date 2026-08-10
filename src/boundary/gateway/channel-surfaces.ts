import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type {
  DiscordAdapter,
  DiscordPrimaryUserBinding,
} from '../../channels/discord/adapter.js';
import type { TelegramAdapter } from '../../channels/telegram/adapter.js';
import { ChannelAdapterRegistry } from '../../channels/backplane/registry-port.js';
import { startDiscordWithRetry } from './discord-startup.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { GatewayBootstrapInput } from './bootstrap-input.js';
import type { GatewayServer } from './server.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resolveDocumentIngestLimits } from '../../faculties/file-ingest/index.js';
import type {
  AgentResponse,
  NotificationAckMetadata,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { ContactBlockGate } from './contact-block-gate.js';
import { assertDiscordAccountTokensConfigured } from '../../channels/backplane/config.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { FleetAuthAccountRosterEntry } from '../../system/config/fleet-auth-config.js';
import {
  createDiscordChannelAdapterFactoryEntry,
  createTelegramChannelAdapterFactoryEntry,
  getOptionalChannelAdapter,
  requireChannelAdapter,
} from '../../channels/backplane/channel-runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
  type RuntimeChannelLifecycleLogger,
} from '../../channels/backplane/channel-lifecycle.js';

/** One per-companion discord bot account surface (multi-companion W1-P2). */
export interface GatewayDiscordAccountSurface {
  accountId: string;
  companionId: CompanionId;
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

interface DiscordPrimaryUserAuthority {
  fleetAuth?: {
    provider: { kind: 'discord' };
    accountRoster?: readonly FleetAuthAccountRosterEntry[];
  };
}

/**
 * Resolve only system-owner roster entries that prove a Discord subject owns
 * the exact companion behind this bot account. Mutable social labels are not
 * accepted as gateway authentication evidence.
 */
export function resolveDiscordPrimaryUsers(
  config: DiscordPrimaryUserAuthority,
  companionId: CompanionId | undefined,
): DiscordPrimaryUserBinding[] {
  if (!companionId || config.fleetAuth?.provider.kind !== 'discord') return [];
  return (config.fleetAuth.accountRoster ?? [])
    .filter(entry => entry.companionId === companionId && entry.role === 'owner')
    .map(entry => ({
      userId: entry.providerSubjectId,
      ...(entry.contactId ? { canonicalContactId: entry.contactId } : {}),
    }));
}

/** All discord adapter instances owned by the gateway, in configured order. */
function listDiscordAdapters(surfaces: GatewayChannelSurfaces): DiscordAdapter[] {
  return surfaces.discordAccounts?.map(account => account.adapter) ?? [surfaces.discord];
}

function resolvePersonalFilesDir(
  bootstrap: GatewayBootstrapInput,
  companionId: CompanionId | undefined,
  surface: string,
): string {
  if (!bootstrap.server.multiCompanion.enabled) {
    return bootstrap.workspaceRoot;
  }
  if (!companionId) {
    throw new Error(`Multi-companion ${surface} surface is missing companionId routing`);
  }
  const personalFilesDir =
    bootstrap.server.multiCompanion.personalWorkspaceByCompanionId[companionId];
  if (typeof personalFilesDir !== 'string' || !personalFilesDir.trim()) {
    throw new Error(
      `Multi-companion ${surface} surface has no resolved Personal Workspace for ${companionId}`,
    );
  }
  return personalFilesDir;
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
  /** Canonical global CogSec mode (shadow/boundary/strict). */
  intakeScreeningMode: CogSecMode;
  /**
   * Fleet-only exact owner resolver. Every routed channel adapter receives
   * its owning companion's screening/quarantine composition; missing or
   * unknown identities must throw rather than falling back to another store.
   */
  intakeScreeningForCompanion?: (
    companionId: CompanionId,
  ) => IntakeScreeningService | null;
  log: RuntimeChannelLifecycleLogger;
  enableDiscordEvidenceLifecycle?: boolean;
}

export interface GatewayChannelStartupLogger extends RuntimeChannelLifecycleLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayChannelIntakeScreeningRouting {
  multiCompanion: boolean;
  mode: CogSecMode;
  singleton: IntakeScreeningService | null;
  forCompanion?: (companionId: CompanionId) => IntakeScreeningService | null;
}

export function resolveChannelIntakeScreening(
  input: GatewayChannelIntakeScreeningRouting,
  companionId: CompanionId | undefined,
  surface: string,
): IntakeScreeningService | null {
  if (!input.multiCompanion) {
    if (
      !input.singleton
      || input.singleton.globalMode !== input.mode
    ) {
      throw new Error(
        `Single-companion ${surface} intake mode=${input.mode} has no matching service`,
      );
    }
    return input.singleton;
  }
  if (!companionId) {
    throw new Error(`Multi-companion ${surface} surface is missing companionId routing`);
  }
  if (!input.forCompanion) {
    throw new Error(
      `Multi-companion ${surface} surface has no companion-owned intake screening resolver`,
    );
  }
  const screening = input.forCompanion(companionId);
  if (!screening || screening.globalMode !== input.mode) {
    throw new Error(
      `Multi-companion ${surface} intake mode=${input.mode} has no matching service for ${companionId}`,
    );
  }
  return screening;
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
  const intakeScreeningRouting: GatewayChannelIntakeScreeningRouting = {
    multiCompanion: input.bootstrap.server.multiCompanion.enabled,
    mode: input.intakeScreeningMode,
    singleton: input.intakeScreening,
    ...(input.intakeScreeningForCompanion
      ? { forCompanion: input.intakeScreeningForCompanion }
      : {}),
  };
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
        personalFilesDir: resolvePersonalFilesDir(
          input.bootstrap,
          account.companionId,
          `discord account ${account.accountId}`,
        ),
        intakeScreening: resolveChannelIntakeScreening(
          intakeScreeningRouting,
          account.companionId,
          `discord account ${account.accountId}`,
        ),
        allowedBotUserIds: account.allowedBotUserIds,
        primaryUsers: resolveDiscordPrimaryUsers(input.config, account.companionId),
        ...(account.customEmojiMeanings
          ? { customEmojiMeanings: account.customEmojiMeanings }
          : {}),
        account: {
          accountId: account.accountId,
          companionId: account.companionId,
          token: account.token,
          // Live sibling lookup through the registry: every other companion
          // account's logged-in bot user id counts as a sibling companion bot.
          siblingBotIdentities: () => accountConfigs.flatMap((siblingAccount) => {
            const registryId = `discord:${siblingAccount.accountId}`;
            if (registryId === selfRegistryId) return [];
            const botUserId = gatewayChannelRegistry
              .optional<DiscordAdapter>(registryId)?.getBotUserId();
            if (!botUserId) return [];
            return [{
              botUserId,
              companionId: siblingAccount.companionId,
            }];
          }),
        },
        enableDiscordEvidenceLifecycle: input.enableDiscordEvidenceLifecycle,
      });
    })
    : [
      createDiscordChannelAdapterFactoryEntry({
        config: input.config,
        discordConfig: discordChannelConfig,
        eventBus: input.eventBus,
        eligibilityGate: input.eligibilityGate,
        personalFilesDir: resolvePersonalFilesDir(
          input.bootstrap,
          discordChannelConfig.companionId,
          'discord',
        ),
        intakeScreening: resolveChannelIntakeScreening(
          intakeScreeningRouting,
          discordChannelConfig.companionId,
          'discord',
        ),
        primaryUsers: resolveDiscordPrimaryUsers(
          input.config,
          discordChannelConfig.companionId,
        ),
        enableDiscordEvidenceLifecycle: input.enableDiscordEvidenceLifecycle,
      }),
    ];
  const gatewayChannelManifest = buildChannelAdapterFactoryManifest([
    ...discordEntries,
    createTelegramChannelAdapterFactoryEntry({
      config: input.bootstrap.channelsConfig.telegram,
      eventBus: input.eventBus,
      personalFilesDir: resolvePersonalFilesDir(
        input.bootstrap,
        input.bootstrap.channelsConfig.telegram.companionId,
        'telegram',
      ),
      intakeScreening: resolveChannelIntakeScreening(
        intakeScreeningRouting,
        input.bootstrap.channelsConfig.telegram.companionId,
        'telegram',
      ),
      // Owner-file backed ingest caps (zet.7); Discord resolves the same
      // limits internally from its SubstrateConfig.
      documentIngestLimits: resolveDocumentIngestLimits(input.config),
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
  const notificationAck = (
    channelId: string,
    outcome: NotificationAckMetadata['outcome'],
  ): AgentResponse => ({
    content: '',
    channelId,
    metadata: {
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      notificationAck: {
        schemaVersion: 1,
        disposition: 'notification_ack',
        outcome,
      },
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
          return notificationAck(message.channelId, 'blocked_by_policy');
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
      const recipientCount = accountId
        ? input.gateway.notifyChannelMessage('discord', 'discord.message', payload, accountId)
        : input.gateway.notifyChannelMessage('discord', 'discord.message', payload);
      if (!(recipientCount > 0)) {
        throw new Error('Discord inbound notification reached zero eligible agents');
      }
      return notificationAck(message.channelId, 'forwarded_to_agent');
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
        return notificationAck(message.channelId, 'blocked_by_policy');
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
