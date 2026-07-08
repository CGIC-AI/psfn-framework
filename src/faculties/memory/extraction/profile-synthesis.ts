import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import {
  PROFILE_SYNTHESIS_PROMPT_KEY,
  getDefaultPromptText,
} from '../../../core/identity/prompt-registry.js';
import { injectPromptRuntimeTokens } from '../../../core/identity/prompt-runtime.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { computeProfileNovelty } from './signals.js';
import { normalizeDurableMemoryText } from './naming.js';
import type {
  AcceptedFactWrite,
  ProfileRefreshReason,
  ProfileSynthesisConfig,
  ExtractionTriggerReason,
} from './types.js';

const log = createComponentLogger('Extraction');

export interface ProfileSynthesisTargetContact {
  id: string;
  displayName?: string;
  nickname?: string;
  trustLevel?: string;
  relationshipType?: string;
  isMachineIntelligence?: boolean;
}

export interface RefreshContactProfileOptions {
  llmClient: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  /** Shared persona preamble service (E6.1). Prepends soft persona framing before the schema-bound task prompt. */
  personaPreamble?: PersonaPreamblePort | null;
  memoryStore: MemoryStorePort;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  canonicalContactId: string;
  targetContact?: ProfileSynthesisTargetContact;
  acceptedWrites: AcceptedFactWrite[];
  config: ProfileSynthesisConfig;
  telemetryEnabled: boolean;
}

export type ProfileRefreshSkipReason =
  | 'no_meaningful_update'
  | 'cooldown'
  | 'insufficient_source_memories'
  | 'low_source_confidence'
  | 'empty_summary_output'
  | 'profile_text_hygiene'
  | 'target_alias_attribution_risk'
  | 'low_novelty';

export type ProfileRefreshResult =
  | {
    status: 'refreshed';
    reason: ProfileRefreshReason;
    sourceMemoryCount: number;
    averageSourceConfidence: number;
    noveltyScore: number;
  }
  | {
    status: 'skipped';
    reason: ProfileRefreshSkipReason;
    writeCount?: number;
    sourceMemoryCount?: number;
  };

