import type {
  ExtractedFact,
  ExtractedFactAttribution,
  GroupMemoryAddressMode,
  MemoryType,
  SensitivityLevel,
} from '../types.js';
import {
  GROUP_MEMORY_ADDRESS_MODES,
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
} from '../types.js';
import { clamp } from './config.js';

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
    : 'personal';
  const retentionClassStr = extractTag(block, 'retention_class')?.trim().toLowerCase();
  const retentionClass = retentionClassStr === 'durable' ? 'durable' : undefined;

  const attribution = parseFactAttribution(block);

  return {
    text: text.trim(),
    type: typeStr,
    importance,
    emotionalValence,
    confidence,
    tags,
    sensitivity,
    ...(retentionClass ? { retentionClass } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

function parseFactAttribution(block: string): ExtractedFactAttribution | undefined {
  const attribution: ExtractedFactAttribution = {};
  const sourceMessageIds = parsePositiveIntegerList(extractTag(block, 'source_message_ids'));
  if (sourceMessageIds.length > 0) {
    attribution.sourceMessageIds = sourceMessageIds;
  }

  const sourceSpan = parseSourceSpan(extractTag(block, 'source_span'));
  const sourceSpanStartMessageId =
    parsePositiveInteger(extractTag(block, 'source_span_start_message_id'))
    ?? sourceSpan?.startMessageId;
  const sourceSpanEndMessageId =
    parsePositiveInteger(extractTag(block, 'source_span_end_message_id'))
    ?? sourceSpan?.endMessageId;
  if (sourceSpanStartMessageId !== undefined) {
    attribution.sourceSpanStartMessageId = sourceSpanStartMessageId;
  }
  if (sourceSpanEndMessageId !== undefined) {
    attribution.sourceSpanEndMessageId = sourceSpanEndMessageId;
  }

  const sourceSpeakerName = normalizeOptionalText(extractTag(block, 'source_speaker_name'));
  if (sourceSpeakerName) attribution.sourceSpeakerName = sourceSpeakerName;
  const subjectName = normalizeOptionalText(extractTag(block, 'subject_name'));
  if (subjectName) attribution.subjectName = subjectName;
  const subjectContactId = normalizeOptionalText(extractTag(block, 'subject_contact_id'));
  if (subjectContactId) attribution.subjectContactId = subjectContactId;
  const addressMode = normalizeAddressMode(extractTag(block, 'address_mode'));
  if (addressMode) attribution.addressMode = addressMode;

  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function parsePositiveIntegerList(value: string | null): number[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(/[,\s]+/)
      .map(parsePositiveInteger)
      .filter((item): item is number => item !== undefined),
  )].sort((left, right) => left - right);
}

function parseSourceSpan(value: string | null): { startMessageId: number; endMessageId: number } | undefined {
  if (!value) return undefined;
  const [startRaw, endRaw] = value.split('-', 2);
  const startMessageId = parsePositiveInteger(startRaw);
  const endMessageId = parsePositiveInteger(endRaw);
  if (startMessageId === undefined || endMessageId === undefined) return undefined;
  if (endMessageId < startMessageId) return undefined;
  return { startMessageId, endMessageId };
}

function parsePositiveInteger(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOptionalText(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAddressMode(value: string | null): GroupMemoryAddressMode | undefined {
  const normalized = value?.trim();
  return normalized && GROUP_MEMORY_ADDRESS_MODES.includes(normalized as GroupMemoryAddressMode)
    ? normalized as GroupMemoryAddressMode
    : undefined;
}
