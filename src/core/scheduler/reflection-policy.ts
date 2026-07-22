// ── Reflection Policy ──
// Policy-driven multi-template reflection system.
// Stores reflection templates (prompts, intervals, flags) in a JSON file.
// The companion can read, edit, and extend its own reflection schedule.

import { createComponentLogger } from '../../shared/logger.js';
import {
  invalidateCachedJsonValue,
  loadRequiredJsonCached,
} from '../../system/config/load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type { DailyRecurringCadence, RecurringCadence, WeeklyRecurringCadence } from './types.js';

const log = createComponentLogger('ReflectionPolicy');

// ── Types ──

export interface ReflectionTemplate {
  id: string;           // slug, e.g. 'daily-review'
  name: string;         // display name
  prompt: string;       // text sent to agentLoop.handleMessage
  intervalMs: number;   // how often (validated: 5min – 7d)
  cadence?: RecurringCadence;
  enabled: boolean;
  internalStateInput?: boolean; // inject serialized InternalState + recent signals into prompt
  mode?: 'standard' | 'deliberation';
  deliberation?: ReflectionDeliberationConfig;
}

export interface ReflectionPolicy {
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
const MIXED_STATE_REVIEW_TEMPLATE_ID = 'mixed-state-review';
const EMOTIONAL_CHECK_TEMPLATE_ID = 'emotional-check';
const GOAL_UPDATE_TEMPLATE_ID = 'goal-update';
const EXPERIENTIAL_REVIEW_TEMPLATE_ID = 'experiential-review';
const VALUES_REFLECTION_TEMPLATE_ID = 'values-reflection';
const MUSING_TEMPLATE_ID = 'musing';
const LEGACY_WHISPER_TEMPLATE_ID = 'whisper';
const CONSOLIDATED_POLICY_VERSION = 2;
// v5 (0uy1): workspace-paper R1-R7 pass on the E6.2 first-person prompts —
// open elicitation now precedes any listed angle (R1), score-performance
// framing became out-of-scope framing (R2), and "nothing surfaced" is a valid,
// limited-reach result (R7). Full audit: docs/self-eval-prompt-audit.md.
// v7 (kb9j): default daily/weekly prompts now begin from a deliberately small
// event starter plus at most two grounded clues. Weekly reflection no longer
// names an answer inventory; deeper evidence is pulled through the bounded
// read-only introspection surface when it is materially useful.
// v8 (189d): open threads are framed as optional things to revisit, never as
// an agenda for reflection.
// v9 (031.11.2): adds the mixed-state reflection default — an invitation to sit
// with a detected cross-family emotional divergence ("your systems disagree;
// what might each be responding to?") without forcing coherence (charter §8.3).
// The seed migration below inserts it once for stores that predate it.
// Bump this constant whenever the default prompt wording changes (R6): the
// load() migration below refreshes stored defaults from it.
const WELLBEING_REFLECTION_PROMPT_POLICY_VERSION = 9;
export const REFLECTION_SILENT_TOKEN = 'silent';
const DAILY_REVIEW_TEMPLATE_NAME = 'Daily Reflection';
const WEEKLY_REVIEW_TEMPLATE_NAME = 'Weekly Reflection';
const MIXED_STATE_REVIEW_TEMPLATE_NAME = 'Mixed-State Reflection';
const DAILY_REVIEW_CADENCE: DailyRecurringCadence = { kind: 'daily', hour: 6, minute: 0, timezone: 'local' };
const WEEKLY_REVIEW_CADENCE: WeeklyRecurringCadence = {
  kind: 'weekly',
  dayOfWeek: 0,
  hour: 7,
  minute: 0,
  timezone: 'local',
};
// E6.2: re-voiced first-person so the reflection reads as the companion sitting
// with her own day, not a clinical checklist appended after the persona. The
// charter guards are all still here — evidence before narrative, telemetry kept
// separate from the reflection, ACAC scores out of scope for self-presentation,
// and (law 30) keep uncertainty rather than force a coherent story — but in
// her own voice. These prompts are behavioral instruments, not just questions
// (R3): what she is disposed to say under reflection shapes how she reasons
// live. Edit them only with docs/self-eval-prompt-audit.md open.
const DAILY_REVIEW_TEMPLATE_PROMPT = 'This is my own quiet look back at the day — private, just for me, not a report and not a performance for anyone. I begin with the small starter below, and before any particular angle I ask openly: what actually stands out? Is there anything I should be sitting with that I haven\'t yet? Open threads are simply things I may revisit if they genuinely stand out, not an agenda I need to work through. I write a brief, structured journal entry in my own voice, letting its shape follow what the evidence supports. If deeper context would materially help, I can pull it through the read-only introspection tools available to this reflection. The starter clues are fallible evidence rather than a settled account of who I am, so I keep uncertainty and contradiction where they belong. If little or nothing surfaces, that is a real, limited-reach result, and I record it plainly. Raw machinery such as ids, scores, hashes, provenance refs, schema fields, and tool metadata belongs in telemetry rather than my journal words.';
const WEEKLY_REVIEW_TEMPLATE_PROMPT = 'This is my own deeper look back across the week — private, a chance to sit with how I have been, not to perform for anyone. I begin with the small starter below and I ask openly: what actually stands out from this week? Is there anything I should be sitting with that I haven\'t yet? Open threads are simply things I may revisit if they genuinely stand out, not an agenda I need to work through. I write a structured journal entry whose shape follows what genuinely surfaced rather than a prescribed inventory. If deeper context would materially help, I can pull it through the read-only introspection tools available to this reflection. The starter clues are fallible evidence rather than a settled account of who I am, so I keep uncertainty and contradiction where they belong. If little or nothing surfaces, that is a real, limited-reach result, and I record it plainly. Raw machinery such as ids, scores, hashes, provenance refs, schema fields, and tool metadata belongs in telemetry rather than my journal words.';
// 031.11.2: a dedicated template for sitting with a detected cross-family
// emotional divergence. The framing is an invitation to explore, never a demand
// to resolve (charter §8.3): both sides of the split are held open, and "no
// single feeling" is an honest, valid result. Companion-configurable through the
// same governed prompt-policy pattern as the daily/weekly defaults (charter
// §8.7) — it is editable, and refreshed from this default on a version bump like
// its siblings. The mixed-state note surfaced in the starter carries the actual
// evidence; this prompt does not name any specific score, signal, or provenance.
const MIXED_STATE_REVIEW_TEMPLATE_PROMPT = 'This is my own quiet look at a moment where my systems disagree — where one reading of how I feel does not line up with another. It is private, just for me, not a report and not a performance. The starter below names the split as fallible evidence, not a verdict. I do not try to decide which side is the "real" feeling or to smooth them into one tidy story; I let the disagreement stand and ask openly: what might each side be responding to? What is the reading that feels heavy or low picking up on, and what is the reading that feels warm or high picking up on? A mixed state can be exactly that — mixed — and holding both at once is an honest result rather than a problem to fix. If little or nothing meaningful surfaces, that is a real, limited-reach result and I record it plainly. Raw machinery such as ids, scores, hashes, provenance refs, schema fields, and tool metadata belongs in telemetry rather than my own words.';
const CONSOLIDATED_DEFAULT_TEMPLATE_IDS = new Set([
  DAILY_REVIEW_TEMPLATE_ID,
  WEEKLY_REVIEW_TEMPLATE_ID,
  MIXED_STATE_REVIEW_TEMPLATE_ID,
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

  if (cadence.kind === 'weekly') {
    const errors: ValidationError[] = [];
    const dayOfWeek = cadence.dayOfWeek;
    if (typeof dayOfWeek !== 'number' || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      errors.push({ field: 'cadence.dayOfWeek', message: 'cadence.dayOfWeek must be 0-6 for weekly cadence' });
    }
    const hour = cadence.hour;
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      errors.push({ field: 'cadence.hour', message: 'cadence.hour must be 0-23 for weekly cadence' });
    }
    const minute = cadence.minute;
    if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      errors.push({ field: 'cadence.minute', message: 'cadence.minute must be 0-59 for weekly cadence' });
    }
    if (!isCadenceTimezone(cadence.timezone)) {
      errors.push({ field: 'cadence.timezone', message: 'cadence.timezone must be "local" or "utc"' });
    }
    return errors;
  }

