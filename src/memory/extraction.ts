import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionStore } from '../session/store.js';
import type { SessionEntry } from '../session/types.js';
import type { EventBus } from '../event-bus.js';
import type { MemoryStore } from './store.js';
import type { ExtractedFact, MemoryType, SensitivityLevel } from './types.js';
import { VALID_MEMORY_TYPES, MEMORY_CONFIG, VALID_SENSITIVITY_LEVELS } from './types.js';
import type { SubstrateConfig } from '../types.js';
import { countMessageTokens } from '../llm/tokens.js';
import { MemoryWriter, type WriteResult } from './writer.js';
import { createComponentLogger } from '../logger.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import {
  EXTRACTION_PROMPT_KEY,
  PROFILE_SYNTHESIS_PROMPT_KEY,
  getDefaultPromptText,
} from '../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import { classifyChannel } from '../trust/policy.js';
import type { ChannelVisibility } from '../trust/types.js';
import { extractBoundaryFactsFromEntries } from './boundary-log.js';
const log = createComponentLogger('Extraction');

// Track last extraction per channel
const lastExtractionCount = new Map<string, number>();

function toTokenMessage(entry: { role: string; content: string }): { role: string; content: string } {
  if (entry.role === 'assistant') return { role: 'assistant', content: entry.content };
  if (entry.role === 'system') return { role: 'user', content: `[System note] ${entry.content}` };
  return { role: 'user', content: entry.content };
}

export interface MemoryExtractorConfig {
  extractionInterval?: number;
  minImportance?: number;
  minConfidence?: number;
  minNovelty?: number;
  maxWrites?: number;
  telemetryEnabled?: boolean;
}

export interface MemoryExtractorDrainOptions {
  timeoutMs?: number;
}

type ExtractionTriggerReason =
  | 'manual'
  | 'interval'
  | 'context_threshold'
  | 'interval_and_threshold'
  | 'pre_compaction'
  | 'crash_recovery';
type ExtractionRejectionReason =
  | 'low_importance'
  | 'low_confidence'
  | 'low_novelty'
  | 'low_signal'
  | 'write_cap';
type ProfileRefreshReason = 'memory_update' | 'interval' | 'memory_update_and_interval';

interface ExtractionGateConfig {
  minImportance: number;
  minConfidence: number;
  minNovelty: number;
}

interface FactAcceptanceDecision {
  accepted: boolean;
  reason?: ExtractionRejectionReason;
  novelty: number;
}

interface ExtractionEndTelemetry {
  channelId: string;
  count: number;
  triggerReason: ExtractionTriggerReason;
  coveredUpToMessageId?: number;
  parsedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  writeCount: number;
  deduplicatedCount: number;
  supersededCount: number;
  rejectionBreakdown: Record<ExtractionRejectionReason, number>;
}

interface ProfileSynthesisConfig {
  enabled: boolean;
  refreshIntervalMs: number;
  cooldownMs: number;
  minWrites: number;
  minImportance: number;
  minConfidence: number;
  minNovelty: number;
  sourceMemoryLimit: number;
  minSourceMemories: number;
}

interface AcceptedFactWrite {
  memoryId: string;
  importance: number;
  confidence: number;
}

interface AcceptedFactCandidate {
  fact: ExtractedFact;
  novelty: number;
  valueScore: number;
  index: number;
}

const DEFAULT_MIN_IMPORTANCE = 0.45;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_NOVELTY = 0.35;
const DEFAULT_MAX_WRITES = 2;
const DEFAULT_PROFILE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROFILE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_MIN_WRITES = 1;
const DEFAULT_PROFILE_MIN_IMPORTANCE = 0.65;
const DEFAULT_PROFILE_MIN_CONFIDENCE = 0.7;
const DEFAULT_PROFILE_MIN_NOVELTY = 0.12;
const DEFAULT_PROFILE_SOURCE_MEMORY_LIMIT = 16;
const DEFAULT_PROFILE_MIN_SOURCE_MEMORIES = 2;
const RECOVERY_CONTEXT_MESSAGE_LIMIT = 50;
const RELATIONSHIP_SIGNAL_HINTS = new Set([
  'partner',
  'spouse',
  'wife',
  'husband',
  'fiance',
  'fiancee',
  'girlfriend',
  'boyfriend',
  'sister',
  'brother',
  'mother',
  'father',
  'mom',
  'dad',
  'parent',
  'son',
  'daughter',
  'child',
  'family',
  'roommate',
  'friend',
  'coworker',
  'colleague',
  'manager',
  'mentor',
]);
const LOW_SIGNAL_EXACT_TEXT = new Set([
  'hi',
  'hello',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
  'how are you',
  'whats up',
  'thank you',
  'thanks',
  'bye',
  'goodbye',
  'see you',
  'talk later',
]);
const LOW_SIGNAL_PATTERNS = [
  /\b(user|assistant)\s+(greeted|greets|said|says|thanked|thanks|apologized|asked)\b.*\b(hi|hello|hey|thanks|thank you|goodbye|bye|how are you|whats up)\b/,
  /\b(exchanged|shared)\s+(greetings|pleasantries|small talk|chit chat|chitchat)\b/,
  /\b(quick|brief|short|rapid)\s+(chat|conversation|exchange|back and forth|chatter)\b/,
  /\bquick succession chatter\b/,
  /\b(user|assistant)\s+(joined|left|started|ended)\s+(the )?(chat|conversation)\b/,
  /\b(greetings|pleasantries|small talk|chit chat|chitchat)\b/,
];

