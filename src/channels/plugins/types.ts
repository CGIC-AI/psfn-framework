import type { CredentialReference } from '../../boundary/custody/credential-vault.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { RuntimeChannelLifecycleLogger } from '../backplane/channel-lifecycle.js';
import type { ChannelAdapterPort } from '../backplane/types.js';

interface ChannelPluginCredentialNeed {
  id: string;
  reference: CredentialReference;
  description: string;
}

interface ChannelPluginManifest {
  id: string;
  label: string;
}

export interface ChannelPluginParseResult<TConfig = unknown> {
  config: TConfig;
  enabled: boolean;
  companionId?: CompanionId;
  credentials: readonly ChannelPluginCredentialNeed[];
  instances?: readonly ChannelPluginParsedInstance<TConfig>[];
}

interface ChannelPluginParsedInstance<TConfig = unknown> {
  id: string;
  config: TConfig;
  companionId?: CompanionId;
  credentials: readonly ChannelPluginCredentialNeed[];
}

/** Host-authenticated account route; message content cannot supply either field. */
export interface ChannelPluginAccountRoute {
  pluginId: string;
  accountId: string;
}

export interface ChannelPluginLoadedSection<TConfig = unknown> extends ChannelPluginParseResult<TConfig> {
  id: string;
}

interface ChannelPluginOperatorAlert {
  title: string;
  message: string;
  idempotencyKey: string;
}

export interface ChannelPluginHostContext {
  log: RuntimeChannelLifecycleLogger;
  shutdownTimeoutMs: number;
  intakeScreening: IntakeScreeningService | null;
  postgresDatabaseUrl?: string;
}

export interface ChannelPluginCreateInput<TConfig = unknown> {
  config: TConfig;
  secrets: Readonly<Record<string, string>>;
  context: ChannelPluginHostContext;
}

export interface ChannelPluginInstance {
  adapter: ChannelAdapterPort;
  onOperatorAlert?: (handler: (alert: ChannelPluginOperatorAlert) => Promise<void>) => void;
}

export interface ChannelPlugin<TConfig = unknown> {
  readonly manifest: ChannelPluginManifest;
  parseConfig(raw: unknown): ChannelPluginParseResult<TConfig>;
  create(
    input: ChannelPluginCreateInput<TConfig>,
  ): Promise<ChannelPluginInstance> | ChannelPluginInstance;
}

export interface ChannelPluginRegistry {
  get(id: string): ChannelPlugin | undefined;
  has(id: string): boolean;
  list(): readonly ChannelPlugin[];
}
