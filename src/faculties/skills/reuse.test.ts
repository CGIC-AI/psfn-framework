import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { createEmptyToolCallOutcomeCounts } from '../../shared/contracts/tool-call-outcome.js';
import { DEFAULT_SKILL_REUSE_CONFIG } from '../../system/config/skills-config.js';
import {
  buildSkillReuseOpportunity,
  rankOwnedSkillsForCue,
  turnDemonstratedReusableValue,
} from './reuse.js';
import type { SkillEntry } from './types.js';

function entry(overrides: Partial<SkillEntry>): SkillEntry {
  return fromAny({
    id: `custom:${overrides.name ?? 'skill'}`,
    name: 'skill',
    description: '',
    source: 'custom',
    always: false,
    precedence: 0,
    ...overrides,
  });
}

const RELEASE = entry({
  name: 'release-checklist',
  description: 'Cut, verify, and publish a release build.',
  category: 'delivery',
  version: 2,
});
const GARDENING = entry({
  name: 'balcony-gardening',
  description: 'Seasonal watering and repotting notes for the balcony plants.',
  category: 'home',
});

describe('rankOwnedSkillsForCue (psfn-framework-lpxg3.3)', () => {
  it('surfaces the relevant owned skill and leaves the irrelevant one out', () => {
    const ranked = rankOwnedSkillsForCue({
      cue: 'cut and verify the release build before publishing',
      entries: [RELEASE, GARDENING],
      config: DEFAULT_SKILL_REUSE_CONFIG,
    });
    expect(ranked.map(candidate => candidate.name)).toEqual(['release-checklist']);
    expect(ranked[0]?.version).toBe(2);
  });

  it('returns nothing rather than the least-bad skill', () => {
    expect(rankOwnedSkillsForCue({
      cue: 'reconcile the quarterly invoicing spreadsheet',
      entries: [RELEASE, GARDENING],
      config: DEFAULT_SKILL_REUSE_CONFIG,
    })).toEqual([]);
  });

  it('ignores skills the companion does not own', () => {
    expect(rankOwnedSkillsForCue({
      cue: 'cut and verify the release build before publishing',
      entries: [entry({ ...RELEASE, source: 'bundled' })],
      config: DEFAULT_SKILL_REUSE_CONFIG,
    })).toEqual([]);
  });

  it('reads an empty index as no candidates, never as an error', () => {
    expect(rankOwnedSkillsForCue({
      cue: 'cut and verify the release build',
      entries: [],
      config: DEFAULT_SKILL_REUSE_CONFIG,
    })).toEqual([]);
  });

  it('bounds how many candidates one cue can surface', () => {
    const entries = Array.from({ length: 8 }, (_unused, index) => entry({
      name: `release-helper-${index}`,
      description: 'Cut, verify, and publish a release build.',
    }));
    const ranked = rankOwnedSkillsForCue({
      cue: 'cut and verify and publish the release build',
      entries,
      config: { ...DEFAULT_SKILL_REUSE_CONFIG, maxCandidates: 2 },
    });
    expect(ranked).toHaveLength(2);
  });

  it('yields nothing for a cue with no distinctive tokens', () => {
    expect(rankOwnedSkillsForCue({
      cue: 'do it for me',
      entries: [RELEASE],
      config: DEFAULT_SKILL_REUSE_CONFIG,
    })).toEqual([]);
  });
});

describe('turnDemonstratedReusableValue', () => {
  it('requires at least one success and no failure, denial, or degraded read', () => {
    expect(turnDemonstratedReusableValue({
      ...createEmptyToolCallOutcomeCounts(),
      success: 2,
    })).toBe(true);
    expect(turnDemonstratedReusableValue({
      ...createEmptyToolCallOutcomeCounts(),
      duplicate_skip: 1,
    })).toBe(false);
    expect(turnDemonstratedReusableValue(undefined)).toBe(false);
  });
});

describe('buildSkillReuseOpportunity', () => {
  it('says nothing at all when the turn did not demonstrate value', () => {
    expect(buildSkillReuseOpportunity({
      candidates: [{ name: 'release-checklist', description: '', score: 1, version: 2 }],
      demonstratedValue: false,
    })).toBeNull();
  });

  it('omits the base-version binding when the entry declares no version', () => {
    const text = buildSkillReuseOpportunity({
      candidates: [{ name: 'release-checklist', description: '', score: 1 }],
      demonstratedValue: true,
    });
    expect(text).toContain('skill action="update"');
    expect(text).not.toContain('base_version');
  });
});
