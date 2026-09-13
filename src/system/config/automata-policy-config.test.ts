import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import {
  loadAutomataPolicyConfig,
  loadAutomataPolicySeedDefaults,
  saveAutomataPolicyConfig,
} from './automata-policy-config.js';
import { saveModelsConfig } from './models-config.js';

describe('Automata reviewer model owner reference', () => {
  let root: string;
  let registry: CanonicalModelRegistry;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psfn-reviewer-model-'));
    registry = JSON.parse(readFileSync(new URL('../../../config/models.seed.json', import.meta.url), 'utf8'));
    writeFileSync(join(root, 'models.json'), JSON.stringify(registry));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function policy(enabled = true, model = 'extraction') {
    const value = loadAutomataPolicySeedDefaults();
    value.bus.reviewer = { ...value.bus.reviewer, enabled, model };
    return value;
  }

  it.each(['missing', 'disabled'] as const)('rejects an enabled reviewer with a %s slot at load and before save', (state) => {
    const model = state === 'missing' ? 'missing-reviewer-slot' : 'gpt-5.4-nano';
    if (state === 'disabled') {
      registry.models = registry.models.map(entry => entry.id === model ? { ...entry, enabled: false } : entry);
      writeFileSync(join(root, 'models.json'), JSON.stringify(registry));
    }
    const next = policy(true, model);
    const previous = JSON.stringify(next);
    writeFileSync(join(root, 'automata-policy.json'), previous);
    expect(() => loadAutomataPolicyConfig(root)).toThrow(/automata-policy\.json\.bus\.reviewer\.model.*not an enabled models\.json/s);
    expect(() => saveAutomataPolicyConfig(root, next)).toThrow(/automata-policy\.json\.bus\.reviewer\.model.*not an enabled models\.json/s);
    expect(readFileSync(join(root, 'automata-policy.json'), 'utf8')).toBe(previous);
  });

  it('accepts enabled existing slots and disabled reviewers without the referenced slot', () => {
    expect(saveAutomataPolicyConfig(root, policy()).bus.reviewer.model).toBe('extraction');
    expect(loadAutomataPolicyConfig(root).bus.reviewer.model).toBe('extraction');
    expect(saveAutomataPolicyConfig(root, policy(false, 'omitted-model')).bus.reviewer.enabled).toBe(false);
    expect(loadAutomataPolicyConfig(root).bus.reviewer.model).toBe('omitted-model');
  });

  it('rejects a models update that strands an enabled reviewer before changing models.json', () => {
    const selected = registry.models.find(entry => entry.id === 'gpt-5.4-nano')!;
    const next = policy(true, selected.id);
    writeFileSync(join(root, 'automata-policy.json'), JSON.stringify(next));
    const before = readFileSync(join(root, 'models.json'), 'utf8');
    registry.models = registry.models.filter(entry => entry.id !== selected.id);
    expect(() => saveModelsConfig(root, registry)).toThrow(/automata-policy\.json\.bus\.reviewer\.model/);
    expect(readFileSync(join(root, 'models.json'), 'utf8')).toBe(before);
    saveAutomataPolicyConfig(root, policy(false, selected.id));
    expect(() => saveModelsConfig(root, registry)).not.toThrow();
  });
});
