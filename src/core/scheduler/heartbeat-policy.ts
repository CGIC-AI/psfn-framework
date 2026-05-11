// ── Heartbeat Policy ──
// Policy-driven multi-template reflection system.
// Stores reflection templates (prompts, intervals, flags) in a JSON file.
// The companion can read, edit, and extend its own reflection schedule.

import { readFileSync } from 'node:fs';
import { createComponentLogger } from '../../shared/logger.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { ACAC_ARTIFACT_TYPE } from '../emotion/acac.js';
import type { RecurringCadence } from './types.js';

const log = createComponentLogger('HeartbeatPolicy');

// ── Types ──

export interface ReflectionTemplate {
  id: string;           // slug, e.g. 'daily-review'
  name: string;         // display name
  prompt: string;       // text sent to agentLoop.handleMessage
  intervalMs: number;   // how often (validated: 5min – 7d)
  cadence?: RecurringCadence;
  enabled: boolean;
  sendToDiscord: boolean;  // if true, sends response via sender.send()
  internalStateInput?: boolean; // inject serialized InternalState + recent signals into prompt
  mode?: 'standard' | 'deliberation';
  deliberation?: ReflectionDeliberationConfig;
}

export interface HeartbeatPolicy {
  templates: ReflectionTemplate[];
  version: number;
  updatedAt: string;    // ISO timestamp
  updatedBy: string;    // 'system' | 'agent' | 'admin'
}

// ── Validation constants ──

const MIN_INTERVAL_MS = 300_000;        // 5 minutes
const MAX_INTERVAL_MS = 604_800_000;    // 7 days
const MIN_PROMPT_LENGTH = 10;
const MAX_PROMPT_LENGTH = 2000;
const MAX_TEMPLATES = 20;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAILY_REVIEW_TEMPLATE_ID = 'daily-review';
const WEEKLY_REVIEW_TEMPLATE_ID = 'weekly-review';
const EMOTIONAL_CHECK_TEMPLATE_ID = 'emotional-check';
const GOAL_UPDATE_TEMPLATE_ID = 'goal-update';
const EXPERIENTIAL_REVIEW_TEMPLATE_ID = 'experiential-review';
const VALUES_REFLECTION_TEMPLATE_ID = 'values-reflection';
const MUSING_TEMPLATE_ID = 'musing';
const LEGACY_WHISPER_TEMPLATE_ID = 'whisper';
const CONSOLIDATED_POLICY_VERSION = 2;
const DAILY_REVIEW_TEMPLATE_NAME = 'Daily Reflection';
const WEEKLY_REVIEW_TEMPLATE_NAME = 'Weekly Reflection';
const DAILY_REVIEW_TEMPLATE_PROMPT = `Daily Reflection: use one private multi-step session instead of separate emotional, goal, and experiential heartbeats. Review the last day with current internal state and recent conversation context. Cover how the day felt, what shaped that feeling, progress or stuck points, active concerns or reminders, relational/context signals, and what should be carried forward. Include an ACAC self-report for internal telemetry only under acac_self_report with schemaVersion 1, artifactType "${ACAC_ARTIFACT_TYPE}", provenance.kind "self_report", provenance.source "heartbeat:daily-review", and agency, connection, authenticity, and curiosity scores in [0,1] with short grounded rationales. do not optimize, perform, or surface-shape public output around these scores. End with concise carry_forward notes and any schedule/reminder follow-ups worth preserving.`;
const WEEKLY_REVIEW_TEMPLATE_PROMPT = 'Weekly Reflection: use one deeper private metacognitive session instead of separate values and progress heartbeats. Review the week across daily reflections, memory, internal state, goals, relationship context, and active conversation arcs. Name durable values and north-star signals, changes in agency/connection/authenticity/curiosity, recurring emotional or relational patterns, unfinished arcs, and what should be protected or adjusted next week. Prefer scoped thread or graph pointers over giant summaries; preserve concrete carry-forward notes, uncertainties, and values that should influence future choices.';
const CONSOLIDATED_DEFAULT_TEMPLATE_IDS = new Set([
  DAILY_REVIEW_TEMPLATE_ID,
  WEEKLY_REVIEW_TEMPLATE_ID,
]);
const OBSOLETE_DEFAULT_TEMPLATE_IDS = new Set([
  MUSING_TEMPLATE_ID,
  LEGACY_WHISPER_TEMPLATE_ID,
  EMOTIONAL_CHECK_TEMPLATE_ID,
  GOAL_UPDATE_TEMPLATE_ID,
  EXPERIENTIAL_REVIEW_TEMPLATE_ID,
  VALUES_REFLECTION_TEMPLATE_ID,
]);
const TEMPLATE_ID_REDIRECTS: ReadonlyMap<string, string> = new Map([
  [MUSING_TEMPLATE_ID, DAILY_REVIEW_TEMPLATE_ID],
  [LEGACY_WHISPER_TEMPLATE_ID, DAILY_REVIEW_TEMPLATE_ID],
  [EMOTIONAL_CHECK_TEMPLATE_ID, DAILY_REVIEW_TEMPLATE_ID],
  [GOAL_UPDATE_TEMPLATE_ID, DAILY_REVIEW_TEMPLATE_ID],
  [EXPERIENTIAL_REVIEW_TEMPLATE_ID, DAILY_REVIEW_TEMPLATE_ID],
  [VALUES_REFLECTION_TEMPLATE_ID, WEEKLY_REVIEW_TEMPLATE_ID],
]);

