import { constants } from 'node:fs';
import { accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { SkillsRuntimeConfig } from '../system/config/skills-config.js';
import type {
  SkillEligibilityResult,
  SkillEntry,
  SkillEvaluation,
  SkillSkipRecord,
} from './types.js';

export interface SkillEligibilityContext {
  runtimeConfig: SkillsRuntimeConfig;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean;
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function splitConfigPath(path: string): string[] {
  return path
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean);
}

function lookupConfigValue(config: SkillsRuntimeConfig, path: string): unknown {
  const segments = splitConfigPath(path);
  if (segments.length === 0) return undefined;

  let value: unknown = config;
  for (const segment of segments) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[segment];
  }

  return value;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return false;
}

function binaryCandidates(binaryName: string): string[] {
  if (process.platform !== 'win32') return [binaryName];
  const extEnv = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  const extensions = extEnv
    .split(';')
    .map(ext => ext.trim().toLowerCase())
    .filter(Boolean);

  const lower = binaryName.toLowerCase();
  if (extensions.some(ext => lower.endsWith(ext))) {
    return [binaryName];
  }

  return [binaryName, ...extensions.map(ext => `${binaryName}${ext}`)];
}

export function defaultBinaryAvailable(binaryName: string): boolean {
  if (!binaryName.trim()) return false;

  const pathEnv = process.env.PATH ?? '';
  const searchPaths = pathEnv
    .split(delimiter)
    .map(path => path.trim())
    .filter(Boolean);

  if (searchPaths.length === 0) return false;

  const candidates = binaryCandidates(binaryName.trim());
  for (const baseDir of searchPaths) {
    for (const candidate of candidates) {
      const absolutePath = join(baseDir, candidate);
      try {
        accessSync(absolutePath, constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH entries.
      }
    }
  }

  return false;
}

export function evaluateSkillEligibility(
  entry: SkillEntry,
  context: SkillEligibilityContext,
): SkillEligibilityResult {
  const runtimeConfig = context.runtimeConfig;
  const environment = context.environment ?? process.env;
  const checkBinary = context.isBinaryAvailable ?? defaultBinaryAvailable;

  const missingBinaries = uniqStrings(
    entry.requires.binaries.filter(binary => !checkBinary(binary)),
  );

  const missingEnv = uniqStrings(
    entry.requires.env.filter((envVar) => {
      const value = environment[envVar];
      return value === undefined || value.trim() === '';
    }),
  );

  const missingConfig = uniqStrings(
    entry.requires.config.filter(path => !isTruthy(lookupConfigValue(runtimeConfig, path))),
  );

  const disabledByConfig = runtimeConfig.disabledSkills.includes(entry.name);
  const globallyDisabled = !runtimeConfig.enabled;

  const reasons: string[] = [];
  if (globallyDisabled) reasons.push('skills runtime is disabled in config');
  if (disabledByConfig) reasons.push('skill is disabled via skills.disabledSkills');
  if (missingBinaries.length > 0) reasons.push(`missing binaries: ${missingBinaries.join(', ')}`);
  if (missingEnv.length > 0) reasons.push(`missing env vars: ${missingEnv.join(', ')}`);
  if (missingConfig.length > 0) reasons.push(`missing config flags: ${missingConfig.join(', ')}`);

  return {
    eligible: reasons.length === 0,
    disabledByConfig,
    missingBinaries,
    missingEnv,
    missingConfig,
    reasons,
  };
}

export function filterEligibleSkills(
  entries: SkillEntry[],
  context: SkillEligibilityContext,
): {
  evaluations: SkillEvaluation[];
  eligible: SkillEntry[];
  skipped: SkillSkipRecord[];
} {
  const evaluations: SkillEvaluation[] = [];
  const eligible: SkillEntry[] = [];
  const skipped: SkillSkipRecord[] = [];

  for (const entry of entries) {
    const eligibility = evaluateSkillEligibility(entry, context);
    evaluations.push({ entry, eligibility });

    if (eligibility.eligible) {
      eligible.push(entry);
      continue;
    }

    skipped.push({
      kind: 'ineligible',
      name: entry.name,
      relativePath: entry.relativePath,
      source: entry.source,
      reason: eligibility.reasons.join('; '),
      details: eligibility.reasons,
    });
  }

  return {
    evaluations,
    eligible,
    skipped,
  };
}
