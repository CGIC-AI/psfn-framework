import { createComponentLogger } from '../../logger.js';
import type { LLMProvider } from '../../agent/contracts.js';
import type { SessionManager } from '../../session/manager.js';
import type { SessionEntry } from '../../session/types.js';
import type { PromptRegistryStore } from '../../identity/prompt-registry.js';
import {
  EXTRACTION_PROMPT_KEY,
  getDefaultPromptText,
} from '../../identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import { classifyChannel } from '../../trust/policy.js';
import { extractBoundaryFactsFromEntries } from '../boundary-log.js';
import type { MemoryStore } from '../store.js';
import type { ExtractedFact } from '../types.js';
import type { WriteResult } from '../writer.js';
import { parseFactsXml } from './parser.js';
import {
  applyChannelImportanceCaps,
  buildExtractionSourceRef,
  compareAcceptedFactCandidates,
  computeFactValueScore,
  evaluateFactAcceptance,
} from './signals.js';
import type {
  AcceptedFactCandidate,
  AcceptedFactWrite,
  ExtractionEndTelemetry,
  ExtractionGateConfig,
  ExtractionRejectionReason,
  ExtractionTriggerReason,
} from './types.js';
import { RECOVERY_CONTEXT_MESSAGE_LIMIT } from './types.js';

const log = createComponentLogger('Extraction');

export interface ExtractionRunOptions {
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId?: string;
  recoveredEntries?: SessionEntry[];
  llmClient: LLMProvider;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  promptRegistry: PromptRegistryStore | null;
  gateConfig: ExtractionGateConfig;
  maxWrites: number;
  telemetryEnabled: boolean;
  isAcceptingExtractions: () => boolean;
  processFact: (fact: ExtractedFact, sourceRef: string, canonicalContactId?: string) => Promise<WriteResult>;
  emitExtractionStart: (channelId: string, triggerReason: ExtractionTriggerReason) => Promise<void>;
  emitExtractionEnd: (telemetry: ExtractionEndTelemetry) => Promise<void>;
  resolveCoveredUpToMessageId: (channelId: string, entries: SessionEntry[]) => number | null;
  recordExtractionMarker: (channelId: string, coveredUpToMessageId: number | null) => void;
  maybePersistEmotionalState: (
    canonicalContactId: string | undefined,
    acceptedFacts: ExtractedFact[],
    recentEntries: SessionEntry[],
  ) => void;
  maybeRefreshContactProfile: (
    channelId: string,
    triggerReason: ExtractionTriggerReason,
    canonicalContactId: string | undefined,
    acceptedWrites: AcceptedFactWrite[],
  ) => void;
}