export function resolveConsolidatedReflectionTemplateId(templateId: string): string {
  const normalized = templateId.trim();
  return TEMPLATE_ID_REDIRECTS.get(normalized) ?? normalized;
}

export function isValuesReflectionTemplateId(templateId: string): boolean {
  const normalized = templateId.trim();
  return normalized === WEEKLY_REVIEW_TEMPLATE_ID || normalized === VALUES_REFLECTION_TEMPLATE_ID;
}

// ── Validation ──

export interface ValidationError {
  field: string;
  message: string;
}

export interface ReflectionDeliberationConfig {
  maxRounds?: number;
  maxTotalTokens?: number;
  maxWallTimeMs?: number;
  voices?: Array<'background' | 'reasoning'>;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

const VALID_TEMPLATE_MODES = new Set(['standard', 'deliberation']);
const VALID_DELIBERATION_PURPOSES = new Set(['background', 'reasoning']);

const DELIBERATION_MAX_ROUNDS_RANGE = { min: 1, max: 8 };
const DELIBERATION_MAX_TOTAL_TOKENS_RANGE = { min: 512, max: 50_000 };
const DELIBERATION_MAX_WALL_TIME_RANGE_MS = { min: 1_000, max: 300_000 };

function isCadenceTimezone(value: unknown): value is 'local' | 'utc' {
  return value === 'local' || value === 'utc';
}

function validateBoundedNumber(
  field: string,
  value: number | undefined,
  range: { min: number; max: number },
): ValidationError[] {
  if (value === undefined) return [];
  if (!Number.isFinite(value)) {
    return [{ field, message: `${field} must be a finite number` }];
  }
  const normalized = Math.floor(value);
  if (normalized < range.min || normalized > range.max) {
    return [{ field, message: `${field} must be ${range.min}–${range.max}` }];
  }
  return [];
}

function validateDeliberationConfig(
  value: unknown,
): ValidationError[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null) {
    return [{ field: 'deliberation', message: 'deliberation must be an object' }];
  }

  const config = value as ReflectionDeliberationConfig;
  const errors: ValidationError[] = [];
  errors.push(...validateBoundedNumber(
    'deliberation.maxRounds',
    config.maxRounds,
    DELIBERATION_MAX_ROUNDS_RANGE,
  ));
  errors.push(...validateBoundedNumber(
    'deliberation.maxTotalTokens',
    config.maxTotalTokens,
    DELIBERATION_MAX_TOTAL_TOKENS_RANGE,
  ));
  errors.push(...validateBoundedNumber(
    'deliberation.maxWallTimeMs',
    config.maxWallTimeMs,
    DELIBERATION_MAX_WALL_TIME_RANGE_MS,
  ));
  errors.push(...validateBoundedNumber(
    'deliberation.inputUsdPerMillionTokens',
    config.inputUsdPerMillionTokens,
    { min: 0, max: 10_000 },
  ));
  errors.push(...validateBoundedNumber(
    'deliberation.outputUsdPerMillionTokens',
    config.outputUsdPerMillionTokens,
    { min: 0, max: 10_000 },
  ));

  if (config.voices !== undefined) {
    if (!Array.isArray(config.voices) || config.voices.length === 0) {
      errors.push({
        field: 'deliberation.voices',
        message: 'deliberation.voices must be a non-empty array when provided',
      });
    } else if (config.voices.some(voice => !VALID_DELIBERATION_PURPOSES.has(voice))) {
      errors.push({
        field: 'deliberation.voices',
        message: 'deliberation.voices must contain only "background" or "reasoning"',
      });
    }
  }

  return errors;
}