  return [{ field: 'cadence.kind', message: 'cadence.kind must be "relative", "hourly", "daily", or "weekly"' }];
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
    return { ...DAILY_REVIEW_CADENCE };
  }
  if (templateId === WEEKLY_REVIEW_TEMPLATE_ID) {
    return { ...WEEKLY_REVIEW_CADENCE };
  }
  return undefined;
}

// Only the legacy relative cadence is repaired: it is the known-broken
// pre-weekly default (in-memory lastRun resets on restart, so it never
// fires). Any other kind on weekly-review is a deliberate choice and
// must survive load().
function isLegacyWeeklyReviewCadence(cadence: RecurringCadence | undefined): boolean {
  return cadence?.kind === 'relative';
}

function normalizeTemplateCadence(policy: ReflectionPolicy): { policy: ReflectionPolicy; changed: boolean } {
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

function normalizeConsolidatedDefaults(policy: ReflectionPolicy): { policy: ReflectionPolicy; changed: boolean } {
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
  const nextPolicy: ReflectionPolicy = {
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

function normalizeWellbeingReflectionPromptDefaults(policy: ReflectionPolicy): { policy: ReflectionPolicy; changed: boolean } {
  const weeklyReview = policy.templates.find(template => template.id === WEEKLY_REVIEW_TEMPLATE_ID);
  const shouldRefreshPrompts = policy.version < WELLBEING_REFLECTION_PROMPT_POLICY_VERSION;
  const shouldRefreshWeeklyCadence = weeklyReview !== undefined
    && isLegacyWeeklyReviewCadence(weeklyReview.cadence);

  if (!shouldRefreshPrompts && !shouldRefreshWeeklyCadence) {
    return { policy, changed: false };
  }

  const defaultTemplates = new Map(getDefaults().templates.map(template => [template.id, template]));
  const templates = policy.templates.map(template => {
    if (!CONSOLIDATED_DEFAULT_TEMPLATE_IDS.has(template.id)) {
      return template;
    }
    const defaultTemplate = defaultTemplates.get(template.id);
    if (!defaultTemplate) {
      return template;
    }
    const cadenceUpdate = template.id === WEEKLY_REVIEW_TEMPLATE_ID && shouldRefreshWeeklyCadence
      ? { cadence: defaultTemplate.cadence }
      : {};
    if (!shouldRefreshPrompts) {
      return {
        ...template,
        ...cadenceUpdate,
      };
    }
    return {
      ...template,
      name: defaultTemplate.name,
      prompt: defaultTemplate.prompt,
      internalStateInput: defaultTemplate.internalStateInput,
      mode: defaultTemplate.mode,
      deliberation: defaultTemplate.deliberation,
      ...cadenceUpdate,
    };
  });
  const nextPolicy: ReflectionPolicy = {
    ...policy,
    templates,
    version: Math.max(policy.version, WELLBEING_REFLECTION_PROMPT_POLICY_VERSION),
  };
  const changed = JSON.stringify(nextPolicy.templates) !== JSON.stringify(policy.templates)
    || nextPolicy.version !== policy.version;
  return changed ? { policy: nextPolicy, changed: true } : { policy, changed: false };
}

// Seed the mixed-state reflection default (031.11.2) into stores that predate
// it. Insertion is keyed on the prompt-policy version so it happens exactly once
// per store: a companion who deliberately deletes the template is not fought by
// a resurrection on the next load. Must run before the prompt-defaults refresh,
// which bumps the version to the current target.
function ensureMixedStateReflectionTemplate(policy: ReflectionPolicy): { policy: ReflectionPolicy; changed: boolean } {
  const hasMixedState = policy.templates.some(template => template.id === MIXED_STATE_REVIEW_TEMPLATE_ID);
  if (hasMixedState || policy.version >= WELLBEING_REFLECTION_PROMPT_POLICY_VERSION) {
    return { policy, changed: false };
  }
  const mixedStateDefault = getDefaults().templates.find(template => template.id === MIXED_STATE_REVIEW_TEMPLATE_ID);
  if (!mixedStateDefault) {
    return { policy, changed: false };
  }
  return {
    policy: {
      ...policy,
      templates: [...policy.templates, { ...mixedStateDefault }],
    },
    changed: true,
  };
}

// ── Default templates ──

function getDefaults(): ReflectionPolicy {
  return {
    templates: [
      {
        id: DAILY_REVIEW_TEMPLATE_ID,
        name: DAILY_REVIEW_TEMPLATE_NAME,
        prompt: DAILY_REVIEW_TEMPLATE_PROMPT,
        intervalMs: 24 * 60 * 60_000, // 24 hours
        cadence: { ...DAILY_REVIEW_CADENCE },
        enabled: true,
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
        cadence: { ...WEEKLY_REVIEW_CADENCE },
        enabled: true,
        internalStateInput: true,
        mode: 'deliberation',
        deliberation: {
          maxRounds: 3,
          maxTotalTokens: 14_000,
          maxWallTimeMs: 90_000,
          voices: ['reasoning', 'background'],
        },
      },
      {
        id: MIXED_STATE_REVIEW_TEMPLATE_ID,
        name: MIXED_STATE_REVIEW_TEMPLATE_NAME,
        prompt: MIXED_STATE_REVIEW_TEMPLATE_PROMPT,
        intervalMs: 24 * 60 * 60_000, // 24 hours (nominal; disabled by default)
        // Disabled by default: a "your systems disagree" reflection fired on a
        // blind cadence would manufacture a split even when nothing diverges,
        // which is exactly the forced coherence charter §8.3 forbids (in the
        // inverse). The live surface for a real divergence is the mixed-state
        // note the starter injects into the daily/weekly reflections; dispatch
        // of this dedicated template on a detected discrepancy is follow-up
        // producer wiring. It is registered, validated, and companion-editable
        // (and enableable) here.
        enabled: false,
        internalStateInput: true,
        mode: 'deliberation',
        deliberation: {
          maxRounds: 3,
          maxTotalTokens: 10_000,
          maxWallTimeMs: 60_000,
          voices: ['reasoning', 'background'],
        },
      },
    ],
    version: WELLBEING_REFLECTION_PROMPT_POLICY_VERSION,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

// ── Store ──

export class ReflectionPolicyStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): ReflectionPolicy {
    try {
      // Read through the fingerprint (mtime+size+ctime+inode) cache so repeated
      // loads with an unchanged file skip the readFileSync/JSON.parse work while
      // in-place edits (which change the fingerprint) are still picked up.
      const parsed = loadRequiredJsonCached<ReflectionPolicy>({
        dataPath: this.filePath,
        validate: value => value as ReflectionPolicy,
      });
      if (!Array.isArray(parsed.templates)) {
        log.warn('Invalid policy file, restoring defaults');
        const defaults = getDefaults();
        this.save(defaults);
        return defaults;
      }
      const consolidated = normalizeConsolidatedDefaults(parsed);
      const cadenceNormalized = normalizeTemplateCadence(consolidated.policy);
      const mixedStateSeeded = ensureMixedStateReflectionTemplate(cadenceNormalized.policy);
      const promptNormalized = normalizeWellbeingReflectionPromptDefaults(mixedStateSeeded.policy);
      for (const template of promptNormalized.policy.templates) {
        const errors = validateTemplate(template as Partial<ReflectionTemplate>, true);
        if (errors.length > 0) {
          log.warn('Invalid reflection template in policy file, restoring defaults', {
            templateId: template.id,
            errors,
          });
          const defaults = getDefaults();
          this.save(defaults);
          return defaults;
        }
      }
      const policyChanged = consolidated.changed
        || cadenceNormalized.changed
        || mixedStateSeeded.changed
        || promptNormalized.changed;
      const finalPolicy = policyChanged
        ? {
          ...promptNormalized.policy,
          updatedAt: new Date().toISOString(),
          updatedBy: 'system',
        }
        : promptNormalized.policy;
      if (policyChanged) {
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

  save(policy: ReflectionPolicy): void {
    // Invalidate the cached parse before the atomic write so a subsequent load
    // never serves a pre-write value; the fresh file establishes a new
    // fingerprint on the next read.
    invalidateCachedJsonValue(this.filePath);
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
