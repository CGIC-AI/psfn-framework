import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { SessionManager } from '../session/manager.js';
import type { EventBus } from '../event-bus.js';
import type { MemoryStore } from './store.js';
import type { ExtractedFact, MemoryType, SensitivityLevel } from './types.js';
import { VALID_MEMORY_TYPES, MEMORY_CONFIG, VALID_SENSITIVITY_LEVELS } from './types.js';
import type { SubstrateConfig } from '../types.js';
import { estimateTokens } from '../llm/tokens.js';
import { MemoryWriter } from './writer.js';
import { createComponentLogger } from '../logger.js';
const log = createComponentLogger('Extraction');

const EXTRACTION_PROMPT = `You are analyzing a conversation to extract important facts about the user. Extract atomic, specific facts — each should be a single piece of information.

For each fact, provide:
- text: A single clear sentence stating the fact
- type: One of: episodic, semantic, emotional, procedural, reflection
  - episodic: Specific events ("User went hiking last weekend")
  - semantic: Stable facts ("User is a software engineer", "User has a cat named Luna")
  - emotional: Feelings and reactions ("User felt stressed about the deadline")
  - procedural: Behavioral patterns ("User prefers code examples over explanations")
  - reflection: Meta-observations ("User has been sharing more personal details lately")
- importance: 0-1 how significant this is for understanding the user (0.8+ for core identity facts, 0.3-0.5 for casual mentions)
- emotional_valence: -1 to 1 (-1 very negative, 0 neutral, 1 very positive)
- confidence: 0-1 how confident you are this fact is correct
- tags: comma-separated relevant tags
- sensitivity: public|personal|intimate|confidential (default personal)
  - public: Safe to share anywhere ("User likes hiking")
  - personal: Only share with trusted contacts ("User has a dog named Rex")
  - intimate: Only share with primary user ("User feels anxious about job")
  - confidential: Never share outside primary 1:1 context ("User shared trauma details")

Already known facts (avoid duplicates, note contradictions):
{existing_facts}

Recent conversation:
{recent_messages}

Respond with facts inside a <response> block. Each fact as a <fact> block:
<response>
<fact>
<text>The specific fact</text>
<type>semantic</type>
<importance>0.7</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.9</confidence>
<tags>identity, profession</tags>
<sensitivity>personal</sensitivity>
</fact>
</response>

If there are no new facts worth extracting, respond with an empty response block:
<response></response>`;

// Track last extraction per channel
const lastExtractionCount = new Map<string, number>();

export interface MemoryExtractorConfig {
  extractionInterval?: number;
}

export class MemoryExtractor {
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private memoryStore: MemoryStore;
  private writer: MemoryWriter;
  private eventBus: EventBus;
  private runtimeConfig: SubstrateConfig | null;
  private extractionInterval: number;

  constructor(
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    eventBus: EventBus,
    config?: MemoryExtractorConfig | SubstrateConfig,
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
    } else {
      this.runtimeConfig = null;
      this.extractionInterval = (config as MemoryExtractorConfig | undefined)?.extractionInterval ?? MEMORY_CONFIG.extractionInterval;
    }
  }

  async maybeExtract(channelId: string): Promise<void> {
    const currentCount = this.sessionManager.getMessageCount(channelId);
    const lastCount = lastExtractionCount.get(channelId) ?? 0;

    // Read interval per-call from live config if available
    const interval = this.runtimeConfig?.extractionInterval ?? this.extractionInterval;
    const intervalMet = currentCount - lastCount >= interval;

    // Also trigger extraction when session content exceeds % of context window
    let thresholdMet = false;
    if (this.runtimeConfig && !intervalMet) {
      const chatSlot = this.runtimeConfig.modelRoster.chat;
      const contextWindow = chatSlot?.contextWindow ?? this.runtimeConfig.defaultContextWindow;
      const thresholdPct = this.runtimeConfig.extractionThresholdPct ?? 30;
      const tokenBudget = Math.floor(contextWindow * (thresholdPct / 100));

      const recent = this.sessionManager.getRecentMessages(channelId);
      const totalTokens = recent.reduce((sum, e) => sum + estimateTokens(e.content), 0);
      thresholdMet = totalTokens > tokenBudget;
    }

    if (!intervalMet && !thresholdMet) return;

    lastExtractionCount.set(channelId, currentCount);
    await this.extract(channelId);
  }

  async extract(channelId: string): Promise<void> {
    await this.eventBus.emit('memory.extraction.start', { channelId });

    try {
      // Get recent messages for context
      const recentEntries = this.sessionManager.getRecentMessages(channelId, 10);
      const recentMessages = recentEntries
        .map(e => `${e.authorName ?? e.role}: ${e.content}`)
        .join('\n');

      // Get existing memories for dedup context
      const existing = this.memoryStore.getMemoriesByChannel(channelId, 30);
      const existingFacts = existing
        .map(m => `- [${m.type}] ${m.text}`)
        .join('\n') || '(none yet)';

      // Build prompt
      const prompt = EXTRACTION_PROMPT
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

      // Process each fact
      let count = 0;
      for (const fact of facts) {
        try {
          await this.processFact(fact, channelId);
          count++;
        } catch (err) {
          log.error('Error processing fact', { error: String(err) });
        }
      }

      await this.eventBus.emit('memory.extraction.end', { channelId, count });
    } catch (err) {
      log.error('Extraction error', { error: String(err) });
    }
  }

  private async processFact(fact: ExtractedFact, channelId: string): Promise<void> {
    await this.writer.write({
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
}

// ── XML Parsing ──

function parseFactsXml(xml: string): ExtractedFact[] {
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
