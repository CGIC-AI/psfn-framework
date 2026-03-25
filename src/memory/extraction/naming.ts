import type { SessionEntry } from '../../session/types.js';
import type { ExtractedFact } from '../types.js';

export interface ExtractionParticipantNames {
  userName?: string;
  companionName?: string;
}

export interface ResolveExtractionParticipantNamesParams {
  entries: readonly SessionEntry[];
  canonicalContactDisplayName?: string;
  companionName?: string;
}

const GENERIC_USER_LABELS = new Set([
  'user',
  'the user',
  'primary user',
  'the primary user',
]);

const GENERIC_COMPANION_LABELS = new Set([
  'assistant',
  'the assistant',
  'companion',
  'the companion',
]);

const USER_REPLACEMENTS: ReadonlyArray<[RegExp, boolean]> = [
  [/\bthe primary user's\b/gi, true],
  [/\bprimary user's\b/gi, true],
  [/\bthe user's\b/gi, true],
  [/\buser's\b/gi, true],
  [/\bthe primary user\b(?!-)/gi, false],
  [/\bprimary user\b(?!-)/gi, false],
  [/\bthe user\b(?!-)/gi, false],
  [/(?<!-)\buser\b(?!-)/gi, false],
];

const COMPANION_REPLACEMENTS: ReadonlyArray<[RegExp, boolean]> = [
  [/\bthe companion's\b/gi, true],
  [/\bcompanion's\b/gi, true],
  [/\bthe assistant's\b/gi, true],
  [/\bassistant's\b/gi, true],
  [/\bthe companion\b(?!-)/gi, false],
  [/(?<!-)\bcompanion\b(?!-)/gi, false],
  [/\bthe assistant\b(?!-)/gi, false],
  [/(?<!-)\bassistant\b(?!-)/gi, false],
];

function normalizeTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isGenericLabel(value: string | undefined, genericLabels: ReadonlySet<string>): boolean {
  if (!value) return true;
  return genericLabels.has(value.trim().toLowerCase());
}

function findRecentNamedSpeaker(
  entries: readonly SessionEntry[],
  role: SessionEntry['role'],
  genericLabels: ReadonlySet<string>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== role) continue;
    const authorName = normalizeTrimmed(entry.authorName);
    if (!authorName || isGenericLabel(authorName, genericLabels)) continue;
    return authorName;
  }
  return undefined;
}

function applyParticipantReplacement(
  text: string,
  replacement: string | undefined,
  patterns: ReadonlyArray<[RegExp, boolean]>,
): string {
  if (!replacement) return text;

  let nextText = text;
  for (const [pattern, possessive] of patterns) {
    nextText = nextText.replace(pattern, () => (
      possessive ? `${replacement}'s` : replacement
    ));
  }
  return nextText;
}

export function resolveExtractionParticipantNames(
  params: ResolveExtractionParticipantNamesParams,
): ExtractionParticipantNames {
  const canonicalContactDisplayName = normalizeTrimmed(params.canonicalContactDisplayName);
  const userName = !isGenericLabel(canonicalContactDisplayName, GENERIC_USER_LABELS)
    ? canonicalContactDisplayName
    : findRecentNamedSpeaker(params.entries, 'user', GENERIC_USER_LABELS);

  const configuredCompanionName = normalizeTrimmed(params.companionName);
  const companionName = !isGenericLabel(configuredCompanionName, GENERIC_COMPANION_LABELS)
    ? configuredCompanionName
    : findRecentNamedSpeaker(params.entries, 'assistant', GENERIC_COMPANION_LABELS);

  return {
    ...(userName ? { userName } : {}),
    ...(companionName ? { companionName } : {}),
  };
}

export function buildExtractionNamingGuidance(names: ExtractionParticipantNames): string {
  const lines: string[] = [];

  if (names.userName) {
    lines.push(`- Human participant name: ${names.userName}`);
  }
  if (names.companionName) {
    lines.push(`- Companion participant name: ${names.companionName}`);
  }
  if (lines.length === 0) {
    return '';
  }

  return [
    'Name fidelity requirements:',
    ...lines,
    '- In each <text> fact, use the actual participant names above when identity matters.',
    '- Do not write generic placeholders such as "user", "the user", "assistant", or "companion" when a real name is known.',
  ].join('\n');
}

export function normalizeExtractedFactParticipantNames(
  fact: ExtractedFact,
  names: ExtractionParticipantNames,
): ExtractedFact {
  const nextText = applyParticipantReplacement(
    applyParticipantReplacement(fact.text, names.userName, USER_REPLACEMENTS),
    names.companionName,
    COMPANION_REPLACEMENTS,
  );

  if (nextText === fact.text) {
    return fact;
  }

  return {
    ...fact,
    text: nextText,
  };
}