export class MemoryExtractor {
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private memoryStore: MemoryStore;
  private writer: MemoryWriter;
  private eventBus: EventBus;
  private runtimeConfig: SubstrateConfig | null;
  private extractionInterval: number;
  private minImportance: number;
  private minConfidence: number;
  private minNovelty: number;
  private maxWrites: number;
  private telemetryEnabled: boolean;
  private promptRegistry: PromptRegistryStore | null;
  private sessionStore: SessionStore | null;
  private acceptingExtractions = true;
  private inFlightExtractions = new Set<Promise<void>>();
  private inFlightByChannel = new Map<string, Promise<void>>();
  private inFlightProfileRefreshes = new Set<Promise<void>>();
  private inFlightProfileByContact = new Map<string, Promise<void>>();

  constructor(
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    eventBus: EventBus,
    config?: MemoryExtractorConfig | SubstrateConfig,
    promptRegistry?: PromptRegistryStore | null,
    sessionStore?: SessionStore | null,
  ) {
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.memoryStore = memoryStore;
    this.writer = new MemoryWriter(memoryStore, embeddingService);
    this.eventBus = eventBus;
    // If config has extractionInterval as a direct number property on SubstrateConfig, use per-call
    if (config && 'primaryModel' in config) {
      this.runtimeConfig = config;
      this.extractionInterval = config.extractionInterval;
      this.minImportance = config.memoryExtractionMinImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = config.memoryExtractionMinConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = config.memoryExtractionMinNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(config.memoryExtractionMaxWrites, DEFAULT_MAX_WRITES);
      this.telemetryEnabled = config.memoryExtractionTelemetryEnabled ?? true;
    } else {
      const extractorConfig = config as MemoryExtractorConfig | undefined;
      this.runtimeConfig = null;
      this.extractionInterval = extractorConfig?.extractionInterval ?? MEMORY_CONFIG.extractionInterval;
      this.minImportance = extractorConfig?.minImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = extractorConfig?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = extractorConfig?.minNovelty ?? DEFAULT_MIN_NOVELTY;
      this.maxWrites = normalizeMaxWrites(extractorConfig?.maxWrites, DEFAULT_MAX_WRITES);
      this.telemetryEnabled = extractorConfig?.telemetryEnabled ?? true;
    }
    this.promptRegistry = promptRegistry ?? null;
    this.sessionStore = sessionStore ?? null;
  }

  async queueRetroactiveExtraction(
    channelId: string,
    recoveredEntries: SessionEntry[],
    canonicalContactId?: string,
  ): Promise<void> {
    if (recoveredEntries.length === 0) return;
    if (!this.acceptingExtractions) {
      log.debug('Skipping crash recovery extraction while extractor is draining', { channelId });
      return;
    }

    const orderedEntries = [...recoveredEntries].sort((left, right) => left.id - right.id);
    await this.trackExtraction(
      channelId,
      'crash_recovery',
      canonicalContactId,
      orderedEntries,
    );
  }

  async queueCompactionExtraction(
    channelId: string,
    compactedEntries: SessionEntry[],
    canonicalContactId?: string,
  ): Promise<void> {
    if (compactedEntries.length === 0) return;
    if (!this.acceptingExtractions) {
      log.debug('Skipping pre-compaction extraction while extractor is draining', { channelId });
      return;
    }

    const orderedEntries = [...compactedEntries].sort((left, right) => left.id - right.id);
    await this.trackExtraction(
      channelId,
      'pre_compaction',
      canonicalContactId,
      orderedEntries,
    );
  }