export async function refreshContactProfile(
  options: RefreshContactProfileOptions,
): Promise<ProfileRefreshResult> {
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
    return {
      status: 'skipped',
      reason: 'no_meaningful_update',
      writeCount,
    };
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
    return {
      status: 'skipped',
      reason: 'cooldown',
      writeCount,
    };
  }

  const rawSourceMemories = await options.memoryStore.getMemoriesByContact(
    options.canonicalContactId,
    options.config.sourceMemoryLimit,
  );
  const sourceMemories = rawSourceMemories.filter(memory => (
    !memory.contactId || memory.contactId === options.canonicalContactId
  ));
  if (rawSourceMemories.length !== sourceMemories.length && options.telemetryEnabled) {
    log.debug('Excluded non-target memories from profile synthesis source set', {
      channelId: options.channelId,
      canonicalContactId: options.canonicalContactId,
      excludedCount: rawSourceMemories.length - sourceMemories.length,
    });
  }
  if (sourceMemories.length < options.config.minSourceMemories) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to insufficient source memories', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        sourceMemoryCount: sourceMemories.length,
        minSourceMemories: options.config.minSourceMemories,
      });
    }
    return {
      status: 'skipped',
      reason: 'insufficient_source_memories',
      sourceMemoryCount: sourceMemories.length,
    };
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
    return {
      status: 'skipped',
      reason: 'low_source_confidence',
      sourceMemoryCount: sourceMemories.length,
    };
  }

  const targetContext = buildTargetContactContext(options.canonicalContactId, options.targetContact);
  const acceptedWriteByMemoryId = new Map(options.acceptedWrites.map(write => [write.memoryId, write]));
  const memoryFacts = sourceMemories
    .map(memory => formatProfileSourceMemory(memory, targetContext, acceptedWriteByMemoryId.get(memory.id)))
    .join('\n');

  const profilePrompt = options.promptRegistry?.getPrompt(PROFILE_SYNTHESIS_PROMPT_KEY)
    ?? getDefaultPromptText(PROFILE_SYNTHESIS_PROMPT_KEY);
  const renderedPrompt = injectPromptRuntimeTokens(profilePrompt)
    .replace('{contact_id}', options.canonicalContactId)
    .replace('{target_contact}', formatTargetContactBlock(targetContext))
    .replace('{contact_display_name}', targetContext.displayName ?? '(unknown)')
    .replace('{contact_nickname}', targetContext.nickname ?? '(none)')
    .replace('{contact_trust_level}', targetContext.trustLevel ?? '(unknown)')
    .replace('{contact_relationship_type}', targetContext.relationshipType ?? '(unknown)')
    .replace('{existing_profile}', existingProfile?.summary ?? '(none yet)')
    .replace('{memory_facts}', memoryFacts);
  const taskPrompt = ensureTargetContextInPrompt(profilePrompt, renderedPrompt, targetContext);
  // E6.1: soft persona framing precedes the strict task instructions and XML
  // schema; the schema/format sections stay byte-identical.
  const prompt = options.personaPreamble
    ? options.personaPreamble.prepend('profile_synthesis', taskPrompt)
    : taskPrompt;

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
    return {
      status: 'skipped',
      reason: 'empty_summary_output',
      sourceMemoryCount: sourceMemories.length,
    };
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
    return {
      status: 'skipped',
      reason: 'profile_text_hygiene',
      sourceMemoryCount: sourceMemories.length,
    };
  }
  const summary = summaryHygiene.text;

  if (profileSummaryAliasesTargetToMentionedName(summary, targetContext)) {
    if (options.telemetryEnabled) {
      log.debug('Skipped profile refresh due to target alias attribution risk', {
        channelId: options.channelId,
        canonicalContactId: options.canonicalContactId,
        displayName: targetContext.displayName,
        nickname: targetContext.nickname,
      });
    }
    return {
      status: 'skipped',
      reason: 'target_alias_attribution_risk',
      sourceMemoryCount: sourceMemories.length,
    };
  }

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
    return {
      status: 'skipped',
      reason: 'low_novelty',
      sourceMemoryCount: sourceMemories.length,
    };
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

  return {
    status: 'refreshed',
    reason: refreshReason,
    sourceMemoryCount: sourceMemories.length,
    averageSourceConfidence,
    noveltyScore,
  };
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

