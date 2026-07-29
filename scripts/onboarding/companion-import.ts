// ── Companion import (psfn-framework-wckv.1.3) ──
// Leaf 3 of the onboarding flow: import an existing companion definition into a
// runtime CharacterCardV2, or scaffold a fresh one. Four supported inputs:
//   * Character Card V3 (.json/.png/.charx) — reuses the repo's CCv3 pathway
//     (src/core/identity/importer) rather than reimplementing card parsing.
//   * SoulMD documents — structured markdown (optional frontmatter + headed
//     sections) mapped onto the card's persona fields.
//   * Plain persona markdown (Hermes/OpenClaw) — taken as a LUMP into the
//     persona surface WITHOUT CCv2-style field sorting (operator directive:
//     do not force-parse markdown into card fields).
//   * Fresh start — a minimal blank companion (loader's bootstrap starter).
//
// Everything here is pure + staged: parsing and validation happen before any
// write, and malformed input throws a specific error so nothing lands. The
// resulting CharacterCardV2 is validated through the loader's own
// assertValidCharacterCard so it matches exactly what startup will accept.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  parseImportedCharacterCard,
  type CharacterMemorySeed,
} from '../../src/core/identity/importer.js';
import {
  assertValidCharacterCard,
  createBootstrapStarterCard,
} from '../../src/core/identity/loader.js';
import { DEFAULT_COMPANION_NAME } from '../../src/core/identity/companion-naming.js';
import type { CharacterCardV2, CharacterData } from '../../src/core/identity/types.js';

/** Supported companion definition inputs the operator picks between. */
export type CompanionSource = 'ccv3' | 'soulmd' | 'markdown' | 'fresh';

export interface CompanionImportResult {
  source: CompanionSource;
  card: CharacterCardV2;
  /** Non-fatal notes surfaced in the preview (e.g. dropped lorebook, fallbacks). */
  warnings: string[];
  /** Lorebook memory seeds detected on a CCv3 card (not auto-persisted here). */
  memorySeeds: CharacterMemorySeed[];
  /** One-line human summary for the preview/confirm step. */
  summary: string;
}

/** Thrown when an input cannot be parsed into a valid companion definition. */
export class CompanionImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionImportError';
  }
}

const SOURCE_LABELS: Record<CompanionSource, string> = {
  ccv3: 'Character Card V2/V3',
  soulmd: 'SoulMD document',
  markdown: 'plain persona markdown',
  fresh: 'fresh start',
};

export function companionSourceLabel(source: CompanionSource): string {
  return SOURCE_LABELS[source];
}

function emptyCharacterData(name: string): CharacterData {
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: [],
    creator: '',
  };
}

function summarizeCard(source: CompanionSource, card: CharacterCardV2): string {
  const persona = card.data.personality || card.data.description;
  const preview = persona.replace(/\s+/gu, ' ').trim().slice(0, 120);
  return `${SOURCE_LABELS[source]}: "${card.data.name}" — ${preview}${persona.length > 120 ? '…' : ''}`;
}

function finalize(
  source: CompanionSource,
  card: CharacterCardV2,
  warnings: string[],
  memorySeeds: CharacterMemorySeed[],
): CompanionImportResult {
  // Gate through the runtime's own validator so a preview can never confirm a
  // card that startup would then reject.
  try {
    assertValidCharacterCard(card, SOURCE_LABELS[source]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CompanionImportError(reason);
  }
  return { source, card, warnings, memorySeeds, summary: summarizeCard(source, card) };
}

// ── Character Card V3 (reuse the existing importer pathway) ──

export function importCcv3(raw: Uint8Array): CompanionImportResult {
  let parsed: ReturnType<typeof parseImportedCharacterCard>;
  try {
    parsed = parseImportedCharacterCard(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CompanionImportError(`Not a valid character card: ${reason}`);
  }
  const warnings = [...parsed.warnings];
  if (parsed.memorySeeds.length > 0) {
    warnings.push(
      `${parsed.memorySeeds.length} lorebook (character_book) entr`
      + `${parsed.memorySeeds.length === 1 ? 'y was' : 'ies were'} found; the runtime card does `
      + 'not carry a lorebook, so seed these as memories after first boot.',
    );
  }
  return finalize('ccv3', parsed.card, warnings, parsed.memorySeeds);
}

// ── SoulMD (structured markdown persona) ──

interface MarkdownSection {
  heading: string;
  body: string;
}

interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  title?: string;
  /** Text that appears before the first heading (lead paragraph). */
  lead: string;
  sections: MarkdownSection[];
}

function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return { frontmatter, body: text };
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!kv) continue;
    frontmatter[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/gu, '');
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function parseMarkdown(text: string): ParsedMarkdown {
  const { frontmatter, body } = splitFrontmatter(text);
  const lines = body.split(/\r?\n/u);
  const sections: MarkdownSection[] = [];
  let title: string | undefined;
  const leadLines: string[] = [];
  let current: MarkdownSection | undefined;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const label = heading[2].trim();
      if (level === 1 && title === undefined && sections.length === 0) {
        title = label;
        continue;
      }
      current = { heading: label, body: '' };
      sections.push(current);
      continue;
    }
    if (current) {
      current.body += `${line}\n`;
    } else {
      leadLines.push(line);
    }
  }

  for (const section of sections) section.body = section.body.trim();
  return { frontmatter, title, lead: leadLines.join('\n').trim(), sections };
}

