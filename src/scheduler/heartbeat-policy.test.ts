import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
    expect(policy.templates).toHaveLength(5);
    expect(policy.version).toBe(1);
    expect(policy.updatedBy).toBe('system');

    const ids = policy.templates.map(t => t.id);
    expect(ids).toContain('whisper');
    expect(ids).toContain('daily-review');
    expect(ids).toContain('emotional-check');
    expect(ids).toContain('goal-update');
    expect(ids).toContain('values-reflection');

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

  it('whisper template sends to Discord', () => {
    const policy = store.load();
    const whisper = policy.templates.find(t => t.id === 'whisper');
    expect(whisper).toBeDefined();
    expect(whisper!.sendToDiscord).toBe(true);
    expect(whisper!.intervalMs).toBe(3_600_000); // 1 hour
    expect(whisper!.enabled).toBe(true);
  });

  it('non-whisper templates do not send to Discord', () => {
    const policy = store.load();
    const nonWhispers = policy.templates.filter(t => t.id !== 'whisper');
    expect(nonWhispers.length).toBe(4);
    for (const t of nonWhispers) {
      expect(t.sendToDiscord).toBe(false);
    }
  });

  it('values-reflection defaults to deliberation mode', () => {
    const policy = store.load();
    const values = policy.templates.find(t => t.id === 'values-reflection');
    expect(values?.mode).toBe('deliberation');
    expect(values?.deliberation?.maxRounds).toBe(4);
  });

  it('returns defaults for corrupt file', () => {
    store.save({ templates: 'bad' as any, version: 1, updatedAt: '', updatedBy: '' });
    const policy = store.load();
    // Invalid templates (not an array) triggers default
    expect(policy.templates).toHaveLength(5);
  });

  it('restores defaults when persisted template intervals are invalid', () => {
    writeFileSync(
      join(tmpDir, 'heartbeat-policy.json'),
      JSON.stringify({
        templates: [
          {
            id: 'whisper',
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
    expect(policy.templates).toHaveLength(5);
    expect(policy.version).toBe(1);
    expect(policy.updatedBy).toBe('system');
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
    for (const id of ['whisper', 'daily-review', 'a-b-c', 'test123', 'x']) {
      const errors = validateTemplate({ ...validTemplate, id }, true);
      expect(errors.filter(e => e.field === 'id')).toHaveLength(0);
    }
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