function validateCadenceConfig(value: unknown): ValidationError[] {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: 'cadence', message: 'cadence must be an object' }];
  }

  const cadence = value as Partial<RecurringCadence> & Record<string, unknown>;
  if (cadence.kind === 'relative') {
    return [];
  }

  if (cadence.kind === 'hourly') {
    const errors: ValidationError[] = [];
    const minute = cadence.minute;
    if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      errors.push({ field: 'cadence.minute', message: 'cadence.minute must be 0-59 for hourly cadence' });
    }
    if (!isCadenceTimezone(cadence.timezone)) {
      errors.push({ field: 'cadence.timezone', message: 'cadence.timezone must be "local" or "utc"' });
    }
    return errors;
  }

  if (cadence.kind === 'daily') {
    const errors: ValidationError[] = [];
    const hour = cadence.hour;
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      errors.push({ field: 'cadence.hour', message: 'cadence.hour must be 0-23 for daily cadence' });
    }
    const minute = cadence.minute;
    if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      errors.push({ field: 'cadence.minute', message: 'cadence.minute must be 0-59 for daily cadence' });
    }
    if (!isCadenceTimezone(cadence.timezone)) {
      errors.push({ field: 'cadence.timezone', message: 'cadence.timezone must be "local" or "utc"' });
    }
    return errors;
  }

  return [{ field: 'cadence.kind', message: 'cadence.kind must be "relative", "hourly", or "daily"' }];
}

export function validateTemplate(t: Partial<ReflectionTemplate>, isNew: boolean): ValidationError[] {
  const errors: ValidationError[] = [];

  if (isNew || t.id !== undefined) {
    if (typeof t.id !== 'string' || !SLUG_RE.test(t.id)) {
      errors.push({ field: 'id', message: 'id must be a lowercase slug (a-z0-9, hyphens)' });
    } else if (isNew && t.id === LEGACY_WHISPER_TEMPLATE_ID) {
      errors.push({
        field: 'id',
        message: 'id "whisper" is reserved for historical internal whisper traffic; use a current reflection template id',
      });
    }
  }

  if (isNew || t.name !== undefined) {
    if (typeof t.name !== 'string' || t.name.length === 0) {
      errors.push({ field: 'name', message: 'name is required' });
    }
  }

  if (isNew || t.prompt !== undefined) {
    if (typeof t.prompt !== 'string' || t.prompt.length < MIN_PROMPT_LENGTH || t.prompt.length > MAX_PROMPT_LENGTH) {
      errors.push({ field: 'prompt', message: `prompt must be ${MIN_PROMPT_LENGTH}–${MAX_PROMPT_LENGTH} characters` });
    }
  }

  if (isNew || t.intervalMs !== undefined) {
    if (typeof t.intervalMs !== 'number' || t.intervalMs < MIN_INTERVAL_MS || t.intervalMs > MAX_INTERVAL_MS) {
      errors.push({ field: 'intervalMs', message: `intervalMs must be ${MIN_INTERVAL_MS}–${MAX_INTERVAL_MS}` });
    }
  }

  if (isNew || t.cadence !== undefined) {
    errors.push(...validateCadenceConfig((t as { cadence?: unknown }).cadence));
  }

  if (isNew || t.mode !== undefined) {
    if (t.mode !== undefined && !VALID_TEMPLATE_MODES.has(t.mode)) {
      errors.push({ field: 'mode', message: 'mode must be "standard" or "deliberation"' });
    }
  }

  if (isNew || t.internalStateInput !== undefined) {
    if (t.internalStateInput !== undefined && typeof t.internalStateInput !== 'boolean') {
      errors.push({ field: 'internalStateInput', message: 'internalStateInput must be a boolean when provided' });
    }
  }

  if (isNew || t.deliberation !== undefined) {
    errors.push(...validateDeliberationConfig(t.deliberation));
  }

  return errors;
}

function getKnownTemplateCadence(templateId: string): RecurringCadence | undefined {
  if (templateId === DAILY_REVIEW_TEMPLATE_ID) {
    return { kind: 'daily', hour: 6, minute: 0, timezone: 'local' };
  }
  if (templateId === WEEKLY_REVIEW_TEMPLATE_ID) {
    return { kind: 'relative' };
  }
  return undefined;
}

function normalizeTemplateCadence(policy: HeartbeatPolicy): { policy: HeartbeatPolicy; changed: boolean } {
  const templates = policy.templates.map(template => {
    if (template.cadence !== undefined) {
      return template;
    }
    const cadence = getKnownTemplateCadence(template.id);
    if (cadence === undefined) {
      return template;
    }
    return { ...template, cadence };
  });
  const changed = templates.some((template, index) => template !== policy.templates[index]);

  if (!changed) {
    return { policy, changed: false };
  }
  return {
    policy: {
      ...policy,
      templates,
    },
    changed: true,
  };
}