  async maybeExtract(channelId: string, canonicalContactId?: string): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction trigger while extractor is draining', { channelId });
      return;
    }

    const currentCount = this.sessionManager.getMessageCount(channelId);
    const lastCount = lastExtractionCount.get(channelId) ?? 0;

    // Read interval per-call from live config if available
    const interval = this.runtimeConfig?.extractionInterval ?? this.extractionInterval;
    const intervalMet = currentCount - lastCount >= interval;

    // Also trigger extraction when session content exceeds % of context window
    let thresholdMet = false;
    let totalTokens = 0;
    let tokenBudget = 0;
    let thresholdPct: number | null = null;
    if (this.runtimeConfig && !intervalMet) {
      const chatSlot = this.runtimeConfig.modelRoster.chat;
      const contextWindow = chatSlot?.contextWindow ?? this.runtimeConfig.defaultContextWindow;
      thresholdPct = this.runtimeConfig.extractionThresholdPct ?? 30;
      tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

      const recent = this.sessionManager.getRecentMessages(channelId);
      totalTokens = countMessageTokens(recent.map(toTokenMessage));
      thresholdMet = totalTokens > tokenBudget;
    }

    if (!intervalMet && !thresholdMet) return;
    const triggerReason: ExtractionTriggerReason = intervalMet && thresholdMet
      ? 'interval_and_threshold'
      : intervalMet
        ? 'interval'
        : 'context_threshold';

    if (this.isTelemetryEnabled()) {
      log.debug('Extraction trigger matched', {
        channelId,
        triggerReason,
        currentCount,
        lastCount,
        deltaMessages: currentCount - lastCount,
        interval,
        thresholdPct,
        totalTokens,
        tokenBudget,
      });
    }

    lastExtractionCount.set(channelId, currentCount);
    await this.trackExtraction(channelId, triggerReason, canonicalContactId);
  }

  async extract(channelId: string, canonicalContactId?: string): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction request while extractor is draining', { channelId });
      return;
    }

    await this.trackExtraction(channelId, 'manual', canonicalContactId);
  }

  async stop(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    this.acceptingExtractions = false;
    return this.drain(options);
  }

  async drain(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const activeCount = this.inFlightExtractions.size + this.inFlightProfileRefreshes.size;
    if (activeCount === 0) return true;

    log.info('Waiting for extraction drain', { inFlight: activeCount, timeoutMs });

    const pending = Promise.allSettled([
      ...this.inFlightExtractions,
      ...this.inFlightProfileRefreshes,
    ]).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    const drained = timeoutMs <= 0
      ? await pending
      : await Promise.race([pending, timeout]);

    if (timer) clearTimeout(timer);

    if (!drained) {
      log.warn('Timed out waiting for extraction drain', {
        timeoutMs,
        inFlightExtractions: this.inFlightExtractions.size,
        inFlightProfileRefreshes: this.inFlightProfileRefreshes.size,
      });
      return false;
    }

    log.info('Extraction drain complete');
    return true;
  }

  private trackExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
  ): Promise<void> {
    const existing = this.inFlightByChannel.get(channelId);
    if (existing) {
      log.debug('Reusing in-flight extraction', { channelId, triggerReason });
      return existing;
    }

    const promise = this.runExtraction(
      channelId,
      triggerReason,
      canonicalContactId,
      recoveredEntries,
    );
    this.inFlightExtractions.add(promise);
    this.inFlightByChannel.set(channelId, promise);
    promise.finally(() => {
      this.inFlightExtractions.delete(promise);
      if (this.inFlightByChannel.get(channelId) === promise) {
        this.inFlightByChannel.delete(channelId);
      }
    });
    return promise;
  }

  private async runExtraction(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId?: string,
    recoveredEntries?: SessionEntry[],
  ): Promise<void> {
    await this.emitExtractionStart(channelId, triggerReason);

    try {
      // For crash recovery, force extraction over recovered un-extracted entries.
      const recentEntries = (recoveredEntries && recoveredEntries.length > 0
        ? recoveredEntries
        : this.sessionManager.getRecentMessages(channelId, 10)
      ).slice(-RECOVERY_CONTEXT_MESSAGE_LIMIT);
      const channelVisibility = classifyChannel(channelId);
      const sourceRef = buildExtractionSourceRef(channelId, recentEntries, channelVisibility);
      const recentMessages = recentEntries
        .map(e => `${e.authorName ?? e.role}: ${e.content}`)
        .join('\n');
      const coveredUpToMessageId = this.resolveCoveredUpToMessageId(channelId, recentEntries);

      // Get existing memories for dedup context
      const existing = this.memoryStore.getMemoriesByChannel(channelId, 30);
      const noveltyCorpus = existing.map(m => m.text);
      const existingFacts = existing
        .map(m => `- [${m.type}] ${m.text}`)
        .join('\n') || '(none yet)';

      // Build prompt
      const extractionPrompt = this.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
        ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
      const prompt = injectPromptRuntimeTokens(extractionPrompt)
        .replace('{existing_facts}', existingFacts)
        .replace('{recent_messages}', recentMessages);

      // Call extraction LLM
      const response = await this.llmClient.complete(
        {
          systemPrompt: prompt,
          messages: [{ role: 'user', content: 'Extract facts from the conversation above.' }],
        },
        'extraction',
      );

      // Parse XML response + synthesize refusal-boundary memories directly from transcript.
      const parsedFacts = parseFactsXml(response.content);
      const inferredBoundaryFacts = extractBoundaryFactsFromEntries(recentEntries, parsedFacts);
      const facts = [...parsedFacts, ...inferredBoundaryFacts]
        .map(fact => applyChannelImportanceCaps(fact, channelVisibility));

      if (inferredBoundaryFacts.length > 0 && this.isTelemetryEnabled()) {
        log.info('Detected refusal-boundary facts from conversation transcript', {
          channelId,
          triggerReason,
          inferredCount: inferredBoundaryFacts.length,
        });
      }
      if (!this.acceptingExtractions) {
        log.debug('Skipping fact writes while extractor is stopping', {
          channelId,
          factCount: facts.length,
          triggerReason,
        });
        await this.emitExtractionEnd({
          channelId,
          count: 0,
          triggerReason,
          parsedCount: facts.length,
          acceptedCount: 0,
          rejectedCount: 0,
          writeCount: 0,
          deduplicatedCount: 0,
          supersededCount: 0,
          rejectionBreakdown: {
            low_importance: 0,
            low_confidence: 0,
            low_novelty: 0,
            low_signal: 0,
            write_cap: 0,
          },
        });
        return;
      }

      const gateConfig = this.resolveGateConfig();
      const rejectionBreakdown: Record<ExtractionRejectionReason, number> = {
        low_importance: 0,
        low_confidence: 0,
        low_novelty: 0,
        low_signal: 0,
        write_cap: 0,
      };

      // Gate first, then rank accepted facts so the cap preserves highest-value writes.
      const acceptedCandidates: AcceptedFactCandidate[] = [];
      for (const [index, fact] of facts.entries()) {
        const decision = evaluateFactAcceptance(fact, noveltyCorpus, gateConfig);
        if (!decision.accepted) {
          if (decision.reason) rejectionBreakdown[decision.reason]++;
          if (this.isTelemetryEnabled()) {
            log.debug('Rejected extracted fact', {
              channelId,
              reason: decision.reason,
              novelty: decision.novelty,
              minNovelty: gateConfig.minNovelty,
              importance: fact.importance,
              minImportance: gateConfig.minImportance,
              confidence: fact.confidence,
              minConfidence: gateConfig.minConfidence,
              textPreview: fact.text.slice(0, 120),
            });
          }
          continue;
        }

        acceptedCandidates.push({
          fact,
          novelty: decision.novelty,
          valueScore: computeFactValueScore(fact, decision.novelty),
          index,
        });
        noveltyCorpus.push(fact.text);
      }

      const maxWrites = this.resolveMaxWrites();
      const rankedCandidates = acceptedCandidates
        .slice()
        .sort(compareAcceptedFactCandidates);
      const selectedCandidates = rankedCandidates.slice(0, maxWrites);
      const skippedByCap = rankedCandidates.length - selectedCandidates.length;
      if (skippedByCap > 0) {
        rejectionBreakdown.write_cap += skippedByCap;
        if (this.isTelemetryEnabled()) {
          log.debug('Skipped extracted facts due to write cap', {
            channelId,
            maxWrites,
            skippedByCap,
            acceptedBeforeCap: rankedCandidates.length,
          });
        }
      }

      // Process accepted facts that survived cap.
      let acceptedCount = 0;
      let writeCount = 0;
      let deduplicatedCount = 0;
      let supersededCount = 0;
      const acceptedWrites: AcceptedFactWrite[] = [];

      for (const candidate of selectedCandidates) {
        const { fact } = candidate;
        try {
          const result = await this.processFact(fact, sourceRef, canonicalContactId);
          acceptedCount++;

          switch (result.action) {
            case 'created':
              writeCount++;
              acceptedWrites.push({
                memoryId: result.memory.id,
                importance: fact.importance,
                confidence: fact.confidence,
              });
              break;
            case 'superseded':
              writeCount++;
              supersededCount++;
              acceptedWrites.push({
                memoryId: result.memory.id,
                importance: fact.importance,
                confidence: fact.confidence,
              });
              break;
            case 'deduplicated':
              deduplicatedCount++;
              break;
          }
        } catch (err) {
          log.error('Error processing fact', { error: String(err) });
        }
      }

      const rejectedCount = facts.length - acceptedCount;
      const telemetry: ExtractionEndTelemetry = {
        channelId,
        count: acceptedCount,
        triggerReason,
        coveredUpToMessageId: coveredUpToMessageId ?? undefined,
        parsedCount: facts.length,
        acceptedCount,
        rejectedCount,
        writeCount,
        deduplicatedCount,
        supersededCount,
        rejectionBreakdown,
      };

      if (this.isTelemetryEnabled()) {
        log.info('Extraction completed', { ...telemetry, maxWrites });
      }
      this.recordExtractionMarker(channelId, coveredUpToMessageId);
      await this.emitExtractionEnd(telemetry);
      this.maybeRefreshContactProfile(
        channelId,
        triggerReason,
        canonicalContactId,
        acceptedWrites,
      );
    } catch (err) {
      log.error('Extraction error', { error: String(err), triggerReason });
    }
  }

  private async processFact(
    fact: ExtractedFact,
    sourceRef: string,
    canonicalContactId?: string,
  ): Promise<WriteResult> {
    return this.writer.write({
      text: fact.text,
      type: fact.type,
      importance: fact.importance,
      emotionalValence: fact.emotionalValence,
      confidence: fact.confidence,
      tags: fact.tags,
      sourceRef,
      sensitivity: fact.sensitivity,
      contactId: canonicalContactId,
    });
  }

  private maybeRefreshContactProfile(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ): void {
    if (!canonicalContactId) return;
    if (!this.acceptingExtractions) return;

    const profileConfig = this.resolveProfileConfig();
    if (!profileConfig.enabled) return;

    const existing = this.inFlightProfileByContact.get(canonicalContactId);
    if (existing) {
      if (this.isTelemetryEnabled()) {
        log.debug('Profile refresh already in flight; skipping trigger', {
          channelId,
          canonicalContactId,
          triggerReason,
        });
      }
      return;
    }

    const promise = this.refreshContactProfile(
      channelId,
      triggerReason,
      canonicalContactId,
      acceptedWrites,
      profileConfig,
    );
    this.inFlightProfileRefreshes.add(promise);
    this.inFlightProfileByContact.set(canonicalContactId, promise);
    promise.finally(() => {
      this.inFlightProfileRefreshes.delete(promise);
      if (this.inFlightProfileByContact.get(canonicalContactId) === promise) {
        this.inFlightProfileByContact.delete(canonicalContactId);
      }
    });
  }

  private async refreshContactProfile(
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string,
    acceptedWrites: AcceptedFactWrite[],
    config: ProfileSynthesisConfig,
  ): Promise<void> {
    const profileStore = this.memoryStore as unknown as {
      getContactProfile?: (contactId: string) => {
        summary: string;
        updatedAt: number;
      } | undefined;
      getMemoriesByContact?: (contactId: string, limit: number) => Array<{
        id: string;
        type: MemoryType;
        text: string;
        importance: number;
        confidence: number;
        salience: number;
      }>;
      upsertContactProfile?: (profile: {
        contactId: string;
        summary: string;
        sourceMemoryIds: string[];
        confidenceScore: number;
        noveltyScore: number;
        updatedAt: number;
      }) => void;
    };

    if (
      typeof profileStore.getContactProfile !== 'function'
      || typeof profileStore.getMemoriesByContact !== 'function'
      || typeof profileStore.upsertContactProfile !== 'function'
    ) {
      return;
    }

    const now = Date.now();
    const existingProfile = profileStore.getContactProfile(canonicalContactId);
    const intervalElapsed = !existingProfile
      || (now - existingProfile.updatedAt) >= config.refreshIntervalMs;
    const withinCooldown = !!existingProfile
      && (now - existingProfile.updatedAt) < config.cooldownMs;

    const writeCount = acceptedWrites.length;
    const avgWriteImportance = writeCount > 0
      ? acceptedWrites.reduce((sum, write) => sum + write.importance, 0) / writeCount
      : 0;
    const avgWriteConfidence = writeCount > 0
      ? acceptedWrites.reduce((sum, write) => sum + write.confidence, 0) / writeCount
      : 0;

    const meaningfulUpdate = writeCount >= config.minWrites
      && avgWriteImportance >= config.minImportance
      && avgWriteConfidence >= config.minConfidence;

    if (!meaningfulUpdate && !intervalElapsed) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh trigger', {
          channelId,
          canonicalContactId,
          triggerReason,
          reason: 'no_meaningful_update',
          writeCount,
          avgWriteImportance,
          avgWriteConfidence,
        });
      }
      return;
    }

    if (withinCooldown && !intervalElapsed) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh due to cooldown', {
          channelId,
          canonicalContactId,
          triggerReason,
          cooldownMs: config.cooldownMs,
        });
      }
      return;
    }

    const sourceMemories = profileStore.getMemoriesByContact(canonicalContactId, config.sourceMemoryLimit);
    if (sourceMemories.length < config.minSourceMemories) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh due to insufficient source memories', {
          channelId,
          canonicalContactId,
          sourceMemoryCount: sourceMemories.length,
          minSourceMemories: config.minSourceMemories,
        });
      }
      return;
    }

    const averageSourceConfidence = sourceMemories.reduce((sum, memory) => sum + memory.confidence, 0)
      / sourceMemories.length;
    if (averageSourceConfidence < config.minConfidence) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh due to low source confidence', {
          channelId,
          canonicalContactId,
          averageSourceConfidence,
          minConfidence: config.minConfidence,
        });
      }
      return;
    }

    const memoryFacts = sourceMemories
      .map(memory => (
        `- [${memory.id}] [${memory.type}] ${memory.text} `
        + `(importance=${memory.importance.toFixed(2)}, confidence=${memory.confidence.toFixed(2)}, salience=${memory.salience.toFixed(2)})`
      ))
      .join('\n');

    const profilePrompt = this.promptRegistry?.getPrompt(PROFILE_SYNTHESIS_PROMPT_KEY)
      ?? getDefaultPromptText(PROFILE_SYNTHESIS_PROMPT_KEY);
    const prompt = injectPromptRuntimeTokens(profilePrompt)
      .replace('{contact_id}', canonicalContactId)
      .replace('{existing_profile}', existingProfile?.summary ?? '(none yet)')
      .replace('{memory_facts}', memoryFacts);

    const response = await this.llmClient.complete(
      {
        systemPrompt: prompt,
        messages: [{ role: 'user', content: 'Synthesize the stable contact profile now.' }],
      },
      'summary',
    );

    const summary = normalizeProfileSummary(parseProfileSummary(response.content));
    if (!summary) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh due to empty summary output', {
          channelId,
          canonicalContactId,
        });
      }
      return;
    }

    const noveltyScore = existingProfile
      ? computeProfileNovelty(summary, existingProfile.summary)
      : 1;
    if (existingProfile && noveltyScore < config.minNovelty) {
      if (this.isTelemetryEnabled()) {
        log.debug('Skipped profile refresh due to low novelty', {
          channelId,
          canonicalContactId,
          noveltyScore,
          minNovelty: config.minNovelty,
        });
      }
      return;
    }

    const refreshReason: ProfileRefreshReason = meaningfulUpdate && intervalElapsed
      ? 'memory_update_and_interval'
      : meaningfulUpdate
        ? 'memory_update'
        : 'interval';

    profileStore.upsertContactProfile({
      contactId: canonicalContactId,
      summary,
      sourceMemoryIds: sourceMemories.map(memory => memory.id),
      confidenceScore: averageSourceConfidence,
      noveltyScore,
      updatedAt: Date.now(),
    });

    if (this.isTelemetryEnabled()) {
      log.info('Contact profile refreshed', {
        channelId,
        canonicalContactId,
        triggerReason,
        refreshReason,
        sourceMemoryCount: sourceMemories.length,
        averageSourceConfidence,
        noveltyScore,
      });
    }
  }

  private resolveProfileConfig(): ProfileSynthesisConfig {
    return {
      enabled: this.runtimeConfig?.profileSynthesisEnabled ?? true,
      refreshIntervalMs: this.runtimeConfig?.profileSynthesisRefreshIntervalMs ?? DEFAULT_PROFILE_REFRESH_INTERVAL_MS,
      cooldownMs: this.runtimeConfig?.profileSynthesisCooldownMs ?? DEFAULT_PROFILE_REFRESH_COOLDOWN_MS,
      minWrites: this.runtimeConfig?.profileSynthesisMinWrites ?? DEFAULT_PROFILE_MIN_WRITES,
      minImportance: this.runtimeConfig?.profileSynthesisMinImportance ?? DEFAULT_PROFILE_MIN_IMPORTANCE,
      minConfidence: this.runtimeConfig?.profileSynthesisMinConfidence ?? DEFAULT_PROFILE_MIN_CONFIDENCE,
      minNovelty: this.runtimeConfig?.profileSynthesisMinNovelty ?? DEFAULT_PROFILE_MIN_NOVELTY,
      sourceMemoryLimit: this.runtimeConfig?.profileSynthesisSourceMemoryLimit ?? DEFAULT_PROFILE_SOURCE_MEMORY_LIMIT,
      minSourceMemories: this.runtimeConfig?.profileSynthesisMinSourceMemories ?? DEFAULT_PROFILE_MIN_SOURCE_MEMORIES,
    };
  }

  private resolveGateConfig(): ExtractionGateConfig {
    return {
      minImportance: clamp(this.runtimeConfig?.memoryExtractionMinImportance ?? this.minImportance, 0, 1),
      minConfidence: clamp(this.runtimeConfig?.memoryExtractionMinConfidence ?? this.minConfidence, 0, 1),
      minNovelty: clamp(this.runtimeConfig?.memoryExtractionMinNovelty ?? this.minNovelty, 0, 1),
    };
  }

  private resolveMaxWrites(): number {
    return normalizeMaxWrites(
      this.runtimeConfig?.memoryExtractionMaxWrites,
      this.maxWrites,
    );
  }

  private isTelemetryEnabled(): boolean {
    return this.runtimeConfig?.memoryExtractionTelemetryEnabled ?? this.telemetryEnabled;
  }

  private resolveCoveredUpToMessageId(channelId: string, entries: SessionEntry[]): number | null {
    for (let index = entries.length - 1; index >= 0; index--) {
      const candidate = entries[index]?.id;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }

    const latestEntry = this.sessionManager.getRecentMessages(channelId, 1)[0];
    if (typeof latestEntry?.id === 'number' && Number.isFinite(latestEntry.id)) {
      return latestEntry.id;
    }
    return null;
  }

  private recordExtractionMarker(channelId: string, coveredUpToMessageId: number | null): void {
    if (!this.sessionStore) return;
    if (coveredUpToMessageId === null) return;

    try {
      this.sessionStore.insertExtractionMarker(channelId, coveredUpToMessageId);
    } catch (error) {
      log.warn('Failed to persist extraction marker', {
        channelId,
        coveredUpToMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async emitExtractionStart(channelId: string, triggerReason: ExtractionTriggerReason): Promise<void> {
    if (!this.isTelemetryEnabled()) {
      await this.eventBus.emit('memory.extraction.start', { channelId });
      return;
    }

    await this.eventBus.emit(
      'memory.extraction.start',
      { channelId, triggerReason } as { channelId: string },
    );
  }

  private async emitExtractionEnd(telemetry: ExtractionEndTelemetry): Promise<void> {
    if (!this.isTelemetryEnabled()) {
      await this.eventBus.emit('memory.extraction.end', {
        channelId: telemetry.channelId,
        count: telemetry.count,
      });
      return;
    }

    await this.eventBus.emit(
      'memory.extraction.end',
      telemetry as { channelId: string; count: number },
    );
  }
}

// ── XML Parsing ──

export function parseFactsXml(xml: string): ExtractedFact[] {
  const responseMatch = xml.match(/<response>([\s\S]*?)<\/response>/);
  if (!responseMatch) return [];

  const inner = responseMatch[1];
  const factBlocks = inner.matchAll(/<fact>([\s\S]*?)<\/fact>/g);
  const facts: ExtractedFact[] = [];

  for (const match of factBlocks) {
    const block = match[1];
    const fact = parseFactBlock(block);
    if (fact) facts.push(fact);
  }

  return facts;
}

function evaluateFactAcceptance(
  fact: ExtractedFact,
  existingTexts: string[],
  gateConfig: ExtractionGateConfig,
): FactAcceptanceDecision {
  if (fact.importance < gateConfig.minImportance) {
    return { accepted: false, reason: 'low_importance', novelty: 1 };
  }

  if (fact.confidence < gateConfig.minConfidence) {
    return { accepted: false, reason: 'low_confidence', novelty: 1 };
  }

  if (isLowSignalFact(fact.text)) {
    return { accepted: false, reason: 'low_signal', novelty: 1 };
  }

  const novelty = computeNoveltyScore(fact.text, existingTexts);
  if (novelty < gateConfig.minNovelty) {
    return { accepted: false, reason: 'low_novelty', novelty };
  }

  return { accepted: true, novelty };
}

function isLowSignalFact(text: string): boolean {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return true;
  if (LOW_SIGNAL_EXACT_TEXT.has(normalized)) return true;

  const tokens = tokenizeForSimilarity(normalized);
  if (tokens.some(token => RELATIONSHIP_SIGNAL_HINTS.has(token))) {
    return false;
  }

  return LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized));
}

function computeFactValueScore(fact: ExtractedFact, novelty: number): number {
  const typeBoost = fact.type === 'boundary' ? 1.6 : 1;
  return clamp(fact.importance, 0, 1) * clamp(fact.confidence, 0, 1) * clamp(novelty, 0, 1) * typeBoost;
}

function compareAcceptedFactCandidates(left: AcceptedFactCandidate, right: AcceptedFactCandidate): number {
  if (right.valueScore !== left.valueScore) return right.valueScore - left.valueScore;
  if (right.fact.importance !== left.fact.importance) return right.fact.importance - left.fact.importance;
  if (right.fact.confidence !== left.fact.confidence) return right.fact.confidence - left.fact.confidence;
  if (right.novelty !== left.novelty) return right.novelty - left.novelty;
  return left.index - right.index;
}

function computeNoveltyScore(text: string, existingTexts: string[]): number {
  if (existingTexts.length === 0) return 1;

  const normalized = normalizeForSimilarity(text);
  if (!normalized) return 0;

  const tokens = tokenizeForSimilarity(normalized);
  let maxSimilarity = 0;

  for (const existingText of existingTexts) {
    const normalizedExisting = normalizeForSimilarity(existingText);
    if (!normalizedExisting) continue;

    if (normalizedExisting === normalized) return 0;

    const containment = containmentSimilarity(normalized, normalizedExisting);
    const jaccard = jaccardSimilarity(tokens, tokenizeForSimilarity(normalizedExisting));
    maxSimilarity = Math.max(maxSimilarity, containment, jaccard);

    if (maxSimilarity >= 1) break;
  }

  return clamp(1 - maxSimilarity, 0, 1);
}

function parseProfileSummary(response: string): string {
  const summaryTag = response.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryTag && summaryTag[1].trim().length > 0) {
    return summaryTag[1].trim();
  }

  const profileTag = response.match(/<profile>([\s\S]*?)<\/profile>/i);
  if (profileTag && profileTag[1].trim().length > 0) {
    return profileTag[1]
      .replace(/<\/?[^>]+>/g, ' ')
      .trim();
  }

  return response.replace(/<\/?[^>]+>/g, ' ').trim();
}

