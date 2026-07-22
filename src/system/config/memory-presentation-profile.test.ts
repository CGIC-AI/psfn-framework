import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MEMORY_PRESENTATION_SECTIONS,
  PRESENTATION_PROFILE_VERSION,
  cloneMemoryPresentationProfile,
  createDefaultMemoryPresentationProfile,
  formatRecencyLabelTemplate,
  normalizeMemoryPresentationProfile,
  resolveMemoryPresentationProfile,
} from './memory-presentation-profile.js';

function defaultRecord(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(createDefaultMemoryPresentationProfile())) as Record<string, unknown>;
}

describe('memory presentation profile defaults', () => {
  it('pins the default section order and version', () => {
    const profile = createDefaultMemoryPresentationProfile();
    expect(profile.version).toBe(PRESENTATION_PROFILE_VERSION);
    expect(profile.sectionOrder).toEqual([...MEMORY_PRESENTATION_SECTIONS]);
    expect(profile.episodeCap).toBe(5);
    expect(profile.displayCaps).toEqual({ emotional: null, procedural: null });
    expect(profile.valence.positiveThreshold).toBe(0.3);
    expect(profile.valence.negativeThreshold).toBe(-0.3);
    expect(profile.valence.positiveMarker).toBe(' (+)');
    expect(profile.valence.continuityPositiveThreshold).toBe(0.25);
  });

  it('resolve returns the default when undefined', () => {
    expect(resolveMemoryPresentationProfile(undefined)).toEqual(
      createDefaultMemoryPresentationProfile(),
    );
  });

  it('clone is a deep, independent copy', () => {
    const profile = createDefaultMemoryPresentationProfile();
    const clone = cloneMemoryPresentationProfile(profile);
    clone.sectionOrder.reverse();
    clone.headings.relevant = 'changed';
    expect(profile.sectionOrder).toEqual([...MEMORY_PRESENTATION_SECTIONS]);
    expect(profile.headings.relevant).toBe('Relevant memories for this person:');
  });

  it('the canonical seed profile normalizes to the built-in default', () => {
    const seed = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8')) as {
      memoryPresentationProfile?: unknown;
    };
    expect(seed.memoryPresentationProfile).toBeDefined();
    expect(normalizeMemoryPresentationProfile(seed.memoryPresentationProfile)).toEqual(
      createDefaultMemoryPresentationProfile(),
    );
  });
});

describe('memory presentation profile normalization (fail closed)', () => {
  it('accepts the default record and round-trips it', () => {
    expect(normalizeMemoryPresentationProfile(defaultRecord())).toEqual(
      createDefaultMemoryPresentationProfile(),
    );
  });

  it('rejects a non-object', () => {
    expect(() => normalizeMemoryPresentationProfile(null)).toThrow(/expected object/);
    expect(() => normalizeMemoryPresentationProfile('nope')).toThrow(/expected object/);
  });

  it('rejects an unknown top-level key', () => {
    const record = defaultRecord();
    record.extra = true;
    expect(() => normalizeMemoryPresentationProfile(record)).toThrow(/unknown extra/);
  });

  it('rejects a missing top-level key', () => {
    const record = defaultRecord();
    delete record.headings;
    expect(() => normalizeMemoryPresentationProfile(record)).toThrow(/missing headings/);
  });

  it('rejects a version mismatch', () => {
    const record = defaultRecord();
    record.version = 999;
    expect(() => normalizeMemoryPresentationProfile(record)).toThrow(/version/);
  });

  it('rejects a sectionOrder that is not an exact permutation', () => {
    const dup = defaultRecord();
    dup.sectionOrder = [...MEMORY_PRESENTATION_SECTIONS, 'core_profile'];
    expect(() => normalizeMemoryPresentationProfile(dup)).toThrow(/duplicate|unknown/);

    const missing = defaultRecord();
    missing.sectionOrder = MEMORY_PRESENTATION_SECTIONS.slice(1);
    expect(() => normalizeMemoryPresentationProfile(missing)).toThrow(/missing sections/);

    const unknown = defaultRecord();
    unknown.sectionOrder = ['core_profile', 'relationship_context', 'emotional_continuity_snapshot',
      'cross_session_emotional_continuity', 'memory_context_note', 'episodic_landmark_chains', 'bogus'];
    expect(() => normalizeMemoryPresentationProfile(unknown)).toThrow(/unknown section/);
  });

  it('rejects an out-of-range valence threshold', () => {
    const record = defaultRecord();
    (record.valence as Record<string, unknown>).positiveThreshold = 2;
    expect(() => normalizeMemoryPresentationProfile(record)).toThrow(/positiveThreshold/);
  });

  it('rejects a non-integer episode cap and an out-of-range cap', () => {
    const frac = defaultRecord();
    frac.episodeCap = 2.5;
    expect(() => normalizeMemoryPresentationProfile(frac)).toThrow(/episodeCap/);

    const zero = defaultRecord();
    zero.episodeCap = 0;
    expect(() => normalizeMemoryPresentationProfile(zero)).toThrow(/episodeCap/);
  });

  it('accepts null display caps but rejects a non-integer cap', () => {
    const ok = defaultRecord();
    (ok.displayCaps as Record<string, unknown>).emotional = 3;
    expect(normalizeMemoryPresentationProfile(ok).displayCaps.emotional).toBe(3);

    const bad = defaultRecord();
    (bad.displayCaps as Record<string, unknown>).procedural = 1.5;
    expect(() => normalizeMemoryPresentationProfile(bad)).toThrow(/procedural/);
  });

  it('accepts a withheld-wording override string but rejects a wrong type', () => {
    const ok = defaultRecord();
    (ok.withheldWording as Record<string, unknown>).header = 'Held back:';
    expect(normalizeMemoryPresentationProfile(ok).withheldWording.header).toBe('Held back:');

    const bad = defaultRecord();
    (bad.withheldWording as Record<string, unknown>).header = 42;
    expect(() => normalizeMemoryPresentationProfile(bad)).toThrow(/header/);
  });

  it('rejects an empty heading', () => {
    const record = defaultRecord();
    (record.headings as Record<string, unknown>).relevant = '';
    expect(() => normalizeMemoryPresentationProfile(record)).toThrow(/relevant/);
  });
});

describe('formatRecencyLabelTemplate', () => {
  it('substitutes {n} with the count', () => {
    expect(formatRecencyLabelTemplate('{n} weeks ago', 3)).toBe('3 weeks ago');
    expect(formatRecencyLabelTemplate('{n} week ago', 1)).toBe('1 week ago');
    expect(formatRecencyLabelTemplate('a while back', 9)).toBe('a while back');
  });
});
