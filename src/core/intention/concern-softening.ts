// ── Concern softening rules (E2.5) ──
// The wording rewrites applied to active-concern text before it reaches the
// prompt used to be hardcoded in softenConcernText (including a
// companion-specific name). Phrasing is personality-sensitive (purity rule),
// so the rules are operator-tunable data: config/concern-softening.json,
// loaded fail-closed alongside the runtime prompt layer seed. The shipped
// default file reproduces the previous code-owned behavior byte-for-byte.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export const CONCERN_SOFTENING_CONFIG_FILE_NAME = 'concern-softening.json';

const REGEX_FLAGS_PATTERN = /^[gimsuy]*$/;
const MIN_MAX_TEXT_CHARS = 8;
const MAX_MAX_TEXT_CHARS = 2000;

export interface ConcernSofteningRule {
  pattern: RegExp;
  replacement: string;
}

export interface ConcernSofteningConfig {
  /** Concern text longer than this is truncated with a trailing ellipsis. */
  maxTextChars: number;
  /** Rewrite rules applied in order to whitespace-compacted concern text. */
  rewriteRules: ConcernSofteningRule[];
}

export interface ConcernSofteningConfigLoadOptions {
  configDir?: string;
}

export interface ConcernSofteningStartupValidationResult {
  ok: boolean;
  errors: string[];
}

let concernSofteningConfigCache: ConcernSofteningConfig | null = null;

function parseRule(value: unknown, fieldPath: string): ConcernSofteningRule {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  if (typeof value.pattern !== 'string' || value.pattern.length === 0) {
    throw new Error(`${fieldPath}.pattern must be a non-empty string`);
  }
  const flags = value.flags === undefined ? '' : value.flags;
  if (typeof flags !== 'string' || !REGEX_FLAGS_PATTERN.test(flags)) {
    throw new Error(`${fieldPath}.flags must be a string of regex flags (gimsuy)`);
  }
  if (typeof value.replacement !== 'string') {
    throw new Error(`${fieldPath}.replacement must be a string`);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(value.pattern, flags);
  } catch (error) {
    throw new Error(`${fieldPath}.pattern is not a valid regular expression: ${String(error)}`);
  }
  return { pattern, replacement: value.replacement };
}

export function parseConcernSofteningConfig(value: unknown, sourcePath: string): ConcernSofteningConfig {
  if (!isRecord(value)) {
    throw new Error(`${sourcePath} must contain a JSON object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${sourcePath}.schemaVersion must be 1`);
  }
  const maxTextChars = value.maxTextChars;
  if (
    typeof maxTextChars !== 'number'
    || !Number.isInteger(maxTextChars)
    || maxTextChars < MIN_MAX_TEXT_CHARS
    || maxTextChars > MAX_MAX_TEXT_CHARS
  ) {
    throw new Error(
      `${sourcePath}.maxTextChars must be an integer between ${MIN_MAX_TEXT_CHARS} and ${MAX_MAX_TEXT_CHARS}`,
    );
  }
  if (!Array.isArray(value.rewriteRules)) {
    throw new Error(`${sourcePath}.rewriteRules must be an array`);
  }
  return {
    maxTextChars,
    rewriteRules: value.rewriteRules.map((rule, index) => parseRule(rule, `${sourcePath}.rewriteRules[${index}]`)),
  };
}

function resolveConcernSofteningConfigPath(options: ConcernSofteningConfigLoadOptions = {}): string {
  const configDir = options.configDir?.trim() || process.env.CONFIG_DIR?.trim() || join(process.cwd(), 'config');
  return join(configDir, CONCERN_SOFTENING_CONFIG_FILE_NAME);
}

export function loadConcernSofteningConfig(
  options: ConcernSofteningConfigLoadOptions = {},
): ConcernSofteningConfig {
  const configPath = resolveConcernSofteningConfigPath(options);
  return parseConcernSofteningConfig(
    JSON.parse(readFileSync(configPath, 'utf-8')) as unknown,
    configPath,
  );
}

export function verifyConcernSofteningStartupConfig(
  options: ConcernSofteningConfigLoadOptions = {},
): ConcernSofteningStartupValidationResult {
  const configPath = resolveConcernSofteningConfigPath(options);
  try {
    loadConcernSofteningConfig(options);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `concern-softening static config validation failed at ${configPath}: ${toErrorMessage(error)}`,
      ],
    };
  }

  return {
    ok: true,
    errors: [],
  };
}

function readConcernSofteningConfig(): ConcernSofteningConfig {
  return loadConcernSofteningConfig();
}

/** Load (and cache) the operator-tunable concern softening rules. Fail closed. */
export function getConcernSofteningConfig(): ConcernSofteningConfig {
  concernSofteningConfigCache ??= readConcernSofteningConfig();
  return concernSofteningConfigCache;
}

/** Test hook: clear the cached config so a test can point CONFIG_DIR elsewhere. */
export function resetConcernSofteningConfigCacheForTests(): void {
  concernSofteningConfigCache = null;
}