interface TargetContactContext {
  contactId: string;
  displayName?: string;
  nickname?: string;
  trustLevel?: string;
  relationshipType?: string;
  isMachineIntelligence?: boolean;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildTargetContactContext(
  contactId: string,
  contact: ProfileSynthesisTargetContact | undefined,
): TargetContactContext {
  return {
    contactId,
    displayName: normalizeOptional(contact?.displayName),
    nickname: normalizeOptional(contact?.nickname),
    trustLevel: normalizeOptional(contact?.trustLevel),
    relationshipType: normalizeOptional(contact?.relationshipType),
    ...(contact?.isMachineIntelligence !== undefined
      ? { isMachineIntelligence: contact.isMachineIntelligence }
      : {}),
  };
}

function formatTargetContactBlock(target: TargetContactContext): string {
  const lines = [
    `Target contact id: ${target.contactId}`,
    `Target contact display name: ${target.displayName ?? '(unknown)'}`,
    `Target contact nickname: ${target.nickname ?? '(none)'}`,
    `Target contact trust level: ${target.trustLevel ?? '(unknown)'}`,
    `Target contact relationship type: ${target.relationshipType ?? '(unknown)'}`,
  ];
  if (target.isMachineIntelligence !== undefined) {
    lines.push(`Target is machine intelligence: ${target.isMachineIntelligence ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

function ensureTargetContextInPrompt(
  template: string,
  renderedPrompt: string,
  target: TargetContactContext,
): string {
  if (
    template.includes('{target_contact}')
    || template.includes('{contact_display_name}')
    || template.includes('{contact_nickname}')
  ) {
    return renderedPrompt;
  }

  return [
    renderedPrompt,
    '',
    'Target contact context:',
    formatTargetContactBlock(target),
    '',
    'Attribution requirements:',
    '- The target contact is the person described by the target context above.',
    '- Names mentioned inside source memories are not aliases for the target unless the target context says so.',
    '- If a source memory says the target mentioned or discussed another person, summarize it as mentioned/discussed; do not turn that other person into the target identity.',
    '- Skip writing a profile if the source facts are too ambiguous to keep target identity separate from mentioned people.',
  ].join('\n');
}

function formatProfileSourceMemory(
  memory: PurrMemory,
  target: TargetContactContext,
  acceptedWrite: AcceptedFactWrite | undefined,
): string {
  const ownerContactId = memory.contactId ?? target.contactId;
  const ownerHint = ownerContactId === target.contactId
    ? 'owned_by_target_contact'
    : `owned_by_other_contact:${ownerContactId}`;
  const provenanceHints = [
    ownerHint,
    `source_type=${memory.sourceType ?? 'unknown'}`,
    ...(memory.provenance?.channelId ? [`channel=${memory.provenance.channelId}`] : []),
    ...(acceptedWrite?.sourceSpeakerName ? [`source_speaker=${acceptedWrite.sourceSpeakerName}`] : []),
    ...(acceptedWrite?.triggerContactId ? [`trigger_contact=${acceptedWrite.triggerContactId}`] : []),
  ].join(', ');

  return (
    `- [${memory.id}] [${memory.type}] ${memory.text} `
    + `(target_contact_id=${target.contactId}, ${provenanceHints}, `
    + `importance=${memory.importance.toFixed(2)}, confidence=${memory.confidence.toFixed(2)}, salience=${memory.salience.toFixed(2)})`
  );
}

function normalizeNameForCompare(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function allowedTargetNameSet(target: TargetContactContext): Set<string> {
  const names = new Set<string>();
  for (const value of [target.displayName, target.nickname]) {
    const normalized = normalizeNameForCompare(value);
    if (normalized) names.add(normalized);
  }
  return names;
}

function extractCapitalizedNameCandidates(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*)*\b/g) ?? [];
  return matches
    .map(match => match.trim())
    .filter(match => !['This', 'The', 'Contact', 'They', 'He', 'She'].includes(match));
}

function profileSummaryAliasesTargetToMentionedName(
  summary: string,
  target: TargetContactContext,
): boolean {
  const allowedNames = allowedTargetNameSet(target);
  if (allowedNames.size === 0) return false;

  const aliasClaimPattern =
    /\b(?:this contact|the contact|contact|person|user|they|he|she|[A-Z][A-Za-z0-9_-]*)\b[^.!?\n]{0,120}\b(?:known as|also known as|goes by|called|by the name|named)\b([^.!?\n]+)/gi;
  for (const match of summary.matchAll(aliasClaimPattern)) {
    const claimedNames = extractCapitalizedNameCandidates(match[1]);
    if (claimedNames.some(name => !allowedNames.has(normalizeNameForCompare(name)))) {
      return true;
    }
  }

  for (const targetName of allowedNames) {
    const escapedTarget = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const targetIsOtherPattern = new RegExp(`\\b${escapedTarget}\\b\\s+(?:is|are)\\s+([A-Z][A-Za-z0-9_-]+)(?:[.!?]|$)`, 'i');
    const targetIsOther = summary.match(targetIsOtherPattern);
    if (targetIsOther && !allowedNames.has(normalizeNameForCompare(targetIsOther[1]))) {
      return true;
    }
  }

  return false;
}