export async function runExtractionOrchestration(options: ExtractionRunOptions): Promise<void> {
  await options.emitExtractionStart(options.channelId, options.triggerReason);

  try {
    const recentEntries = (options.recoveredEntries && options.recoveredEntries.length > 0
      ? options.recoveredEntries
      : options.sessionManager.getRecentMessages(options.channelId, 10)
    ).slice(-RECOVERY_CONTEXT_MESSAGE_LIMIT);
    const channelVisibility = classifyChannel(options.channelId);
    const sourceRef = buildExtractionSourceRef(options.channelId, recentEntries, channelVisibility);
    const recentMessages = recentEntries
      .map(e => `${e.authorName ?? e.role}: ${e.content}`)
      .join('\n');
    const coveredUpToMessageId = options.resolveCoveredUpToMessageId(options.channelId, recentEntries);

    const existing = options.memoryStore.getMemoriesByChannel(options.channelId, 30);
    const noveltyCorpus = existing.map(m => m.text);
    const existingFacts = existing
      .map(m => `- [${m.type}] ${m.text}`)
      .join('\n') || '(none yet)';

    const extractionPrompt = options.promptRegistry?.getPrompt(EXTRACTION_PROMPT_KEY)
      ?? getDefaultPromptText(EXTRACTION_PROMPT_KEY);
    const prompt = injectPromptRuntimeTokens(extractionPrompt)
      .replace('{existing_facts}', existingFacts)
      .replace('{recent_messages}', recentMessages);

    const response = await options.llmClient.complete(
      {
        systemPrompt: prompt,
        messages: [{ role: 'user', content: 'Extract facts from the conversation above.' }],
        correlation: {
          requestId: `memory-extraction:${options.channelId}:${options.triggerReason}`,
          channelId: options.channelId,
          callType: 'memory',
          purpose: 'memory.extraction',
        },
      },
      'background',
    );

    const parsedFacts = parseFactsXml(response.content);
    const inferredBoundaryFacts = extractBoundaryFactsFromEntries(recentEntries, parsedFacts);
    const facts = [...parsedFacts, ...inferredBoundaryFacts]
      .map(fact => applyChannelImportanceCaps(fact, channelVisibility));

    if (inferredBoundaryFacts.length > 0 && options.telemetryEnabled) {
      log.info('Detected refusal-boundary facts from conversation transcript', {
        channelId: options.channelId,
        triggerReason: options.triggerReason,
        inferredCount: inferredBoundaryFacts.length,
      });
    }

    if (!options.isAcceptingExtractions()) {
      log.debug('Skipping fact writes while extractor is stopping', {
        channelId: options.channelId,
        factCount: facts.length,
        triggerReason: options.triggerReason,
      });
      await options.emitExtractionEnd({
        channelId: options.channelId,
        count: 0,
        triggerReason: options.triggerReason,
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

    const rejectionBreakdown: Record<ExtractionRejectionReason, number> = {
      low_importance: 0,
      low_confidence: 0,
      low_novelty: 0,
      low_signal: 0,
      write_cap: 0,
    };

    const acceptedCandidates: AcceptedFactCandidate[] = [];
    for (const [index, fact] of facts.entries()) {
      const decision = evaluateFactAcceptance(fact, noveltyCorpus, options.gateConfig);
      if (!decision.accepted) {
        if (decision.reason) rejectionBreakdown[decision.reason]++;
        if (options.telemetryEnabled) {
          log.debug('Rejected extracted fact', {
            channelId: options.channelId,
            reason: decision.reason,
            novelty: decision.novelty,
            minNovelty: options.gateConfig.minNovelty,
            importance: fact.importance,
            minImportance: options.gateConfig.minImportance,
            confidence: fact.confidence,
            minConfidence: options.gateConfig.minConfidence,
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

    const rankedCandidates = acceptedCandidates
      .slice()
      .sort(compareAcceptedFactCandidates);
    const selectedCandidates = rankedCandidates.slice(0, options.maxWrites);
    const skippedByCap = rankedCandidates.length - selectedCandidates.length;
    if (skippedByCap > 0) {
      rejectionBreakdown.write_cap += skippedByCap;
      if (options.telemetryEnabled) {
        log.debug('Skipped extracted facts due to write cap', {
          channelId: options.channelId,
          maxWrites: options.maxWrites,
          skippedByCap,
          acceptedBeforeCap: rankedCandidates.length,
        });
      }
    }

    let acceptedCount = 0;
    let writeCount = 0;
    let deduplicatedCount = 0;
    let supersededCount = 0;
    const acceptedWrites: AcceptedFactWrite[] = [];

    for (const candidate of selectedCandidates) {
      const { fact } = candidate;
      try {
        const result = await options.processFact(fact, sourceRef, options.canonicalContactId);
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
      channelId: options.channelId,
      count: acceptedCount,
      triggerReason: options.triggerReason,
      coveredUpToMessageId: coveredUpToMessageId ?? undefined,
      parsedCount: facts.length,
      acceptedCount,
      rejectedCount,
      writeCount,
      deduplicatedCount,
      supersededCount,
      rejectionBreakdown,
    };

    if (options.telemetryEnabled) {
      log.info('Extraction completed', { ...telemetry, maxWrites: options.maxWrites });
    }
    options.recordExtractionMarker(options.channelId, coveredUpToMessageId);
    await options.emitExtractionEnd(telemetry);
    options.maybePersistEmotionalState(
      options.canonicalContactId,
      acceptedCandidates.map(candidate => candidate.fact),
      recentEntries,
    );
    options.maybeRefreshContactProfile(
      options.channelId,
      options.triggerReason,
      options.canonicalContactId,
      acceptedWrites,
    );
  } catch (err) {
    log.error('Extraction error', { error: String(err), triggerReason: options.triggerReason });
  }
}
