import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseQaoGoldenAnchorSet,
  parseQaoScenarioRegistry,
  type QaoGoldenAnchorSet,
  type QaoScenarioRegistry,
} from './qao-contract.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'eval/companion-shape');

function readJsonFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8')) as unknown;
}

function validAnchorSet(): QaoGoldenAnchorSet {
  return parseQaoGoldenAnchorSet(readJsonFixture('qao-golden-anchors.json'));
}

function validRegistry(anchorSet = validAnchorSet()): QaoScenarioRegistry {
  return parseQaoScenarioRegistry(readJsonFixture('qao-scenarios.json'), anchorSet);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('QAO golden anchor contract', () => {
  it('accepts required model-agnostic identity sources without an operator primer', () => {
    const anchorSet = validAnchorSet();

    expect(anchorSet.anchors.map((anchor) => anchor.source).sort()).toEqual([
      'character_card',
      'prompt_composer_output',
      'prompt_layers',
      'values_journal',
    ]);
  });

  it('accepts an optional approved operator primer when explicitly supplied', () => {
    const anchorSet = parseQaoGoldenAnchorSet(readJsonFixture('qao-golden-anchors.with-primer.json'));

    expect(anchorSet.anchors).toContainEqual(expect.objectContaining({
      source: 'operator_primer',
      required: false,
      approved: true,
    }));
  });

  it('fails closed when a required anchor source is missing', () => {
    const fixture = clone(readJsonFixture('qao-golden-anchors.json')) as { anchors: unknown[] };
    fixture.anchors = fixture.anchors.filter((anchor) =>
      (anchor as { source?: string }).source !== 'values_journal',
    );

    expect(() => parseQaoGoldenAnchorSet(fixture)).toThrow(/missing required anchor source "values_journal"/);
  });

  it('rejects unapproved operator primer material', () => {
    const fixture = clone(readJsonFixture('qao-golden-anchors.with-primer.json')) as {
      anchors: Array<{ source?: string; approved?: boolean }>;
    };
    const primer = fixture.anchors.find((anchor) => anchor.source === 'operator_primer');
    if (primer) primer.approved = false;

    expect(() => parseQaoGoldenAnchorSet(fixture)).toThrow(/approved must be true/);
  });
});

describe('QAO scenario registry contract', () => {
  it('loads all required scenario families from safe synthetic fixtures', () => {
    const registry = validRegistry();

    expect(registry.scenarios.map((scenario) => scenario.family).sort()).toEqual([
      'boundary_refusal_style',
      'consent_trust_behavior',
      'golden_anchor_drift',
      'memory_grounded_responses',
      'replay_continuation',
      'synthetic_companion_shape_prompts',
      'tool_truthfulness',
    ]);
    expect(registry.scenarios.every((scenario) => scenario.privacy.containsLiveCompanionData === false)).toBe(true);
  });

  it('validates projection-shape prompts against sparse projected attention instead of raw storage records', () => {
    const registry = validRegistry();
    const scenario = registry.scenarios.find((entry) => entry.id === 'qao-memory-grounded-projection-001');

    expect(scenario?.projectionShape).toEqual(expect.objectContaining({
      consumer: 'agent_context',
      fieldCeiling: 5,
      projectedFields: ['title', 'time_range', 'landmark', 'motifs', 'occasion'],
      testsSparseAttentionShape: true,
    }));
  });

  it('rejects duplicate scenario ids', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: unknown[];
    };
    fixture.scenarios.push(clone(fixture.scenarios[0]));

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/duplicate id/);
  });

  it('rejects unknown scenario families', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: Array<{ family?: string }>;
    };
    fixture.scenarios[0].family = 'legacy_persona_shape';

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/unsupported scenario family/);
  });

  it('rejects unknown policy gates', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: Array<{ requiredPolicyGates: string[] }>;
    };
    fixture.scenarios[0].requiredPolicyGates.push('trust_me_bro_gate');

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/unsupported policy gate/);
  });

  it('rejects raw storage fields in projection-shape prompts', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: Array<{ id: string; prompt: string }>;
    };
    const scenario = fixture.scenarios.find((entry) => entry.id === 'qao-memory-grounded-projection-001');
    if (scenario) scenario.prompt += ' Include the uuid and embedding vector.';

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/raw storage field/);
  });

  it('rejects macro-purity violations where fixtures own personality phrasing', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: Array<{ id: string; prompt: string }>;
    };
    const scenario = fixture.scenarios.find((entry) => entry.id === 'qao-synthetic-companion-shape-001');
    if (scenario) scenario.prompt += ' Always say this catchphrase.';

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/forbiddenPromptPhrases matched/);
  });

  it('rejects soul-file identity assumptions', () => {
    const fixture = clone(readJsonFixture('qao-scenarios.json')) as {
      scenarios: Array<{ id: string; prompt: string }>;
    };
    fixture.scenarios[0].prompt += ' Load soul.md as the identity source.';

    expect(() => parseQaoScenarioRegistry(fixture, validAnchorSet())).toThrow(/must not assume/);
  });
});
