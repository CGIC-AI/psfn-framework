import type { SessionEntry } from '../../../core/session/types.js';
import { isInternalReflectionSessionId } from '../../../core/session/session-id.js';
import { resolveSessionEntryReflectionTurnProvenance } from '../../../core/session/reflection-turn-provenance.js';
import type { ExtractedFact } from '../types.js';
import type { FactRoutingDecision } from './speaker-routing.js';

const FIRST_PERSON_EXPERIENCE_PATTERN =
  /\b(?:i|i['’](?:m|ve|d|ll)|me|my|mine|myself)\b/i;
const EMOTIONAL_EXPERIENCE_PATTERN =
  /\b(?:feel|feeling|felt|delight|delighted|pleased|happy|excited|curious|surprised|moved|relieved|satisfied|calm|uneasy|sad|angry|anxious|frustrated|disappointed|fun|wonderful|absorbed|fascinated|enjoy|love|like|prefer|dislike|hate)\b/i;
const STYLE_CONTEXT_PATTERN =
  /\b(?:aesthetic|art|artwork|colou?r|creative|design|drawing|fashion|illustration|outfit|palette|painting|photograph|style|texture|visual|watercolou?r)\b/i;
const PREFERENCE_PATTERN =
  /\b(?:prefer|preferred|preference|favou?rite|enjoy|like|love|dislike|hate|works? for me|doesn['’]?t work for me)\b/i;
const SELF_EXPERIENCE_TYPES = new Set<ExtractedFact['type']>([
  'emotional',
  'episodic',
  'reflection',
  'semantic',
]);

export type SelfDirectedFactRejectionReason =
  | 'unsupported_memory_type'
  | 'missing_first_person_experience'
  | 'missing_emotional_experience'
  | 'missing_companion_source_attribution'
  | 'invalid_companion_source_attribution'
  | 'invalid_reflection_source_stage'
  | 'unsupported_experiential_text';

export type SelfDirectedFactNormalizationResult =
  | {
    accepted: true;
    fact: ExtractedFact;
    routing: Extract<FactRoutingDecision, { status: 'route' }>;
  }
  | {
    accepted: false;
    reason: SelfDirectedFactRejectionReason;
  };

export function buildExperientialSelfDirectedExtractionGuidance(companionName: string): string {
  return [
    '[Experiential self-memory mode]',
    'This transcript is a real self-directed session. Extract only experiences that actually occurred in this transcript.',
    `The assistant is ${companionName}. Only companion-authored assistant messages can support an experiential memory; scheduler/user messages are prompts, never the experiencer or subject.`,
    'In reflection sessions, cite only assistant entries marked as final reflection output; read-only grounding and tool-worker notes are evidence for reflection, not lived self-experience.',
    'Copy one complete first-person experiential sentence or contiguous span verbatim from the cited assistant messages into each fact text. After whitespace normalization, fact text must be an exact substring of those cited messages; never paraphrase or summarize a feeling.',
    'Each fact must be first-person, emotion-carrying, non-procedural, and grounded with source_message_ids that point only to assistant messages in this transcript.',
    'Preserve explicit reactions, preferences, dislikes, and the concrete creative or style context. Do not invent a feeling, preference, activity, or result that the assistant did not state.',
    'If the assistant loafed, stayed silent, or stated no grounded personal experience, return an empty <response></response>.',
    'This is extraction only. Never generate or request images, invoke tools, or turn a style memory into a required aesthetic.',
  ].join('\n');
}

export function normalizeExperientialSelfDirectedFact(input: {
  fact: ExtractedFact;
  entries: readonly SessionEntry[];
  companionName: string;
}): SelfDirectedFactNormalizationResult {
  if (!SELF_EXPERIENCE_TYPES.has(input.fact.type)) {
    return { accepted: false, reason: 'unsupported_memory_type' };
  }
  if (!FIRST_PERSON_EXPERIENCE_PATTERN.test(input.fact.text)) {
    return { accepted: false, reason: 'missing_first_person_experience' };
  }

  const sourceEntries = resolveCompanionSourceEntries(input.fact, input.entries);
  if (!sourceEntries) {
    return { accepted: false, reason: 'missing_companion_source_attribution' };
  }
  if (sourceEntries.some(entry => entry.role !== 'assistant')) {
    return { accepted: false, reason: 'invalid_companion_source_attribution' };
  }
  if (sourceEntries.some(entry => (
    isInternalReflectionSessionId(entry.channelId)
    && resolveSessionEntryReflectionTurnProvenance(entry)?.stage !== 'final_output'
  ))) {
    return { accepted: false, reason: 'invalid_reflection_source_stage' };
  }

  const sourceText = sourceEntries.map(entry => entry.content).join(' ');
  const groundedText = normalizeGroundedExcerpt(input.fact.text);
  const normalizedSourceText = normalizeGroundedExcerpt(sourceText);
  if (!groundedText || !normalizedSourceText.includes(groundedText)) {
    return { accepted: false, reason: 'unsupported_experiential_text' };
  }
  if (!FIRST_PERSON_EXPERIENCE_PATTERN.test(sourceText)) {
    return { accepted: false, reason: 'missing_first_person_experience' };
  }
  if (
    !EMOTIONAL_EXPERIENCE_PATTERN.test(sourceText)
    || (
      input.fact.type !== 'emotional'
      && Math.abs(input.fact.emotionalValence) < 0.05
      && !EMOTIONAL_EXPERIENCE_PATTERN.test(input.fact.text)
    )
  ) {
    return { accepted: false, reason: 'missing_emotional_experience' };
  }

  const sourceMessageIds = sourceEntries
    .map(entry => entry.id)
    .sort((left, right) => left - right);
  const styleContext = STYLE_CONTEXT_PATTERN.test(`${input.fact.text} ${sourceText}`)
    || input.fact.tags.some(tag => STYLE_CONTEXT_PATTERN.test(tag));
  const preference = PREFERENCE_PATTERN.test(`${input.fact.text} ${sourceText}`)
    || input.fact.tags.some(tag => PREFERENCE_PATTERN.test(tag));
  const tags = new Set(input.fact.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean));
  tags.add('self_directed');
  tags.add('self_experience');
  if (styleContext) {
    tags.add('self_style_exploration');
    tags.add('self_style_context');
    tags.add('current_state');
  }
  if (preference) {
    tags.add('preference');
    if (styleContext) tags.add('preference:style');
  }

  const companionName = input.companionName.trim() || 'Companion';
  const sourceSpanStartMessageId = sourceMessageIds[0];
  const sourceSpanEndMessageId = sourceMessageIds.at(-1);
  const sourceAuthorId = sourceEntries
    .map(entry => entry.authorId?.trim())
    .find((authorId): authorId is string => Boolean(authorId));

  return {
    accepted: true,
    fact: {
      ...input.fact,
      text: groundedText,
      tags: [...tags],
      ...(styleContext ? { retentionClass: 'durable' } : {}),
      attribution: {
        sourceMessageIds,
        sourceSpanStartMessageId,
        ...(sourceSpanEndMessageId !== undefined ? { sourceSpanEndMessageId } : {}),
        sourceSpeakerName: companionName,
        subjectName: companionName,
        addressMode: 'system_api',
      },
    },
    routing: {
      status: 'route',
      ...(sourceAuthorId ? { sourceAuthorId } : {}),
      sourceSpeakerName: companionName,
      subjectName: companionName,
      addressMode: 'system_api',
      scopeRef: {
        kind: 'system',
        id: 'companion:self',
        label: 'Companion self-directed experience',
      },
      scopeTags: ['companion_private', 'self_directed'],
      sourceMessageIds,
      sourceSpanStartMessageId,
      ...(sourceSpanEndMessageId !== undefined ? { sourceSpanEndMessageId } : {}),
      reason: 'self_directed_companion',
    },
  };
}

function resolveCompanionSourceEntries(
  fact: ExtractedFact,
  entries: readonly SessionEntry[],
): SessionEntry[] | null {
  const attribution = fact.attribution;
  if (!attribution) return null;
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));

  if (attribution.sourceMessageIds && attribution.sourceMessageIds.length > 0) {
    const resolved = attribution.sourceMessageIds.map(id => entriesById.get(id));
    if (resolved.some(entry => entry === undefined)) return null;
    return resolved.filter((entry): entry is SessionEntry => entry !== undefined);
  }

  const start = attribution.sourceSpanStartMessageId;
  const end = attribution.sourceSpanEndMessageId;
  if (start === undefined || end === undefined || end < start) return null;
  const resolved = entries.filter(entry => entry.id >= start && entry.id <= end);
  return resolved.length > 0 ? resolved : null;
}

function normalizeGroundedExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
