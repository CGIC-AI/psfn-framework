import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePersistenceRoots } from '../persistence/layout.js';

export interface VAD {
  valence: number;
  arousal: number;
  dominance: number;
}

export type VadLexicon = ReadonlyMap<string, Readonly<VAD>>;

export interface ResolveVadLexiconPathOptions {
  env?: NodeJS.ProcessEnv;
  systemDataDir?: string;
  companionDataDir?: string;
  legacyDataDir?: string;
  lexiconPath?: string;
}

export interface LoadVadLexiconOptions extends ResolveVadLexiconPathOptions {
  cache?: boolean;
}

export interface VadTokenScore {
  score: VAD;
  matchedTokenCount: number;
  totalTokenCount: number;
}

export const NRC_VAD_LEXICON_ENV_VAR = 'NRC_VAD_LEXICON_PATH';
export const NRC_VAD_LEXICON_FILENAME = 'nrc-vad-lexicon-v2.tsv';
export const NRC_VAD_LEXICON_RELATIVE_PATH = Object.freeze(['emotion', NRC_VAD_LEXICON_FILENAME] as const);
export const NEUTRAL_VAD: Readonly<VAD> = Object.freeze({
  valence: 0.5,
  arousal: 0.5,
  dominance: 0.5,
});

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

let cachedLexiconPath: string | null = null;
let cachedLexicon: VadLexicon | null = null;

function normalizeApostrophes(value: string): string {
  return value.replace(/[’‘]/g, '\'');
}

function cloneVad(value: Readonly<VAD>): VAD {
  return {
    valence: value.valence,
    arousal: value.arousal,
    dominance: value.dominance,
  };
}

export function normalizeVadToken(value: string): string {
  const lowered = normalizeApostrophes(value).trim().toLowerCase();
  if (!lowered) return '';
  return lowered.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function splitLexiconLine(line: string): string[] {
  if (line.includes('\t')) {
    return line.split('\t').map(part => part.trim());
  }
  if (line.includes(',')) {
    return line.split(',').map(part => part.trim());
  }
  return line.split(/\s+/u).map(part => part.trim());
}

function isHeaderRow(columns: readonly string[]): boolean {
  if (columns.length < 4) return false;
  const normalized = columns.map(column => column.trim().toLowerCase());
  return (normalized[0] === 'term' || normalized[0] === 'word')
    && normalized[1] === 'valence'
    && normalized[2] === 'arousal'
    && normalized[3] === 'dominance';
}

function parseScore(rawValue: string, dimension: keyof VAD, lineNumber: number, sourceLabel: string): number {
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${dimension} score at ${sourceLabel}:${lineNumber}. Expected number, got "${rawValue}".`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`Invalid ${dimension} score at ${sourceLabel}:${lineNumber}. Expected range [0, 1], got "${rawValue}".`);
  }
  return value;
}

export function resolveVadLexiconPath(options: ResolveVadLexiconPathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = options.lexiconPath ?? env[NRC_VAD_LEXICON_ENV_VAR];
  const normalizedOverride = typeof override === 'string' ? override.trim() : '';
  if (normalizedOverride) {
    return normalizedOverride;
  }

  const roots = resolvePersistenceRoots({
    systemDataDir: options.systemDataDir ?? env.SYSTEM_DATA_DIR,
    companionDataDir: options.companionDataDir ?? env.COMPANION_DATA_DIR,
    legacyDataDir: options.legacyDataDir ?? env.DATA_DIR,
  });

  return join(roots.systemDataDir, ...NRC_VAD_LEXICON_RELATIVE_PATH);
}

export function parseVadLexicon(content: string, sourceLabel = 'NRC VAD lexicon'): VadLexicon {
  const lexicon = new Map<string, Readonly<VAD>>();
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = (lines[index] ?? '').trim();
    if (!line || line.startsWith('#')) continue;

    const columns = splitLexiconLine(line);
    if (isHeaderRow(columns)) continue;
    if (columns.length < 4) {
      throw new Error(`Invalid lexicon row at ${sourceLabel}:${lineNumber}. Expected at least 4 columns.`);
    }

    const token = normalizeVadToken(columns[0] ?? '');
    if (!token) continue;

    const valence = parseScore(columns[1] ?? '', 'valence', lineNumber, sourceLabel);
    const arousal = parseScore(columns[2] ?? '', 'arousal', lineNumber, sourceLabel);
    const dominance = parseScore(columns[3] ?? '', 'dominance', lineNumber, sourceLabel);

    lexicon.set(token, Object.freeze({ valence, arousal, dominance }));
  }

  if (lexicon.size === 0) {
    throw new Error(`NRC VAD lexicon at ${sourceLabel} did not contain any valid rows.`);
  }

  return lexicon;
}

export function clearVadLexiconCache(): void {
  cachedLexiconPath = null;
  cachedLexicon = null;
}

export function loadVadLexicon(options: LoadVadLexiconOptions = {}): VadLexicon {
  const lexiconPath = resolveVadLexiconPath(options);
  const useCache = options.cache ?? true;

  if (useCache && cachedLexicon && cachedLexiconPath === lexiconPath) {
    return cachedLexicon;
  }

  const raw = readFileSync(lexiconPath, 'utf-8');
  const parsed = parseVadLexicon(raw, lexiconPath);
  if (useCache) {
    cachedLexiconPath = lexiconPath;
    cachedLexicon = parsed;
  }
  return parsed;
}

export function tokenizeVadText(text: string): string[] {
  const matches = normalizeApostrophes(text.toLowerCase()).match(TOKEN_PATTERN);
  if (!matches) return [];
  return matches
    .map(token => normalizeVadToken(token))
    .filter(token => token.length > 0);
}

export function scoreVadTokens(tokens: readonly string[], lexicon: VadLexicon): VadTokenScore {
  let matchedTokenCount = 0;
  let valenceSum = 0;
  let arousalSum = 0;
  let dominanceSum = 0;

  for (const rawToken of tokens) {
    const token = normalizeVadToken(rawToken);
    if (!token) continue;

    const match = lexicon.get(token);
    if (!match) continue;

    matchedTokenCount += 1;
    valenceSum += match.valence;
    arousalSum += match.arousal;
    dominanceSum += match.dominance;
  }

  if (matchedTokenCount === 0) {
    return {
      score: cloneVad(NEUTRAL_VAD),
      matchedTokenCount: 0,
      totalTokenCount: tokens.length,
    };
  }

  return {
    score: {
      valence: valenceSum / matchedTokenCount,
      arousal: arousalSum / matchedTokenCount,
      dominance: dominanceSum / matchedTokenCount,
    },
    matchedTokenCount,
    totalTokenCount: tokens.length,
  };
}

export function scoreText(text: string, lexicon: VadLexicon = loadVadLexicon()): VAD {
  return scoreVadTokens(tokenizeVadText(text), lexicon).score;
}
