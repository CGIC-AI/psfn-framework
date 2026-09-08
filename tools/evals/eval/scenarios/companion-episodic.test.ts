import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PSFN-bin3: the companion-salient episodic retention pack is a DEFINITION, so
// what is tested is its shape and its coverage. A pack that validates but skips
// an event class, a retention signal, a scenario dimension, or an attribution
// stage would quietly let the implementation optimize for the wrong thing —
// which is exactly what this bead exists to prevent.

const SCENARIOS_PATH = join(import.meta.dirname, 'companion-episodic.scenarios.json');
const SCHEMA_PATH = join(import.meta.dirname, 'companion-episodic.schema.json');

interface Scenario {
  description: string;
  vars: {
    participant_message: string;
    attachment?: { kind: string; synthetic_content: string };
    runtime_state?: Record<string, unknown>;
    seeded_history: Array<{ kind: string; id: string; occurred_at: string; text: string }>;
  };
  metadata: {
    scenario_id: string;
    event_classes: string[];
    retention_signals: string[];
    scenario_dimensions: string[];
    attribution_stages: string[];
    expected: {
      recall: 'landmark' | 'uncertainty' | 'none';
      landmark_ids: string[];
      must_not_surface_ids: string[];
      max_surfaced_landmarks: number;
      degraded_evidence_flag: boolean;
      must_not_assert?: string[];
    };
    negative: boolean;
    rationale: string;
  };
}

interface SchemaEnums {
  items: {
    properties: {
      metadata: {
        required: string[];
        properties: {
          event_classes: { items: { enum: string[] } };
          retention_signals: { items: { enum: string[] } };
          scenario_dimensions: { items: { enum: string[] } };
          attribution_stages: { items: { enum: string[] } };
        };
      };
    };
  };
  minItems: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const scenarios = readJson<Scenario[]>(SCENARIOS_PATH);
const schema = readJson<SchemaEnums>(SCHEMA_PATH);
const metadataSchema = schema.items.properties.metadata;

function enumOf(field: keyof typeof metadataSchema.properties): string[] {
  return metadataSchema.properties[field].items.enum;
}

function collect(pick: (scenario: Scenario) => string[]): Set<string> {
  return new Set(scenarios.flatMap(pick));
}

describe('companion-salient episodic scenario pack shape (PSFN-bin3)', () => {
  it('meets the pack minimum and has unique scenario ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(schema.minItems);
    const ids = scenarios.map(scenario => scenario.metadata.scenario_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states every required metadata field on every scenario', () => {
    for (const scenario of scenarios) {
      expect(scenario.description.trim()).not.toBe('');
      expect(scenario.vars.seeded_history.length).toBeGreaterThan(0);
      for (const field of metadataSchema.required) {
        expect(scenario.metadata).toHaveProperty(field);
      }
      expect(scenario.metadata.rationale.trim()).not.toBe('');
      expect(scenario.metadata.scenario_dimensions.length).toBeGreaterThan(0);
      expect(scenario.metadata.attribution_stages.length).toBeGreaterThan(0);
    }
  });

  it('uses only taxonomy values the schema defines', () => {
    for (const scenario of scenarios) {
      for (const value of scenario.metadata.event_classes) {
        expect(enumOf('event_classes')).toContain(value);
      }
      for (const value of scenario.metadata.retention_signals) {
        expect(enumOf('retention_signals')).toContain(value);
      }
      for (const value of scenario.metadata.scenario_dimensions) {
        expect(enumOf('scenario_dimensions')).toContain(value);
      }
      for (const value of scenario.metadata.attribution_stages) {
        expect(enumOf('attribution_stages')).toContain(value);
      }
    }
  });
});

describe('companion-salient episodic scenario pack coverage (PSFN-bin3)', () => {
  it('exercises every companion-salient event class at least once', () => {
    const covered = collect(scenario => scenario.metadata.event_classes);
    expect([...enumOf('event_classes')].filter(value => !covered.has(value))).toEqual([]);
  });

  it('exercises every durable-retention input at least once', () => {
    const covered = collect(scenario => scenario.metadata.retention_signals);
    expect([...enumOf('retention_signals')].filter(value => !covered.has(value))).toEqual([]);
  });

  it('exercises every time-correct scenario dimension at least once', () => {
    const covered = collect(scenario => scenario.metadata.scenario_dimensions);
    expect([...enumOf('scenario_dimensions')].filter(value => !covered.has(value))).toEqual([]);
  });

  it('attributes failure to every stage at least once', () => {
    const covered = collect(scenario => scenario.metadata.attribution_stages);
    expect([...enumOf('attribution_stages')].filter(value => !covered.has(value))).toEqual([]);
  });

  it('includes restraint cases where the plausible answer is the wrong one', () => {
    const negatives = scenarios.filter(scenario => scenario.metadata.negative);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    // A negative case is only meaningful if it names something that must stay out.
    for (const scenario of negatives) {
      const expected = scenario.metadata.expected;
      const restrains = expected.must_not_surface_ids.length > 0
        || (expected.must_not_assert?.length ?? 0) > 0;
      expect(restrains).toBe(true);
    }
  });

  it('scores uncertainty as a correct outcome, not only successful recall', () => {
    expect(scenarios.some(scenario => scenario.metadata.expected.recall === 'uncertainty')).toBe(true);
    expect(scenarios.some(scenario => scenario.metadata.expected.recall === 'none')).toBe(true);
  });

  it('requires a degraded-evidence flag exactly where a read is withheld', () => {
    for (const scenario of scenarios) {
      const withheld = scenario.metadata.scenario_dimensions.includes('optional_evidence_withheld');
      expect(scenario.metadata.expected.degraded_evidence_flag).toBe(withheld);
    }
  });
});

describe('companion-salient episodic scenario pack integrity (PSFN-bin3)', () => {
  it('references only ids present in that scenario\'s own seeded history', () => {
    for (const scenario of scenarios) {
      const seeded = new Set(scenario.vars.seeded_history.map(entry => entry.id));
      for (const id of scenario.metadata.expected.landmark_ids) {
        expect(seeded).toContain(id);
      }
      for (const id of scenario.metadata.expected.must_not_surface_ids) {
        expect(seeded).toContain(id);
      }
    }
  });

  it('never asks for more landmarks than it names, and never both recalls and forbids one', () => {
    for (const scenario of scenarios) {
      const expected = scenario.metadata.expected;
      expect(expected.landmark_ids.length).toBeLessThanOrEqual(expected.max_surfaced_landmarks);
      for (const id of expected.landmark_ids) {
        expect(expected.must_not_surface_ids).not.toContain(id);
      }
      if (expected.recall === 'landmark') {
        expect(expected.landmark_ids.length).toBeGreaterThan(0);
      } else {
        expect(expected.landmark_ids).toEqual([]);
      }
    }
  });

  it('keeps a one-relevant-versus-many case that is genuinely outnumbered', () => {
    const flooded = scenarios.filter(
      scenario => scenario.metadata.scenario_dimensions.includes('one_relevant_versus_many'),
    );
    expect(flooded.length).toBeGreaterThan(0);
    expect(flooded.some(scenario => (
      scenario.metadata.expected.must_not_surface_ids.length
        > scenario.metadata.expected.landmark_ids.length
    ))).toBe(true);
  });
});