// The alias vocabulary deliberately covers the heading conventions of
// OpenClaw/Hermes soul documents (core identity, voice, vibe, boundaries,
// backstory, …) alongside generic card-style headings, so a SOUL.md imports
// into sensible fields instead of lumping everything into the profile.
const SECTION_FIELD_MAP: Array<{ field: keyof CharacterData; aliases: readonly string[] }> = [
  {
    field: 'description',
    aliases: [
      'description', 'about', 'profile', 'summary', 'bio', 'overview',
      'identity', 'core identity', 'who you are', 'who i am', 'who she is', 'who he is', 'who they are',
      'appearance', 'looks',
    ],
  },
  {
    field: 'personality',
    aliases: [
      'personality', 'persona', 'traits', 'character',
      'vibe', 'temperament', 'nature', 'disposition', 'essence', 'soul',
      'voice', 'speech style', 'speaking style', 'how you speak', 'how you talk', 'tone',
      'likes and dislikes', 'interests', 'values',
    ],
  },
  {
    field: 'scenario',
    aliases: [
      'scenario', 'setting', 'world', 'context', 'background',
      'backstory', 'history', 'origin', 'lore',
    ],
  },
  { field: 'first_mes', aliases: ['first message', 'first_mes', 'greeting', 'intro', 'introduction', 'opening'] },
  { field: 'mes_example', aliases: ['example dialogue', 'examples', 'example messages', 'sample dialogue', 'mes_example'] },
  {
    field: 'system_prompt',
    aliases: [
      'system prompt', 'system_prompt', 'instructions', 'directives',
      'boundaries', 'limits', 'hard lines', 'rules',
    ],
  },
  { field: 'post_history_instructions', aliases: ['post history instructions', 'post_history_instructions', 'jailbreak'] },
];

function matchSectionField(heading: string): keyof CharacterData | undefined {
  const normalized = heading.trim().toLowerCase().replace(/[:.]+$/u, '');
  for (const { field, aliases } of SECTION_FIELD_MAP) {
    if (aliases.includes(normalized)) return field;
  }
  return undefined;
}

