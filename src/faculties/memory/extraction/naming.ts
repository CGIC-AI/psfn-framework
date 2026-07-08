import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';

export interface ExtractionParticipantNames {
  userName?: string;
  companionName?: string;
}

export type DurableMemoryTextHygieneRejectionReason =
  | 'empty_text'
  | 'unresolved_participant_macro';

export type DurableMemoryTextHygieneResult =
  | {
    accepted: true;
    text: string;
    changed: boolean;
  }
  | {
    accepted: false;
    text: string;
    reason: DurableMemoryTextHygieneRejectionReason;
  };

export type ExtractedFactParticipantNameNormalizationResult =
  | {
    accepted: true;
    fact: ExtractedFact;
    changed: boolean;
  }
  | {
    accepted: false;
    fact: ExtractedFact;
    reason: DurableMemoryTextHygieneRejectionReason;
  };

export interface DurableMemoryParticipantPlaceholderDetection {
  user: boolean;
  companion: boolean;
  userMacros: string[];
  companionMacros: string[];
  hasAny: boolean;
}

export interface ResolveExtractionParticipantNamesParams {
  entries: readonly SessionEntry[];
  canonicalContactName?: string;
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

// Only explicit placeholder forms are rewritten: character-card macros (handled
// separately) and the definite/"primary" generic labels. Bare nouns ("user",
// "companion", "assistant") are intentionally excluded so ordinary text like
// "research assistant" or "power user" is never corrupted.
interface ParticipantReplacementPattern {
  pattern: RegExp;
  possessive: boolean;
  skipOrdinaryNounFollower?: boolean;
}

const ORDINARY_LABEL_NOUN_FOLLOWERS = new Set([
  'account',
  'accounts',
  'animal',
  'animals',
  'app',
  'apps',
  'assistant',
  'assistants',
  'base',
  'bases',
  'experience',
  'experiences',
  'group',
  'groups',
  'guide',
  'guides',
  'interface',
  'interfaces',
  'manager',
  'managers',
  'manual',
  'manuals',
  'profile',
  'profiles',
  'role',
  'roles',
  'software',
  'system',
  'systems',
  'tool',
  'tools',
]);

const USER_REPLACEMENTS: readonly ParticipantReplacementPattern[] = [
  { pattern: /\bthe primary user's\b/gi, possessive: true },
  { pattern: /\bprimary user's\b/gi, possessive: true },
  { pattern: /\bthe user's\b/gi, possessive: true },
  { pattern: /\bthe primary user\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },
  { pattern: /\bprimary user\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },
  { pattern: /\bthe user\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },
];

const COMPANION_REPLACEMENTS: readonly ParticipantReplacementPattern[] = [
  { pattern: /\bthe companion's\b/gi, possessive: true },
  { pattern: /\bthe assistant's\b/gi, possessive: true },
  { pattern: /\bthe companion\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },
  { pattern: /\bthe assistant\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },
];

const PARTICIPANT_MACRO_PATTERN = /\{\{\s*(user|char|character|assistant)\s*\}\}/gi;
const CAPITALIZED_DUPLICATE_NAME_PATTERN =
  /(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9_-]*[a-z][A-Za-z0-9_-]*)(['\u2019]s)?(?:\s+\1(['\u2019]s)?)+(?![A-Za-z0-9_])/g;

function normalizeTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  patterns: readonly ParticipantReplacementPattern[],
): string {
  if (!replacement) return text;

  let nextText = text;
  for (const spec of patterns) {
    nextText = nextText.replace(spec.pattern, (match, ...args) => {
      const offset = args[args.length - 2] as number;
      if (spec.skipOrdinaryNounFollower && hasOrdinaryNounFollower(nextText, offset, match.length)) {
        return match;
      }
      return spec.possessive ? `${replacement}'s` : replacement;
    });
  }
  return nextText;
}

function hasOrdinaryNounFollower(text: string, offset: number, matchLength: number): boolean {
  const remainder = text.slice(offset + matchLength);
  const nextWord = /^\s+([A-Za-z][A-Za-z'-]*)\b/.exec(remainder)?.[1].toLowerCase();
  return nextWord !== undefined && ORDINARY_LABEL_NOUN_FOLLOWERS.has(nextWord);
}

function applyParticipantMacroReplacement(text: string, names: ExtractionParticipantNames): string {
  return text.replace(PARTICIPANT_MACRO_PATTERN, (match, macroName: string) => {
    const normalizedMacroName = macroName.toLowerCase();
    const replacement = normalizedMacroName === 'user'
      ? names.userName
      : names.companionName;
    return replacement ?? match;
  });
}

function containsParticipantMacro(text: string): boolean {
  PARTICIPANT_MACRO_PATTERN.lastIndex = 0;
  return PARTICIPANT_MACRO_PATTERN.test(text);
}

function patternMatches(text: string, spec: ParticipantReplacementPattern): boolean {
  spec.pattern.lastIndex = 0;
  for (const match of text.matchAll(spec.pattern)) {
    if (spec.skipOrdinaryNounFollower && hasOrdinaryNounFollower(text, match.index, match[0].length)) {
      continue;
    }
    spec.pattern.lastIndex = 0;
    return true;
  }
  spec.pattern.lastIndex = 0;
  return false;
}

export function detectDurableMemoryParticipantPlaceholders(
  text: string,
): DurableMemoryParticipantPlaceholderDetection {
  const userMacros: string[] = [];
  const companionMacros: string[] = [];

  PARTICIPANT_MACRO_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(PARTICIPANT_MACRO_PATTERN)) {
    const macroName = match[1].toLowerCase();
    if (macroName === 'user') {
      userMacros.push(match[0]);
    } else if (macroName) {
      companionMacros.push(match[0]);
    }
  }
  PARTICIPANT_MACRO_PATTERN.lastIndex = 0;

  const user = userMacros.length > 0
    || USER_REPLACEMENTS.some(pattern => patternMatches(text, pattern));
  const companion = companionMacros.length > 0
    || COMPANION_REPLACEMENTS.some(pattern => patternMatches(text, pattern));

  return {
    user,
    companion,
    userMacros,
    companionMacros,
    hasAny: user || companion,
  };
}

function buildFlexibleNamePattern(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
}

function collapseDuplicateKnownName(text: string, name: string): string {
  const normalizedName = normalizeTrimmed(name);
  if (!normalizedName) return text;

  const namePattern = buildFlexibleNamePattern(normalizedName);
  const possessivePattern = "['\\u2019]s";
  const occurrencePattern = `${namePattern}(?:${possessivePattern})?`;
  const duplicatePattern = new RegExp(
    `(?<![A-Za-z0-9_])(?:${occurrencePattern})(?:\\s+(?:${occurrencePattern}))+(?![A-Za-z0-9_])`,
    'gi',
  );
  const possessiveDuplicatePattern = new RegExp(`${namePattern}${possessivePattern}`, 'i');

  return text.replace(duplicatePattern, duplicate => (
    possessiveDuplicatePattern.test(duplicate) ? `${normalizedName}'s` : normalizedName
  ));
}

function collapseDuplicateKnownNames(text: string, names: ExtractionParticipantNames): string {
  const seen = new Set<string>();
  let nextText = text;
  for (const name of [names.userName, names.companionName]) {
    const normalizedName = normalizeTrimmed(name);
    if (!normalizedName) continue;
    const key = normalizedName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    nextText = collapseDuplicateKnownName(nextText, normalizedName);
  }
  return nextText;
}

function collapseDuplicateCapitalizedNames(text: string): string {
  return text.replace(
    CAPITALIZED_DUPLICATE_NAME_PATTERN,
    (_duplicate, name: string, firstPossessive: string | undefined, laterPossessive: string | undefined) => (
      firstPossessive || laterPossessive ? `${name}'s` : name
    ),
  );
}

export function normalizeDurableMemoryText(
  text: string,
  names: ExtractionParticipantNames,
): DurableMemoryTextHygieneResult {
  let nextText = applyParticipantMacroReplacement(text, names);
  nextText = applyParticipantReplacement(nextText, names.userName, USER_REPLACEMENTS);
  nextText = applyParticipantReplacement(nextText, names.companionName, COMPANION_REPLACEMENTS);
  nextText = collapseDuplicateKnownNames(nextText, names);
  nextText = collapseDuplicateCapitalizedNames(nextText)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!nextText) {
    return {
      accepted: false,
      text: nextText,
      reason: 'empty_text',
    };
  }

  if (containsParticipantMacro(nextText)) {
    return {
      accepted: false,
      text: nextText,
      reason: 'unresolved_participant_macro',
    };
  }

  return {
    accepted: true,
    text: nextText,
    changed: nextText !== text,
  };
}

export function resolveExtractionParticipantNames(
  params: ResolveExtractionParticipantNamesParams,
): ExtractionParticipantNames {
  const canonicalContactName = normalizeTrimmed(params.canonicalContactName);
  const userName = !isGenericLabel(canonicalContactName, GENERIC_USER_LABELS)
    ? canonicalContactName
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
    '- Never write raw character-card macros such as "{{user}}", "{{char}}", "{{character}}", or "{{assistant}}"; skip the fact if the real participant name is unclear.',
  ].join('\n');
}

export function normalizeExtractedFactParticipantNames(
  fact: ExtractedFact,
  names: ExtractionParticipantNames,
): ExtractedFactParticipantNameNormalizationResult {
  const result = normalizeDurableMemoryText(fact.text, names);
  if (!result.accepted) {
    return {
      accepted: false,
      fact,
      reason: result.reason,
    };
  }

  const nextFact = result.changed
    ? {
      ...fact,
      text: result.text,
    }
    : fact;

  return {
    accepted: true,
    fact: nextFact,
    changed: result.changed,
  };
}
