import type { ExtractedFact, MemoryType, SensitivityLevel } from '../types.js';
import { VALID_MEMORY_TYPES, VALID_SENSITIVITY_LEVELS } from '../types.js';
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

  return { text: text.trim(), type: typeStr, importance, emotionalValence, confidence, tags, sensitivity };
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}
