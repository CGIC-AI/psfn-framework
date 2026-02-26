// ── Heartbeat Policy ──
// Policy-driven multi-template reflection system.
// Stores reflection templates (prompts, intervals, flags) in a JSON file.
// Purrsephone can read, edit, and extend her own reflection schedule.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('HeartbeatPolicy');

// ── Types ──

export interface ReflectionTemplate {
  id: string;           // slug, e.g. 'whisper', 'daily-review'
  name: string;         // display name
  prompt: string;       // text sent to agentLoop.handleMessage
  intervalMs: number;   // how often (validated: 5min – 7d)
  enabled: boolean;
  sendToDiscord: boolean;  // if true, sends response via sender.send()
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
        log.warn('Invalid policy file, returning defaults');
        return getDefaults();
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(policy, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, this.filePath);
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
