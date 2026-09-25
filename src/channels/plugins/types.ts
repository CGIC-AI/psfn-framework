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
  /** Exact runtime-derived channel-id prefixes eligible for continuity while this plugin is enabled. */
  continuityChannelPrefixes?: readonly string[];
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
  /**
   * Display name of the companion this account serves (companions.json
   * `displayName`), when the fleet manifest declares one. Connectors that
   * assert room addressing name the companion's own account with it.
   */
  companionDisplayName?: string;
}

export interface ChannelPluginCreateInput<TConfig = unknown> {
  config: TConfig;
  secrets: Readonly<Record<string, string>>;
  context: ChannelPluginHostContext;
  /**
   * Reports a contained runtime fault of THIS instance's surface to the
   * isolation supervisor, which projects it as degraded channel health. It
   * never throws and never affects any other surface.
   */
  reportRuntimeFailure: (error: unknown) => void;
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
