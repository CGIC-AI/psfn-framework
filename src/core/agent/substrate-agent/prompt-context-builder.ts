// ── Prompt-context builder (charter 12.1 split, emh3p.2) ──
// Per-turn prompt/context input assembly, extracted from SubstrateAgent. Each
// method collects live agent state into the inputs of the pure *ForTurn
// functions in substrate-agent/runtime-context.ts — the collaborator owns the
// assembly, the agent owns the state. Deps are callback-shaped because most
// providers are null-until-wired after construction.

import type { SubstrateMessage, ResponseStyle } from '../../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { CoreSubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { InternalState, MetacognitiveFlag } from '../../../shared/contracts/self-model-contracts.js';
import type { EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { ConversationScope } from '../../session/conversation-scope.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { ContactTrackingGate } from '../../contacts/tracking-gate.js';
import type { CapabilityAccess } from '../../../system/capabilities/gate.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type { InternalStateContinuityGap } from '../../self-model/internal-state-persistence.js';
import type { ActiveConcernContextProvider } from '../../intention/concern-store-port.js';
import type { ActiveConcernRuntimeData } from '../../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../../intention/patterns.js';
import type { ChannelPromptRegistryPort } from '../../../channels/backplane/registry-port.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import { resolveCompanionIdFromConfig } from '../../identity/companion-runtime.js';
import { resolveRuntimePromptGuidanceVariables } from './prompt-runtime-helpers.js';
import { resolveSituatedPlaceRef } from './runtime-context-sections/situated-presence.js';
import { resolveAvailableReactions as resolveAvailableReactionsForRuntime } from './channel-routing-runtime.js';
import { resolveContextWindow as resolveContextWindowForRuntime } from './agent-state-runtime.js';
import {
  buildBehavioralNotesContextBlock as buildBehavioralNotesContextBlockForTurn,
  buildDynamicPromptTemplateVariables as buildDynamicPromptTemplateVariablesForTurn,
  buildPromptTemplateVariables as buildPromptTemplateVariablesForTurn,
  buildRuntimeContext as buildRuntimeContextForTurn,
  buildScratchpadContextBlock as buildScratchpadContextBlockForTurn,
  getPersonaAdaptation as getPersonaAdaptationForTurn,
  resolveActiveConcernsRuntimeData as resolveActiveConcernsRuntimeDataForTurn,
  resolveAuthorContext as resolveAuthorContextForTurn,
  type CompanionSubstrateHealthContext,
  type ParticipantRelationshipEdgeInput,
  type ResolvedAuthorContext,
  type UserRuntimeProfile,
} from './runtime-context.js';
import type { ScratchpadProvider } from '../contracts.js';
import type { ToolRuntimeFacade } from './tool-runtime-facade.js';
import type { EmotionSelfModelRuntime } from './emotion-self-model-runtime.js';
import type { SituatedEmanationTracker } from './runtime-context-sections/situated-emanation.js';
import type { CompanionPresenceTurnPort } from '../companion-presence-runtime.js';
import type { createComponentLogger } from '../../../shared/logger.js';

type Log = ReturnType<typeof createComponentLogger>;

export interface PromptContextBuilderDeps {
  config: CoreSubstrateConfig;
  resolveCharacterPromptVariables: () => Record<string, string>;
  getAgentModelId: () => string;
  getAgentModelContextWindow: () => { contextWindow?: unknown } | undefined;
  getAgentUserFacingBoundaryIndex: () => unknown;
  getCharacterName: () => string;
  setCharacterName: (name: string) => void;
  toolRuntimeFacade: ToolRuntimeFacade;
  getInternalStateContinuityGap: () => InternalStateContinuityGap | null;
  noteInternalStateContinuityGapRendered: () => void;
  getSkillsRuntime: () => SkillsRuntime | null;
  getCompanionPresence: () => CompanionPresenceTurnPort | null;
  placesRegistryConfig: PlacesRegistryConfig | undefined;
  getChannelRegistry: () => ChannelPromptRegistryPort;
  emotionSelfModelRuntime: EmotionSelfModelRuntime;
  getCompanionSubstrateHealthContext: () => CompanionSubstrateHealthContext | null;
  situatedEmanationTracker: SituatedEmanationTracker;
  resolveSituatedFallbackPlaceIdForTurn: (message: SubstrateMessage) => string | undefined;
  getActiveConcernProvider: () => ActiveConcernContextProvider | null;
  getBehavioralPatternProvider: () => BehavioralPatternContextProvider | null;
  getScratchpadProvider: () => ScratchpadProvider | null;
  getContactStore: () => ContactStorePort | null;
  contactTrackingGate: ContactTrackingGate | null;
  resolveCapabilityAccess: () => CapabilityAccess;
  log: Log;
}

export class PromptContextBuilder {
  constructor(private readonly deps: PromptContextBuilderDeps) {}

  getUserFacingBoundaryIndex(): number | undefined {
    const boundary = this.deps.getAgentUserFacingBoundaryIndex();
    return typeof boundary === 'number' && Number.isInteger(boundary) && boundary >= 0
      ? boundary
      : undefined;
  }

  buildPromptTemplateVariables(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    now: Date,
  ): Record<string, string> {
    const characterPromptVariables = this.deps.resolveCharacterPromptVariables();
    const runtimePromptGuidanceVariables = resolveRuntimePromptGuidanceVariables(this.deps.config);
    const { templateVariables, runtimeCharacterName } = buildPromptTemplateVariablesForTurn({
      message,
      resolvedUserName,
      trustLevel,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      now,
      characterPromptVariables,
      modelId: this.deps.getAgentModelId(),
      fallbackCharacterName: this.deps.getCharacterName(),
    });
    this.deps.setCharacterName(runtimeCharacterName);
    return {
      ...templateVariables,
      ...runtimePromptGuidanceVariables,
    };
  }

  async buildDynamicPromptTemplateVariables(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    relationshipType: ResolvedAuthorContext['relationshipType'] | undefined,
    channelType: string | undefined,
    canonicalContactKey: string | undefined,
    subjectIdentityKey: string | undefined,
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind: string | undefined,
    templateVariables: Record<string, string>,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    emotionAppraisalChain: readonly EmotionAppraisalEntry[],
    currentUserRuntimeProfile: UserRuntimeProfile | undefined,
    conversationScope: ConversationScope,
    participantRelationshipEdges: readonly ParticipantRelationshipEdgeInput[],
    capturedSessionReads: CapturedSessionReads,
  ): Promise<Record<string, string>> {
    // Owner-bound read: this builder runs inside the admitted turn's captured
    // session scope, where the raw SessionManager.getRecentMessages fails closed
    // (assertMutableSessionReadAllowed). Read through the facade so recent
    // history is scoped to the turn owner, not whatever session is active-context.
    const recentMessages = capturedSessionReads.getRecentMessages(32);
    const latestPriorMessage = [...recentMessages]
      .reverse()
      .find((entry, index) => {
        if (entry.role === 'system' || entry.role === 'tool') return false;
        if (
          index === 0
          && entry.role === 'user'
          && entry.authorId === message.authorId
          && entry.content === message.content
        ) {
          return false;
        }
        return true;
      });
    const activeToolCounts = this.deps.toolRuntimeFacade.resolveActiveToolCounts();
    const analysisWorkbenchAvailable = this.deps.toolRuntimeFacade
      .getAdaptiveToolRuntimeState()
      .activeTools
      .some(entry => entry.toolName === 'analysis_workbench');
    const extendedTools = [...this.deps.toolRuntimeFacade.getExtendedTools()];
    const coreToolNames = new Set(
      this.deps.toolRuntimeFacade.getToolCatalog().core.map(tool => tool.name),
    );

    // A continuity gap stays visible for the first turn after restart, then
    // clears (see setCurrentSelfModelState). The gap variables render through
    // the runtime.continuity_notice layer.
    if (this.deps.getInternalStateContinuityGap()) {
      this.deps.noteInternalStateContinuityGapRendered();
    }

    // One access resolution feeds BOTH the advertised tier and the advertised
    // token set (mus2.1): the prompt tool guide and the capability tool gates
    // must agree on the same grant, including an injected custom shard access.
    const capabilityAccess = this.deps.resolveCapabilityAccess();

    const skillsContext = await this.deps.getSkillsRuntime()?.getPromptXml() ?? '';
    return buildDynamicPromptTemplateVariablesForTurn({
      message,
      conversationScope,
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      modelId: this.deps.getAgentModelId(),
      capabilityTier: capabilityAccess.getTier(),
      capabilityGrantedTokens: capabilityAccess.getGrantedTokens(),
      activeToolCounts,
      extendedTools,
      coreToolNames,
      skillsContext,
      activeConcerns: this.resolveActiveConcernsRuntimeData(canonicalContactKey),
      behavioralNotesBlock: this.buildBehavioralNotesContextBlock(canonicalContactKey),
      lastMessageReceivedAtMs: latestPriorMessage?.timestamp ?? null,
      recentChannelEntries: recentMessages,
      currentUserRuntimeProfile,
      participantRelationshipEdges,
      analysisWorkbenchAvailable,
      internalStateContinuityGap: this.deps.getInternalStateContinuityGap(),
      config: this.deps.config as Record<string, unknown>,
    });
  }

  /** Build a runtime context block with live operational overlays for this turn. */
  buildRuntimeContext(
    message: SubstrateMessage,
    resolvedUserName: string,
    trustLevel: TrustLevel,
    relationshipType: ResolvedAuthorContext['relationshipType'] | undefined,
    channelType: string | undefined,
    canonicalContactKey?: string,
    subjectIdentityKey?: string,
    responseStyle: ResponseStyle = 'concise',
    now: Date = new Date(),
    taskKind?: string,
    templateVariables?: Record<string, string>,
    internalState?: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[] = [],
    emotionAppraisalChain: readonly EmotionAppraisalEntry[] = [],
    conversationScope?: ConversationScope,
  ): string {
    const activeToolCounts = this.deps.toolRuntimeFacade.resolveActiveToolCounts();
    // Dual-presence fallback (vinz.29): single per-turn resolution shared by
    // the co-presence read below AND the rendered situated block, so "Also
    // here:" always agrees with "Here:" — including on mindspace (plain-chat)
    // turns that foreground the twin of the last-known physical room.
    const situatedFallbackPlaceId = this.deps.resolveSituatedFallbackPlaceIdForTurn(message);
    // Co-presence (W5a): resolved against the SAME place resolution the
    // situated block performs — turn place first, then the dual-presence
    // fallback (deliberate virtual move, session/default twin, or a
    // physical-origin emanation fallback) — so "Also here:" agrees with the rendered "Here:" on
    // placeless turns too; null companionPresence (flag-off) yields no
    // coPresent input and byte-identical rendering.
    const companionPresence = this.deps.getCompanionPresence();
    const situatedPlace = companionPresence
      ? resolveSituatedPlaceRef(
        message,
        this.deps.placesRegistryConfig,
        situatedFallbackPlaceId,
      )
      : undefined;
    const coPresent = situatedPlace
      ? companionPresence?.getCoPresent(situatedPlace)
      : undefined;
    // Curated reaction surface (jp36.3.1.2): resolved from the turn's channel
    // adapter (standard subset plus guild-custom emojis with a configured
    // one-line meaning). Undefined on channels that expose no reaction surface.
    const reactionSurface = resolveAvailableReactionsForRuntime(message, this.deps.getChannelRegistry());
    return buildRuntimeContextForTurn({
      message,
      ...(conversationScope ? { conversationScope } : {}),
      resolvedUserName,
      trustLevel,
      relationshipType,
      channelType,
      canonicalContactKey,
      subjectIdentityKey,
      responseStyle,
      now,
      taskKind,
      templateVariables,
      internalState,
      metacognitiveFlags,
      emotionAppraisalChain,
      modelId: this.deps.getAgentModelId(),
      contextWindow: resolveContextWindowForRuntime(
        this.deps.config,
        this.deps.getAgentModelContextWindow(),
      ),
      capabilityTier: this.deps.resolveCapabilityAccess().getTier(),
      activeToolCounts,
      extendedTools: [...this.deps.toolRuntimeFacade.getExtendedTools()],
      coreToolNames: new Set(this.deps.toolRuntimeFacade.getToolCatalog().core.map(tool => tool.name)),
      skillsContext: this.deps.getSkillsRuntime()?.getCachedPromptXml() ?? '',
      behavioralNotesBlock: this.buildBehavioralNotesContextBlock(canonicalContactKey),
      formatTopEmotions: (discrete) => this.deps.emotionSelfModelRuntime.formatTopEmotions(discrete),
      config: this.deps.config as unknown as Record<string, unknown>,
      substrateHealth: this.deps.getCompanionSubstrateHealthContext(),
      ...(this.deps.placesRegistryConfig ? { placesRegistry: this.deps.placesRegistryConfig } : {}),
      ...(coPresent && coPresent.length > 0 ? { coPresent } : {}),
      emanationTracker: this.deps.situatedEmanationTracker,
      ...(situatedFallbackPlaceId ? { situatedFallbackPlaceId } : {}),
      ...(reactionSurface ? { reactionSurface } : {}),
    });
  }

  resolveActiveConcernsRuntimeData(canonicalContactKey?: string): ActiveConcernRuntimeData | undefined {
    return resolveActiveConcernsRuntimeDataForTurn({
      activeConcernProvider: this.deps.getActiveConcernProvider(),
      canonicalContactKey,
      logger: this.deps.log,
    });
  }

  buildBehavioralNotesContextBlock(canonicalContactKey?: string): string {
    return buildBehavioralNotesContextBlockForTurn({
      behavioralPatternProvider: this.deps.getBehavioralPatternProvider(),
      canonicalContactKey,
      logger: this.deps.log,
    });
  }

  buildScratchpadContextBlock(): string {
    return buildScratchpadContextBlockForTurn({
      scratchpadProvider: this.deps.getScratchpadProvider(),
      logger: this.deps.log,
    });
  }

  getPersonaAdaptation(
    trustLevel: TrustLevel,
    internalState: InternalState,
    metacognitiveFlags: readonly MetacognitiveFlag[],
    templateVariables?: Record<string, string>,
  ): string | null {
    return getPersonaAdaptationForTurn({
      trustLevel,
      internalState,
      metacognitiveFlags,
      templateVariables,
      config: this.deps.config as unknown as Record<string, unknown>,
    });
  }

  async resolveAuthorContext(message: SubstrateMessage): Promise<ResolvedAuthorContext> {
    return resolveAuthorContextForTurn({
      message,
      contactStore: this.deps.getContactStore(),
      logger: this.deps.log,
      companionIdentityKey: resolveCompanionIdFromConfig(this.deps.config),
      companionDisplayName: this.deps.getCharacterName(),
      ...(this.deps.contactTrackingGate ? { contactTracking: this.deps.contactTrackingGate } : {}),
    });
  }
}