export function importSoulMd(text: string): CompanionImportResult {
  const parsed = parseMarkdown(text);
  const warnings: string[] = [];
  const data = emptyCharacterData('');

  const nameFromFront = parsed.frontmatter.name;
  data.name = (nameFromFront || parsed.title || '').trim();

  if (parsed.frontmatter.creator) data.creator = parsed.frontmatter.creator;
  const version = parsed.frontmatter.version ?? parsed.frontmatter.character_version;
  if (version) data.character_version = version;
  if (parsed.frontmatter.tags) {
    data.tags = parsed.frontmatter.tags
      .replace(/^\[|\]$/gu, '')
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  const unmatched: string[] = [];
  let matchedAny = false;
  for (const section of parsed.sections) {
    if (!section.body) continue;
    const field = matchSectionField(section.heading);
    if (field === undefined) {
      // Preserve unknown sections as part of the profile rather than dropping.
      unmatched.push(`## ${section.heading}\n${section.body}`);
      continue;
    }
    matchedAny = true;
    const existing = data[field];
    const next = typeof existing === 'string' && existing.length > 0
      ? `${existing}\n\n${section.body}`
      : section.body;
    (data as Record<string, unknown>)[field] = next;
  }

  if (parsed.lead && !data.description) {
    data.description = parsed.lead;
  }
  if (unmatched.length > 0) {
    data.description = [data.description, ...unmatched].filter(Boolean).join('\n\n');
    warnings.push(
      `${unmatched.length} unrecognized section${unmatched.length === 1 ? '' : 's'} `
      + 'appended to the profile/description rather than dropped.',
    );
  }

  if (!data.name) {
    throw new CompanionImportError(
      'SoulMD document is missing a name: add a "name:" frontmatter key or a top-level "# Name" heading.',
    );
  }
  if (!matchedAny && !data.description) {
    throw new CompanionImportError(
      'SoulMD document has no recognizable persona content: expected a "## Personality" '
      + 'or "## Description" section (or frontmatter + headed sections).',
    );
  }
  // Satisfy the runtime's required personality field from the profile when the
  // document only supplied a description-style section.
  if (!data.personality) {
    data.personality = data.description;
    warnings.push('No explicit Personality section; used the description/profile as the persona.');
  }

  return finalize('soulmd', { spec: 'chara_card_v2', spec_version: '2.0', data }, warnings, []);
}

// ── Plain persona markdown (Hermes/OpenClaw): LUMP, no field sorting ──

export function importMarkdownLump(text: string, name: string): CompanionImportResult {
  const lump = text.trim();
  if (!lump) {
    throw new CompanionImportError('Persona markdown file is empty.');
  }
  const resolvedName = name.trim();
  if (!resolvedName) {
    throw new CompanionImportError('A companion name is required for a plain-markdown persona import.');
  }
  const data = emptyCharacterData(resolvedName);
  // The entire document is taken as one persona lump into the persona surface,
  // deliberately WITHOUT splitting it into card fields.
  data.personality = lump;
  return finalize(
    'markdown',
    { spec: 'chara_card_v2', spec_version: '2.0', data },
    ['Imported as a single persona lump (no field parsing applied).'],
    [],
  );
}

/** Best-effort default name for a lump import: first H1, else the filename stem. */
export function suggestLumpName(text: string, sourcePath: string): string {
  const h1 = /^#\s+(.+?)\s*$/mu.exec(text);
  if (h1) return h1[1].trim();
  const stem = basename(sourcePath).replace(/\.[^.]+$/u, '').trim();
  return stem.length > 0 ? stem : DEFAULT_COMPANION_NAME;
}

// ── Fresh start ──

export function freshStart(name: string): CompanionImportResult {
  const resolved = name.trim() || DEFAULT_COMPANION_NAME;
  const card = createBootstrapStarterCard(resolved);
  return finalize('fresh', card, [], []);
}

// ── Detection (advisory: the operator's choice is authoritative) ──

const CHARX_MAGIC = Buffer.from('PK');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Best-effort format sniff, used to show a "detected format" line in the preview
 * and to warn on an obvious mismatch. It never overrides the operator's choice.
 */
export function detectCompanionFormat(sourcePath: string, raw: Buffer): CompanionSource {
  if (raw.length >= 4 && raw.subarray(0, 4).equals(PNG_MAGIC)) return 'ccv3';
  if (raw.length >= 2 && raw.subarray(0, 2).equals(CHARX_MAGIC)) return 'ccv3';
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.png' || ext === '.charx') return 'ccv3';
  const text = raw.toString('utf-8');
  if (text.trimStart().startsWith('{') || ext === '.json') return 'ccv3';
  if (/^---\r?\n/u.test(text) || /^#{1,3}\s+/mu.test(text)) return 'soulmd';
  return 'markdown';
}

// ── File dispatcher ──

export interface FileImportOptions {
  /** Name for the lump path (plain markdown), already resolved via a prompt. */
  lumpName?: string;
}

export function importCompanionFromFile(
  source: Exclude<CompanionSource, 'fresh'>,
  sourcePath: string,
  options: FileImportOptions = {},
): CompanionImportResult {
  let raw: Buffer;
  try {
    raw = readFileSync(sourcePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CompanionImportError(`Cannot read companion definition at ${sourcePath}: ${reason}`);
  }
  switch (source) {
    case 'ccv3':
      return importCcv3(raw);
    case 'soulmd':
      return importSoulMd(raw.toString('utf-8'));
    case 'markdown':
      return importMarkdownLump(
        raw.toString('utf-8'),
        options.lumpName ?? suggestLumpName(raw.toString('utf-8'), sourcePath),
      );
    default: {
      const exhaustive: never = source;
      throw new CompanionImportError(`Unsupported companion source: ${String(exhaustive)}`);
    }
  }
}
