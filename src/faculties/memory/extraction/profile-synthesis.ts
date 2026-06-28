import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import {
  PROFILE_SYNTHESIS_PROMPT_KEY,
  getDefaultPromptText,
} from '../../../core/identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../../core/identity/prompt-runtime.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { computeProfileNovelty } from './signals.js';
import { normalizeDurableMemoryText } from './naming.js';
import type {
  AcceptedFactWrite,
  ProfileRefreshReason,
  ProfileSynthesisConfig,
  ExtractionTriggerReason,
} from './types.js';

const log = createComponentLogger('Extraction');

export interface RefreshContactProfileOptions {
  llmClient: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  memoryStore: MemoryStorePort;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId: string;
  acceptedWrites: AcceptedFactWrite[];
  config: ProfileSynthesisConfig;
  telemetryEnabled: boolean;
}

export async function refreshContactProfile(
  options: RefreshContactProfileOptions,
): Promise<void> {
  const now = Date.now();
  const existingProfile = await options.memoryStore.getContactProfile(options.canonicalContactId);
  const intervalElapsed = !existingProfile
    || (now - existingProfile.updatedAt) >= options.config.refreshIntervalMs;
  const withinCooldown = !!existingProfile
    && (now - existingProfile.updatedAt) < options.config.cooldownMs;

  const writeCount = options.acceptedWrites.length;
  const avgWriteImportance = writeCount > 0
    ? options.acceptedWrites.reduce((sum, write) => sum + write.importance, 0) / writeCount
    : 0;
  const avgWriteConfidence = writeCount > 0
    ? options.acceptedWrites.reduce((sum, write) => sum + write.confidence, 0) / writeCount
    : 0;

  const meaningfulUpdate = writeCount >= options.config.minWrites
    && avgWriteImportance >= options.config.minImportance
    && avgWriteConfidence >= options.config.minConfidence;

  if (!meaningfulUpdate && !intervalElapsed) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh trigger', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        triggerReason: options.triggerReason,
        reason: 'no_meaningful_update',
        writeCount,
        avgWriteImportance,
        avgWriteConfidence,
      });
    }
    return;
  }

  if (withinCooldown && !intervalElapsed) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to cooldown', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        triggerReason: options.triggerReason,
        cooldownMs: options.config.cooldownMs,
      });
    }
    return;
  }

  const sourceMemories = await options.memoryStore.getMemoriesByContact(
    options.canonicalContactId,
    options.config.sourceMemoryLimit,
  );
  if (sourceMemories.length < options.config.minSourceMemories) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to insufficient source memories', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        sourceMemoryCount: sourceMemories.length,
        minSourceMemories: options.config.minSourceMemories,
      });
    }
    return;
  }

  const averageSourceConfidence = sourceMemories.reduce((sum, memory) => sum + memory.confidence, 0)
    / sourceMemories.length;
  if (averageSourceConfidence < options.config.minConfidence) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to low source confidence', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        averageSourceConfidence,
        minConfidence: options.config.minConfidence,
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

  const profilePrompt = options.promptRegistry?.getPrompt(PROFILE_SYNTHESIS_PROMPT_KEY)
    ?? getDefaultPromptText(PROFILE_SYNTHESIS_PROMPT_KEY);
  const prompt = injectPromptRuntimeTokens(profilePrompt)
    .replace('{contact_id}', options.canonicalContactId)
    .replace('{existing_profile}', existingProfile?.summary ?? '(none yet)')
    .replace('{memory_facts}', memoryFacts);

  const response = await options.llmClient.complete(
    {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Synthesize the stable contact profile now.' }],
      correlation: {
        requestId: `profile-synthesis:${options.canonicalContactId}:${now}`,
        channelId: options.channelId,
        callType: 'memory',
        purpose: 'memory.profile_synthesis',
      },
    },
    'memory',
  );

  const parsedSummary = normalizeProfileSummary(parseProfileSummary(response.content));
  if (!parsedSummary) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to empty summary output', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
      });
    }
    return;
  }

  const summaryHygiene = normalizeDurableMemoryText(parsedSummary, {});
  if (!summaryHygiene.accepted) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to profile text hygiene rejection', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        reason: summaryHygiene.reason,
      });
    }
    return;
  }
  const summary = summaryHygiene.text;

  const noveltyScore = existingProfile
    ? computeProfileNovelty(summary, existingProfile.summary)
    : 1;
  if (existingProfile && noveltyScore < options.config.minNovelty) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to low novelty', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        noveltyScore,
        minNovelty: options.config.minNovelty,
      });
    }
    return;
  }

  const refreshReason: ProfileRefreshReason = meaningfulUpdate && intervalElapsed
    ? 'memory_update_and_interval'
    : meaningfulUpdate
      ? 'memory_update'
      : 'interval';

  await options.memoryStore.upsertContactProfile({
    contactId: options.canonicalContactId,
    summary,
    sourceMemoryIds: sourceMemories.map(memory => memory.id),
    confidenceScore: averageSourceConfidence,
    noveltyScore,
    updatedAt: Date.now(),
  });

  if (options.telemetryEnabled) {
    log.info('Contact profile refreshed', {
      channelId: options.channelId,
      canonicalContactId: options.canonicalContactId,
      triggerReason: options.triggerReason,
      refreshReason,
      sourceMemoryCount: sourceMemories.length,
      averageSourceConfidence,
      noveltyScore,
    });
  }
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
