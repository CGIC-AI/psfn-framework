import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { SessionManager } from '../session/manager.js';
import type { EventBus } from '../event-bus.js';
import type { MemoryStore } from './store.js';
import type { ExtractedFact, MemoryType, SensitivityLevel } from './types.js';
import { VALID_MEMORY_TYPES, MEMORY_CONFIG, VALID_SENSITIVITY_LEVELS } from './types.js';
import type { SubstrateConfig } from '../types.js';
import { estimateTokens } from '../llm/tokens.js';
import { MemoryWriter, type WriteResult } from './writer.js';
import { createComponentLogger } from '../logger.js';
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import { EXTRACTION_PROMPT_KEY, getDefaultPromptText } from '../identity/prompt-registry.js';
const log = createComponentLogger('Extraction');

// Track last extraction per channel
const lastExtractionCount = new Map<string, number>();

export interface MemoryExtractorConfig {
  extractionInterval?: number;
  minImportance?: number;
  minConfidence?: number;
  minNovelty?: number;
  telemetryEnabled?: boolean;
}

export interface MemoryExtractorDrainOptions {
  timeoutMs?: number;
}

type ExtractionTriggerReason = 'manual' | 'interval' | 'context_threshold' | 'interval_and_threshold';
type ExtractionRejectionReason = 'low_importance' | 'low_confidence' | 'low_novelty';

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
  parsedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  writeCount: number;
  deduplicatedCount: number;
  supersededCount: number;
  rejectionBreakdown: Record<ExtractionRejectionReason, number>;
}

const DEFAULT_MIN_IMPORTANCE = 0.45;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_NOVELTY = 0.35;

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
  private telemetryEnabled: boolean;
  private promptRegistry: PromptRegistryStore | null;
  private acceptingExtractions = true;
  private inFlightExtractions = new Set<Promise<void>>();
  private inFlightByChannel = new Map<string, Promise<void>>();

  constructor(
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    eventBus: EventBus,
    config?: MemoryExtractorConfig | SubstrateConfig,
    promptRegistry?: PromptRegistryStore | null,
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
      this.telemetryEnabled = config.memoryExtractionTelemetryEnabled ?? true;
    } else {
      const extractorConfig = config as MemoryExtractorConfig | undefined;
      this.runtimeConfig = null;
      this.extractionInterval = extractorConfig?.extractionInterval ?? MEMORY_CONFIG.extractionInterval;
      this.minImportance = extractorConfig?.minImportance ?? DEFAULT_MIN_IMPORTANCE;
      this.minConfidence = extractorConfig?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
      this.minNovelty = extractorConfig?.minNovelty ?? DEFAULT_MIN_NOVELTY;
      this.telemetryEnabled = extractorConfig?.telemetryEnabled ?? true;
    }
    this.promptRegistry = promptRegistry ?? null;
  }

  async maybeExtract(channelId: string): Promise<void> {
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
      totalTokens = recent.reduce((sum, e) => sum + estimateTokens(e.content), 0);
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
    await this.trackExtraction(channelId, triggerReason);
  }

  async extract(channelId: string): Promise<void> {
    if (!this.acceptingExtractions) {
      log.debug('Skipping extraction request while extractor is draining', { channelId });
      return;
    }

    await this.trackExtraction(channelId, 'manual');
  }

  async stop(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    this.acceptingExtractions = false;
    return this.drain(options);
  }

  async drain(options?: MemoryExtractorDrainOptions): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const activeCount = this.inFlightExtractions.size;
    if (activeCount === 0) return true;

    log.info('Waiting for extraction drain', { inFlight: activeCount, timeoutMs });

    const pending = Promise.allSettled([...this.inFlightExtractions]).then(() => true);
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
        inFlight: this.inFlightExtractions.size,
      });
      return false;
    }

    log.info('Extraction drain complete');
    return true;
  }

  private trackExtraction(channelId: string, triggerReason: ExtractionTriggerReason): Promise<void> {
    const existing = this.inFlightByChannel.get(channelId);
    if (existing) {
      log.debug('Reusing in-flight extraction', { channelId, triggerReason });
      return existing;
    }

    const promise = this.runExtraction(channelId, triggerReason);
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

  private async runExtraction(channelId: string, triggerReason: ExtractionTriggerReason): Promise<void> {
    await this.emitExtractionStart(channelId, triggerReason);

    try {
      // Get recent messages for context
      const recentEntries = this.sessionManager.getRecentMessages(channelId, 10);
      const recentMessages = recentEntries
        .map(e => `${e.authorName ?? e.role}: ${e.content}`)
        .join('\n');

      // Get existing memories for dedup context
      const existing = this.memoryStore.getMemoriesByChannel(channelId, 30);
      const noveltyCorpus = existing.map(m => m.text);
      const existingFacts = existing
        .map(m => `- [${m.type}] ${m.text}`)
        .join('\n') || '(none yet)';

      // Build prompt
      const extractionPrompt = this.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
        ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
      const prompt = extractionPrompt
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

      // Parse XML response
      const facts = parseFactsXml(response.content);
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
          },
        });
        return;
      }

      const gateConfig = this.resolveGateConfig();
      const rejectionBreakdown: Record<ExtractionRejectionReason, number> = {
        low_importance: 0,
        low_confidence: 0,
        low_novelty: 0,
      };

      // Process each fact after acceptance gates
      let acceptedCount = 0;
      let writeCount = 0;
      let deduplicatedCount = 0;
      let supersededCount = 0;

      for (const fact of facts) {
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

        try {
          const result = await this.processFact(fact, channelId);
          noveltyCorpus.push(fact.text);
          acceptedCount++;

          switch (result.action) {
            case 'created':
              writeCount++;
              break;
            case 'superseded':
              writeCount++;
              supersededCount++;
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
        parsedCount: facts.length,
        acceptedCount,
        rejectedCount,
        writeCount,
        deduplicatedCount,
        supersededCount,
        rejectionBreakdown,
      };

      if (this.isTelemetryEnabled()) {
        log.info('Extraction completed', telemetry);
      }
      await this.emitExtractionEnd(telemetry);
    } catch (err) {
      log.error('Extraction error', { error: String(err), triggerReason });
    }
  }

  private async processFact(fact: ExtractedFact, channelId: string): Promise<WriteResult> {
    return this.writer.write({
      text: fact.text,
      type: fact.type,
      importance: fact.importance,
      emotionalValence: fact.emotionalValence,
      confidence: fact.confidence,
      tags: fact.tags,
      sourceRef: `${channelId}:${Date.now()}`,
      sensitivity: fact.sensitivity,
    });
  }

  private resolveGateConfig(): ExtractionGateConfig {
    return {
      minImportance: clamp(this.runtimeConfig?.memoryExtractionMinImportance ?? this.minImportance, 0, 1),
      minConfidence: clamp(this.runtimeConfig?.memoryExtractionMinConfidence ?? this.minConfidence, 0, 1),
      minNovelty: clamp(this.runtimeConfig?.memoryExtractionMinNovelty ?? this.minNovelty, 0, 1),
    };
  }

  private isTelemetryEnabled(): boolean {
    return this.runtimeConfig?.memoryExtractionTelemetryEnabled ?? this.telemetryEnabled;
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

  const novelty = computeNoveltyScore(fact.text, existingTexts);
  if (novelty < gateConfig.minNovelty) {
    return { accepted: false, reason: 'low_novelty', novelty };
  }

  return { accepted: true, novelty };
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

export const __test = {
  evaluateFactAcceptance,
  computeNoveltyScore,
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