function normalizeProfileSummary(summary: string): string {
  const normalized = summary
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';

  const paragraphs = normalized
    .split(/\n\s*\n/g)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return '';

  return paragraphs.slice(0, 2).join('\n\n');
}

function computeProfileNovelty(summary: string, existingSummary: string): number {
  if (!existingSummary.trim()) return 1;
  return computeNoveltyScore(summary, [existingSummary]);
}

function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForSimilarity(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function containmentSimilarity(left: string, right: string): number {
  const hasContainment = left.includes(right) || right.includes(left);
  if (!hasContainment) return 0;

  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  return 0.85 + 0.15 * (shorter / longer);
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;

  const leftSet = new Set(left);
  const rightSet = new Set(right);

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection++;
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeMaxWrites(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  if (!Number.isFinite(candidate)) return DEFAULT_MAX_WRITES;
  return Math.max(0, candidate);
}

function applyChannelImportanceCaps(
  fact: ExtractedFact,
  channelVisibility: ChannelVisibility,
): ExtractedFact {
  if (fact.type === 'boundary') return fact;
  if (channelVisibility !== 'public') return fact;
  if (fact.importance <= 0.5) return fact;
  return { ...fact, importance: 0.5 };
}

function buildExtractionSourceRef(
  channelId: string,
  entries: SessionEntry[],
  channelVisibility: ChannelVisibility,
): string {
  const source = resolveExtractionSource(channelId);
  const lineRange = resolveExtractionLineRange(entries);
  // Prefix with channel id so channel-scoped queries can match extraction writes.
  return `${channelId}:extract|source:${source}|session:${channelId}|lines:${lineRange}|visibility:${channelVisibility}|operation:extract`;
}

function resolveExtractionSource(channelId: string): string {
  if (channelId.startsWith('shard:')) return channelId;
  return 'session';
}

function resolveExtractionLineRange(entries: SessionEntry[]): string {
  const ids = entries
    .map(entry => entry.id)
    .filter(id => Number.isFinite(id));
  if (ids.length === 0) return 'unknown';
  const start = Math.min(...ids);
  const end = Math.max(...ids);
  return start === end ? `${start}` : `${start}-${end}`;
}

export const __test = {
  evaluateFactAcceptance,
  computeNoveltyScore,
  computeProfileNovelty,
  resetLastExtractionCount: () => {
    lastExtractionCount.clear();
  },
};

function parseFactBlock(block: string): ExtractedFact | null {
  const text = extractTag(block, 'text');
  if (!text) return null;

  const typeStr = extractTag(block, 'type')?.trim().toLowerCase() as MemoryType | undefined;
  if (!typeStr || !VALID_MEMORY_TYPES.includes(typeStr)) return null;

  const importance = clamp(parseFloat(extractTag(block, 'importance') ?? '0.5'), 0, 1);
  const emotionalValence = clamp(parseFloat(extractTag(block, 'emotional_valence') ?? '0'), -1, 1);
  const confidence = clamp(parseFloat(extractTag(block, 'confidence') ?? '0.7'), 0, 1);

  const tagsStr = extractTag(block, 'tags') ?? '';
  const tags = tagsStr
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  const sensitivityStr = extractTag(block, 'sensitivity')?.trim().toLowerCase();
  const sensitivity: SensitivityLevel = VALID_SENSITIVITY_LEVELS.includes(sensitivityStr as SensitivityLevel)
    ? (sensitivityStr as SensitivityLevel)
    : 'personal';  // safe default

  return { text: text.trim(), type: typeStr, importance, emotionalValence, confidence, tags, sensitivity };
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}
