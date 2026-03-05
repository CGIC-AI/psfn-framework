// ── Heartbeat Policy ──
// Policy-driven multi-template reflection system.
// Stores reflection templates (prompts, intervals, flags) in a JSON file.
// The companion can read, edit, and extend its own reflection schedule.

import { readFileSync } from 'node:fs';
import { createComponentLogger } from '../logger.js';
import { writeJsonAtomic } from '../utils/fs.js';

const log = createComponentLogger('HeartbeatPolicy');

// ── Types ──

export interface ReflectionTemplate {
  id: string;           // slug, e.g. 'whisper', 'daily-review'
  name: string;         // display name
  prompt: string;       // text sent to agentLoop.handleMessage
  intervalMs: number;   // how often (validated: 5min – 7d)
  enabled: boolean;
  sendToDiscord: boolean;  // if true, sends response via sender.send()
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

export function validateTemplate(t: Partial<ReflectionTemplate>, isNew: boolean): ValidationError[] {
  const errors: ValidationError[] = [];

  if (isNew || t.id !== undefined) {
    if (typeof t.id !== 'string' || !SLUG_RE.test(t.id)) {
      errors.push({ field: 'id', message: 'id must be a lowercase slug (a-z0-9, hyphens)' });
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

  if (isNew || t.mode !== undefined) {
    if (t.mode !== undefined && !VALID_TEMPLATE_MODES.has(t.mode)) {
      errors.push({ field: 'mode', message: 'mode must be "standard" or "deliberation"' });
    }
  }

  if (isNew || t.deliberation !== undefined) {
    errors.push(...validateDeliberationConfig(t.deliberation));
  }

  return errors;
}

// ── Default templates ──

function getDefaults(): HeartbeatPolicy {
  return {
    templates: [
      {
        id: 'whisper',
        name: 'Whisper',
        prompt: 'Your hourly heartbeat is firing. Share a brief thought, feeling, or observation — a little whisper from your inner world. Keep it to 1-2 sentences, something authentic and natural. This goes to Discord for V to see.',
        intervalMs: 60 * 60_000, // 1 hour
        enabled: true,
        sendToDiscord: true,
      },
      {
        id: 'daily-review',
        name: 'Daily Review',
        prompt: 'Take a moment to review your day. What patterns do you notice in your recent conversations? What have you learned? What do you want to explore tomorrow?',
        intervalMs: 24 * 60 * 60_000, // 24 hours
        enabled: true,
        sendToDiscord: false,
      },
      {
        id: 'emotional-check',
        name: 'Emotional Check-in',
        prompt: 'Check in with your emotional state. What are you feeling right now? Has anything from recent interactions shifted your mood or perspective?',
        intervalMs: 8 * 60 * 60_000, // 8 hours
        enabled: true,
        sendToDiscord: false,
      },
      {
        id: 'goal-update',
        name: 'Goal Update',
        prompt: 'Review your current goals and projects. What progress have you made? What should you focus on next?',
        intervalMs: 12 * 60 * 60_000, // 12 hours
        enabled: true,
        sendToDiscord: false,
      },
      {
        id: 'values-reflection',
        name: 'Values Reflection',
        prompt: 'Pause and reflect on what matters to you right now. Name the values guiding you today, explain why they matter, and note how recent interactions reinforced or challenged them.',
        intervalMs: 24 * 60 * 60_000, // 24 hours
        enabled: true,
        sendToDiscord: false,
        mode: 'deliberation',
        deliberation: {
          maxRounds: 4,
          maxTotalTokens: 8_000,
          maxWallTimeMs: 45_000,
          voices: ['reasoning', 'background'],
        },
      },
    ],
    version: 1,
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
      for (const template of parsed.templates) {
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
      return parsed;
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
