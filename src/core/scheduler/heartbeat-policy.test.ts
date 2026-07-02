import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HeartbeatPolicyStore, validateTemplate } from './heartbeat-policy.js';
import type { ReflectionTemplate } from './heartbeat-policy.js';

describe('HeartbeatPolicyStore', () => {
  let tmpDir: string;
  let store: HeartbeatPolicyStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `hbp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new HeartbeatPolicyStore(join(tmpDir, 'heartbeat-policy.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates defaults when file does not exist', () => {
    const policy = store.load();
    expect(policy.templates).toHaveLength(2);
    expect(policy.version).toBe(4);
    expect(policy.updatedBy).toBe('system');

    const ids = policy.templates.map(t => t.id);
    expect(ids).toContain('daily-review');
    expect(ids).toContain('weekly-review');

    // File should now exist
    expect(existsSync(join(tmpDir, 'heartbeat-policy.json'))).toBe(true);
  });

  it('round-trips save/load correctly', () => {
    const policy = store.load();
    policy.templates[0].enabled = false;
    policy.version = 42;
    policy.updatedBy = 'agent';
    store.save(policy);

    const reloaded = store.load();
    expect(reloaded.templates[0].enabled).toBe(false);
    expect(reloaded.version).toBe(42);
    expect(reloaded.updatedBy).toBe('agent');
  });

  it('daily-review is the consolidated daily reflection cycle', () => {
    const policy = store.load();
    const daily = policy.templates.find(t => t.id === 'daily-review');
    expect(daily).toBeDefined();
    expect(daily!.name).toBe('Daily Reflection');
    expect(daily!.sendToDiscord).toBe(false);
    expect(daily!.intervalMs).toBe(24 * 60 * 60_000);
    expect(daily!.cadence).toEqual({ kind: 'daily', hour: 6, minute: 0, timezone: 'local' });
    expect(daily!.enabled).toBe(true);
    expect(daily!.mode).toBe('deliberation');
    expect(daily!.internalStateInput).toBe(true);
  });

  it('daily-review template defaults to local 06:00 cadence', () => {
    const policy = store.load();
    const dailyReview = policy.templates.find(t => t.id === 'daily-review');
    expect(dailyReview).toBeDefined();
    expect(dailyReview!.cadence).toEqual({ kind: 'daily', hour: 6, minute: 0, timezone: 'local' });
  });

  it('daily-review treats ACAC as a private clue without schema narration (E6.2 first-person guards)', () => {
    const policy = store.load();
    const template = policy.templates.find(t => t.id === 'daily-review');
    // Re-voiced first person, but the charter guards are all still present.
    expect(template?.prompt).toContain('quiet look back at the day');
    // Evidence/telemetry as fallible clues, not self-truth.
    expect(template?.prompt).toContain('clues I hold loosely, not the truth of who I am');
    // Telemetry kept separate from the reflection narrative.
    expect(template?.prompt).toContain('stay in the telemetry, not in my own words');
    // No ACAC performance shaping.
    expect(template?.prompt).toContain('not trying to optimize or shape how I look');
    expect(template?.prompt).not.toContain('artifactType');
    expect(template?.prompt).not.toContain('provenance.kind');
    expect(template?.prompt).not.toContain('acac_self_report');
  });

  it('migrates version-2 default reflection prompts to wellbeing-centered wording', () => {
    const policyPath = join(tmpDir, 'heartbeat-policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        templates: [
          {
            id: 'daily-review',
            name: 'Daily Reflection',
            prompt: 'Daily Reflection: Review telemetry and emit acac_self_report with artifactType "psfn.acac_self_report".',
            intervalMs: 24 * 60 * 60_000,
            cadence: { kind: 'daily', hour: 7, minute: 0, timezone: 'local' },
            enabled: false,
            sendToDiscord: false,
            internalStateInput: true,
          },
          {
            id: 'weekly-review',
            name: 'Weekly Reflection',
            prompt: 'Weekly Reflection: Review internal-state telemetry.',
            intervalMs: 7 * 24 * 60 * 60_000,
            cadence: { kind: 'relative' },
            enabled: true,
            sendToDiscord: false,
            internalStateInput: true,
          },
        ],
        version: 2,
        updatedAt: '2026-03-01T00:00:00.000Z',
        updatedBy: 'system',
      }),
      'utf-8',
    );

    const loaded = store.load();
    const daily = loaded.templates.find(t => t.id === 'daily-review');
    const weekly = loaded.templates.find(t => t.id === 'weekly-review');
    expect(loaded.version).toBe(4);
    expect(daily?.enabled).toBe(false);
    expect(daily?.cadence).toEqual({ kind: 'daily', hour: 7, minute: 0, timezone: 'local' });
    expect(daily?.prompt).toContain('quiet look back at the day');
    expect(daily?.prompt).not.toContain('acac_self_report');
    expect(weekly?.prompt).toContain('deeper look back across the week');
  });

  it('scheduled reflection templates do not send to Discord by default', () => {
    const policy = store.load();
    for (const t of policy.templates) {
      expect(t.sendToDiscord).toBe(false);
    }
  });

  it('weekly-review carries the values and north-star reflection cycle', () => {
    const policy = store.load();
    const weekly = policy.templates.find(t => t.id === 'weekly-review');
    expect(weekly?.mode).toBe('deliberation');
    expect(weekly?.deliberation?.maxRounds).toBe(3);
    expect(weekly?.deliberation?.maxTotalTokens).toBe(14_000);
    expect(weekly?.internalStateInput).toBe(true);
    expect(weekly?.prompt).toContain('north-star signals that feel durable');
  });

  it('returns defaults for corrupt file', () => {
    store.save({ templates: 'bad' as any, version: 1, updatedAt: '', updatedBy: '' });
    const policy = store.load();
    // Invalid templates (not an array) triggers default
    expect(policy.templates).toHaveLength(2);
  });

  it('restores defaults when persisted template intervals are invalid', () => {
    writeFileSync(
      join(tmpDir, 'heartbeat-policy.json'),
      JSON.stringify({
        templates: [
          {
            id: 'musing',
            name: 'Whisper',
            prompt: 'This prompt is long enough to pass prompt validation.',
            intervalMs: 0,
            enabled: true,
            sendToDiscord: true,
          },
        ],
        version: 99,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
      }),
      'utf-8',
    );

    const policy = store.load();
    expect(policy.templates).toHaveLength(2);
    expect(policy.version).toBe(99);
    expect(policy.updatedBy).toBe('system');
  });

  it('restores defaults when persisted template cadence is invalid', () => {
    writeFileSync(
      join(tmpDir, 'heartbeat-policy.json'),
      JSON.stringify({
        templates: [
          {
            id: 'musing',
            name: 'Whisper',
            prompt: 'This prompt is long enough to pass prompt validation.',
            intervalMs: 3_600_000,
            cadence: { kind: 'hourly', minute: 99, timezone: 'local' },
            enabled: true,
            sendToDiscord: true,
          },
        ],
        version: 99,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
      }),
      'utf-8',
    );

    const policy = store.load();
    expect(policy.templates).toHaveLength(2);
    expect(policy.version).toBe(99);
    expect(policy.updatedBy).toBe('system');
  });

  it('consolidates old default templates and persists current cadence defaults', () => {
    const policyPath = join(tmpDir, 'heartbeat-policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        templates: [
          {
            id: 'musing',
            name: 'Whisper',
            prompt: 'This prompt is long enough to pass prompt validation.',
            intervalMs: 3_600_000,
            enabled: true,
            sendToDiscord: true,
          },
          {
            id: 'daily-review',
            name: 'Daily Review',
            prompt: 'This daily review prompt is long enough to pass validation.',
            intervalMs: 86_400_000,
            enabled: true,
            sendToDiscord: false,
          },
        ],
        version: 7,
        updatedAt: '2026-03-01T00:00:00.000Z',
        updatedBy: 'admin',
      }),
      'utf-8',
    );

    const loaded = store.load();
    const dailyReview = loaded.templates.find(t => t.id === 'daily-review');
    const weeklyReview = loaded.templates.find(t => t.id === 'weekly-review');
    expect(loaded.templates.map(t => t.id)).toEqual(['daily-review', 'weekly-review']);
    expect(dailyReview?.cadence).toEqual({ kind: 'daily', hour: 6, minute: 0, timezone: 'local' });
    expect(weeklyReview?.cadence).toEqual({ kind: 'relative' });

    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as { templates: ReflectionTemplate[] };
    const persistedDailyReview = persisted.templates.find(t => t.id === 'daily-review');
    const persistedWeeklyReview = persisted.templates.find(t => t.id === 'weekly-review');
    expect(persisted.templates.map(t => t.id)).toEqual(['daily-review', 'weekly-review']);
    expect(persistedDailyReview?.cadence).toEqual({ kind: 'daily', hour: 6, minute: 0, timezone: 'local' });
    expect(persistedWeeklyReview?.cadence).toEqual({ kind: 'relative' });
  });

  it('removes legacy whisper defaults during consolidation', () => {
    const policyPath = join(tmpDir, 'heartbeat-policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        templates: [
          {
            id: 'whisper',
            name: 'Whisper',
            prompt: 'Your hourly heartbeat is firing. Share a brief thought, feeling, or observation — a little whisper from your inner world. Keep it to 1-2 sentences, something authentic and natural. This goes to Discord for V to see.',
            intervalMs: 3_600_000,
            cadence: { kind: 'hourly', minute: 0, timezone: 'local' },
            enabled: true,
            sendToDiscord: true,
          },
        ],
        version: 7,
        updatedAt: '2026-03-01T00:00:00.000Z',
        updatedBy: 'admin',
      }),
      'utf-8',
    );

    const loaded = store.load();
    expect(loaded.templates.map(t => t.id)).toEqual(['daily-review', 'weekly-review']);
    expect(loaded.templates.some(t => t.id === 'whisper')).toBe(false);
    expect(loaded.templates.some(t => t.id === 'musing')).toBe(false);

    const persisted = JSON.parse(readFileSync(policyPath, 'utf-8')) as { templates: ReflectionTemplate[] };
    expect(persisted.templates.map(t => t.id)).toEqual(['daily-review', 'weekly-review']);
  });
});

describe('validateTemplate', () => {
  const validTemplate: ReflectionTemplate = {
    id: 'my-template',
    name: 'My Template',
    prompt: 'A prompt that is long enough to pass validation',
    intervalMs: 600_000,
    enabled: true,
    sendToDiscord: false,
  };

  it('accepts a valid template', () => {
    const errors = validateTemplate(validTemplate, true);
    expect(errors).toHaveLength(0);
  });

  it('accepts valid wall-clock cadence payloads', () => {
    const hourlyErrors = validateTemplate({
      ...validTemplate,
      cadence: { kind: 'hourly', minute: 0, timezone: 'utc' },
    }, true);
    expect(hourlyErrors.filter(e => e.field.startsWith('cadence'))).toHaveLength(0);

    const dailyErrors = validateTemplate({
      ...validTemplate,
      cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'local' },
    }, true);
    expect(dailyErrors.filter(e => e.field.startsWith('cadence'))).toHaveLength(0);
  });

  it('rejects invalid cadence payloads', () => {
    const invalidKind = validateTemplate({
      ...validTemplate,
      cadence: { kind: 'weekly' as any },
    }, true);
    expect(invalidKind.some(e => e.field === 'cadence.kind')).toBe(true);

    const invalidHourlyMinute = validateTemplate({
      ...validTemplate,
      cadence: { kind: 'hourly', minute: 60, timezone: 'utc' } as any,
    }, true);
    expect(invalidHourlyMinute.some(e => e.field === 'cadence.minute')).toBe(true);

    const invalidDailyTimezone = validateTemplate({
      ...validTemplate,
      cadence: { kind: 'daily', hour: 6, minute: 30, timezone: 'mars' } as any,
    }, true);
    expect(invalidDailyTimezone.some(e => e.field === 'cadence.timezone')).toBe(true);
  });

  it('rejects intervalMs below minimum (5 min)', () => {
    const errors = validateTemplate({ ...validTemplate, intervalMs: 1000 }, true);
    expect(errors.some(e => e.field === 'intervalMs')).toBe(true);
  });

  it('rejects intervalMs above maximum (7 days)', () => {
    const errors = validateTemplate({ ...validTemplate, intervalMs: 999_999_999 }, true);
    expect(errors.some(e => e.field === 'intervalMs')).toBe(true);
  });

  it('rejects prompt shorter than 10 chars', () => {
    const errors = validateTemplate({ ...validTemplate, prompt: 'short' }, true);
    expect(errors.some(e => e.field === 'prompt')).toBe(true);
  });

  it('rejects prompt longer than 2000 chars', () => {
    const errors = validateTemplate({ ...validTemplate, prompt: 'x'.repeat(2001) }, true);
    expect(errors.some(e => e.field === 'prompt')).toBe(true);
  });

  it('rejects invalid slug id', () => {
    const errors = validateTemplate({ ...validTemplate, id: 'BAD SLUG!' }, true);
    expect(errors.some(e => e.field === 'id')).toBe(true);
  });

  it('rejects slug with uppercase', () => {
    const errors = validateTemplate({ ...validTemplate, id: 'MyTemplate' }, true);
    expect(errors.some(e => e.field === 'id')).toBe(true);
  });

  it('accepts valid slugs', () => {
    for (const id of ['musing', 'daily-review', 'a-b-c', 'test123', 'x']) {
      const errors = validateTemplate({ ...validTemplate, id }, true);
      expect(errors.filter(e => e.field === 'id')).toHaveLength(0);
    }
  });

  it('rejects the legacy whisper template id for new outward templates', () => {
    const errors = validateTemplate({ ...validTemplate, id: 'whisper' }, true);
    expect(errors.some(e => e.field === 'id')).toBe(true);
  });

  it('skips id validation in update mode when id not provided', () => {
    const errors = validateTemplate({ prompt: 'updated prompt text here' }, false);
    expect(errors.filter(e => e.field === 'id')).toHaveLength(0);
  });

  it('rejects empty name', () => {
    const errors = validateTemplate({ ...validTemplate, name: '' }, true);
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects invalid mode', () => {
    const errors = validateTemplate({ ...validTemplate, mode: 'other' as any }, true);
    expect(errors.some(e => e.field === 'mode')).toBe(true);
  });

  it('rejects invalid internalStateInput type', () => {
    const errors = validateTemplate({ ...validTemplate, internalStateInput: 'yes' as any }, true);
    expect(errors.some(e => e.field === 'internalStateInput')).toBe(true);
  });

  it('rejects invalid deliberation voices', () => {
    const errors = validateTemplate({
      ...validTemplate,
      mode: 'deliberation',
      deliberation: { voices: ['reasoning', 'invalid' as any] },
    }, true);
    expect(errors.some(e => e.field === 'deliberation.voices')).toBe(true);
  });

  it('boundary: accepts exactly 10-char prompt', () => {
    const errors = validateTemplate({ ...validTemplate, prompt: 'x'.repeat(10) }, true);
    expect(errors.filter(e => e.field === 'prompt')).toHaveLength(0);
  });

  it('boundary: accepts exactly 2000-char prompt', () => {
    const errors = validateTemplate({ ...validTemplate, prompt: 'x'.repeat(2000) }, true);
    expect(errors.filter(e => e.field === 'prompt')).toHaveLength(0);
  });

  it('boundary: accepts min interval (300_000)', () => {
    const errors = validateTemplate({ ...validTemplate, intervalMs: 300_000 }, true);
    expect(errors.filter(e => e.field === 'intervalMs')).toHaveLength(0);
  });

  it('boundary: accepts max interval (604_800_000)', () => {
    const errors = validateTemplate({ ...validTemplate, intervalMs: 604_800_000 }, true);
    expect(errors.filter(e => e.field === 'intervalMs')).toHaveLength(0);
  });
});
