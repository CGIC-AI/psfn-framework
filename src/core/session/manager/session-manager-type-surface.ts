import type { MemoryScopeQuery } from '../../../faculties/memory/types.js';
import type { LLMContext } from '../../../shared/contracts/runtime.js';
import type {
  AdaptiveContextBudgetProfile,
  ContextBudgetTurnCharacteristics,
} from '../../../shared/context-budget.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { LLMProviderPort } from '../../agent/contracts.js';
import type { TurnSessionContextSnapshot } from '../../turns/snapshot.js';
import type { TurnChannelBondInput } from '../channel-bond.js';
import type { ContextManifestMemorySeed } from '../context-manifest.js';
import type {
  ConversationScope,
  ConversationScopeContact,
  ConversationScopeSpeaker,
} from '../conversation-scope.js';
import type { SessionEntry } from '../types.js';

export interface AutoCompactionBetweenTurnsParams {
  channelId: string;
  systemPrompt?: string;
  memoriesBlock?: string;
  /** Durable jobs persist counts and hashes, never a second prompt/content copy. */
  systemPromptTokenCount?: number;
  memoriesTokenCount?: number;
  adaptiveProfile?: AdaptiveContextBudgetProfile;
  llmProvider: LLMProviderPort;
  userId?: string;
  channelMeta?: ChannelMeta;
  compactionPromptText?: string;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  icpCorrelation?: IcpConversationCorrelation;
  throwOnFailure?: boolean;
  assertEffectAllowed?: () => Promise<void>;
  /** Exact source-bounded input captured and rechecked under TurnRecord fences; empty is authoritative. */
  capturedRecentEntries?: readonly SessionEntry[];
}

export type AutoCompactionRecentEntriesCaptureParams = Pick<
  AutoCompactionBetweenTurnsParams,
  'channelId' | 'adaptiveProfile' | 'turnBudgetCharacteristics'
> & {
  maxSessionEntryId?: number;
  now?: Date;
};

export interface TurnSessionContextCaptureParams {
  channelId: string;
  userId?: string;
  channelMeta?: ChannelMeta;
  continuityFallbackUserIds?: string[];
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  /** Optional LLM provider for foreground history-budget summarization. */
  llmProvider?: LLMProviderPort;
  excludeSessionEntryId?: number;
  /** Channel bonding opt-in for the turn. */
  channelBond?: TurnChannelBondInput;
}

export interface SessionManagerTypeSurface {
  buildContext(
    channelId: string,
    systemPrompt: string,
    memoriesBlock: string,
    llmProvider?: LLMProviderPort,
    userId?: string,
    channelMeta?: ChannelMeta,
    continuityFallbackUserIds?: string[],
    turnSessionContext?: TurnSessionContextSnapshot,
    memoryManifestSeed?: ContextManifestMemorySeed,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    conversationScope?: ConversationScope,
    excludeSessionEntryId?: number,
    channelBond?: TurnChannelBondInput,
  ): Promise<LLMContext>;

  captureTurnSessionContext(
    input: TurnSessionContextCaptureParams,
  ): Promise<TurnSessionContextSnapshot>;

  getRecentMessages(channelId: string, limit?: number): SessionEntry[];

  getRecentMessagesAtOrBefore(
    channelId: string,
    maxEntryId: number,
    limit: number,
  ): SessionEntry[];

  getRoleEnvelopeRefsForEntries(
    channelId: string,
    sessionEntryIds: readonly number[],
  ): string[];

  scheduleAutoCompactionBetweenTurns(
    params: AutoCompactionBetweenTurnsParams,
  ): Promise<void>;

  captureAutoCompactionRecentEntries(
    params: AutoCompactionRecentEntriesCaptureParams,
  ): SessionEntry[];

  hasPendingAutoCompaction(channelId: string): boolean;

  getActiveFocusMemoryScopeQuery(channelId: string): MemoryScopeQuery | null;

  getRecentConversationSpeakers(channelId: string): ConversationScopeSpeaker[];

  resolveConversationScope(input: {
    channelId: string;
    channelMeta?: ChannelMeta;
    userId?: string;
    contact?: ConversationScopeContact;
    recentSpeakers?: readonly ConversationScopeSpeaker[];
    resolvedSpeakerContactCount?: number;
  }): ConversationScope;

  reconcileSessionChannelFromDisk(
    channelId: string,
  ): Promise<{ maxEntryId: number; lastMessageEntryId: number | null } | null>;
}