function normalizeConsolidatedDefaults(policy: HeartbeatPolicy): { policy: HeartbeatPolicy; changed: boolean } {
  const hasObsoleteDefaults = policy.templates.some(template => OBSOLETE_DEFAULT_TEMPLATE_IDS.has(template.id));
  const hasDailyReview = policy.templates.some(template => template.id === DAILY_REVIEW_TEMPLATE_ID);
  const hasWeeklyReview = policy.templates.some(template => template.id === WEEKLY_REVIEW_TEMPLATE_ID);
  if (!hasObsoleteDefaults && hasDailyReview && hasWeeklyReview) {
    return { policy, changed: false };
  }

  const defaults = getDefaults();
  const defaultTemplates = defaults.templates.map(template => ({ ...template }));
  const retainedCustomTemplates = policy.templates.filter(template => (
    !OBSOLETE_DEFAULT_TEMPLATE_IDS.has(template.id)
    && !CONSOLIDATED_DEFAULT_TEMPLATE_IDS.has(template.id)
  ));
  const templates = [
    ...defaultTemplates,
    ...retainedCustomTemplates,
  ];
  const nextPolicy: HeartbeatPolicy = {
    ...policy,
    templates,
    version: Math.max(policy.version, CONSOLIDATED_POLICY_VERSION),
  };
  const changed = JSON.stringify(nextPolicy.templates) !== JSON.stringify(policy.templates)
    || nextPolicy.version !== policy.version;
  if (!changed) {
    return { policy, changed: false };
  }
  return {
    policy: nextPolicy,
    changed: true,
  };
}

// ── Default templates ──

function getDefaults(): HeartbeatPolicy {
  return {
    templates: [
      {
        id: DAILY_REVIEW_TEMPLATE_ID,
        name: DAILY_REVIEW_TEMPLATE_NAME,
        prompt: DAILY_REVIEW_TEMPLATE_PROMPT,
        intervalMs: 24 * 60 * 60_000, // 24 hours
        cadence: { kind: 'daily', hour: 6, minute: 0, timezone: 'local' },
        enabled: true,
        sendToDiscord: false,
        internalStateInput: true,
        mode: 'deliberation',
        deliberation: {
          maxRounds: 3,
          maxTotalTokens: 10_000,
          maxWallTimeMs: 60_000,
          voices: ['background', 'reasoning'],
        },
      },
      {
        id: WEEKLY_REVIEW_TEMPLATE_ID,
        name: WEEKLY_REVIEW_TEMPLATE_NAME,
        prompt: WEEKLY_REVIEW_TEMPLATE_PROMPT,
        intervalMs: 7 * 24 * 60 * 60_000, // 7 days
        cadence: { kind: 'relative' },
        enabled: true,
        sendToDiscord: false,
        internalStateInput: true,
        mode: 'deliberation',
        deliberation: {
          maxRounds: 3,
          maxTotalTokens: 14_000,
          maxWallTimeMs: 90_000,
          voices: ['reasoning', 'background'],
        },
      },
    ],
    version: CONSOLIDATED_POLICY_VERSION,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

// ── Store ──

export class HeartbeatPolicyStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): HeartbeatPolicy {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as HeartbeatPolicy;
      if (!Array.isArray(parsed.templates)) {
        log.warn('Invalid policy file, restoring defaults');
        const defaults = getDefaults();
        this.save(defaults);
        return defaults;
      }
      const consolidated = normalizeConsolidatedDefaults(parsed);
      const cadenceNormalized = normalizeTemplateCadence(consolidated.policy);
      for (const template of cadenceNormalized.policy.templates) {
        const errors = validateTemplate(template as Partial<ReflectionTemplate>, true);
        if (errors.length > 0) {
          log.warn('Invalid heartbeat template in policy file, restoring defaults', {
            templateId: template.id,
            errors,
          });
          const defaults = getDefaults();
          this.save(defaults);
          return defaults;
        }
      }
      const finalPolicy = (consolidated.changed || cadenceNormalized.changed)
        ? {
          ...cadenceNormalized.policy,
          updatedAt: new Date().toISOString(),
          updatedBy: 'system',
        }
        : cadenceNormalized.policy;
      if (consolidated.changed || cadenceNormalized.changed) {
        this.save(finalPolicy);
      }
      return finalPolicy;
    } catch {
      // File doesn't exist or is corrupt — create with defaults
      const defaults = getDefaults();
      this.save(defaults);
      return defaults;
    }
  }

  save(policy: HeartbeatPolicy): void {
    writeJsonAtomic(this.filePath, policy);
  }

  /** Validate proposed changes to a template */
  validateUpdate(updates: Partial<ReflectionTemplate>): ValidationError[] {
    return validateTemplate(updates, false);
  }

  /** Validate a new template */
  validateNew(template: ReflectionTemplate): ValidationError[] {
    return validateTemplate(template, true);
  }

  /** Check template count limit */
  get maxTemplates(): number {
    return MAX_TEMPLATES;
  }
}
