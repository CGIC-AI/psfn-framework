// ── Source-list matching + tier adjustment tests (htm9.13) ──

import { describe, expect, it } from 'vitest';
import type { IntakeSourceListsConfig } from '../../../system/config/intake-policy-config.js';
import {
  adjustSourceRiskTierForSourceLists,
  extractHostFromOriginRef,
  intakeSitePatternMatchesHost,
  matchIntakeSourceLists,
} from './source-lists.js';

function lists(partial: Partial<IntakeSourceListsConfig> = {}): IntakeSourceListsConfig {
  return {
    trustedSites: [],
    deniedSites: [],
    trustedPeople: [],
    deniedPeople: [],
    ...partial,
  };
}

function entry(pattern: string) {
  return { pattern, addedBy: 'test', addedAt: 1_700_000_000_000 };
}

describe('extractHostFromOriginRef', () => {
  it('extracts lowercase hosts from http(s) URLs only', () => {
    expect(extractHostFromOriginRef('https://ArXiv.org/abs/2403.14720')).toBe('arxiv.org');
    expect(extractHostFromOriginRef('http://sub.example.test:8080/path?q=1')).toBe('sub.example.test');
    expect(extractHostFromOriginRef('https://example.test./page')).toBe('example.test');
  });

  it('returns null for non-URL origin refs', () => {
    expect(extractHostFromOriginRef('tool:web.fetch:call-1')).toBeNull();
    expect(extractHostFromOriginRef('discord:123:456')).toBeNull();
    expect(extractHostFromOriginRef('ftp://example.test/file')).toBeNull();
    expect(extractHostFromOriginRef('')).toBeNull();
  });
});

describe('intakeSitePatternMatchesHost', () => {
  it('matches exact hosts exactly', () => {
    expect(intakeSitePatternMatchesHost('arxiv.org', 'arxiv.org')).toBe(true);
    expect(intakeSitePatternMatchesHost('arxiv.org', 'export.arxiv.org')).toBe(false);
    expect(intakeSitePatternMatchesHost('arxiv.org', 'notarxiv.org')).toBe(false);
  });

  it('matches *.suffix patterns against the apex and every subdomain', () => {
    expect(intakeSitePatternMatchesHost('*.arxiv.org', 'arxiv.org')).toBe(true);
    expect(intakeSitePatternMatchesHost('*.arxiv.org', 'export.arxiv.org')).toBe(true);
    expect(intakeSitePatternMatchesHost('*.arxiv.org', 'a.b.arxiv.org')).toBe(true);
    // Suffix must be on a label boundary — no substring tricks.
    expect(intakeSitePatternMatchesHost('*.arxiv.org', 'evilarxiv.org')).toBe(false);
    expect(intakeSitePatternMatchesHost('*.arxiv.org', 'arxiv.org.evil.test')).toBe(false);
  });
});

describe('matchIntakeSourceLists', () => {
  const config = lists({
    trustedSites: [entry('*.arxiv.org')],
    deniedSites: [entry('malware.example')],
    trustedPeople: [entry('contact:alice')],
    deniedPeople: [entry('contact:mallory')],
  });

  it('matches trusted sites by host', () => {
    const match = matchIntakeSourceLists({
      lists: config,
      originRef: 'https://export.arxiv.org/abs/1234',
    });
    expect(match).toEqual({
      kind: 'trusted',
      list: 'trustedSites',
      pattern: '*.arxiv.org',
      subject: 'export.arxiv.org',
    });
  });

  it('matches people by canonical contact id', () => {
    const match = matchIntakeSourceLists({
      lists: config,
      originRef: 'discord:123:456',
      canonicalContactId: 'contact:alice',
    });
    expect(match?.kind).toBe('trusted');
    expect(match?.list).toBe('trustedPeople');
  });

  it('lets a denied hit win over a trusted hit (fail closed)', () => {
    const match = matchIntakeSourceLists({
      lists: config,
      originRef: 'https://arxiv.org/abs/1',
      canonicalContactId: 'contact:mallory',
    });
    expect(match?.kind).toBe('denied');
    expect(match?.list).toBe('deniedPeople');
  });

  it('returns null with no hit and never site-matches non-URL refs', () => {
    expect(matchIntakeSourceLists({ lists: config, originRef: 'https://other.test/x' })).toBeNull();
    expect(matchIntakeSourceLists({ lists: config, originRef: 'tool:arxiv.org' })).toBeNull();
  });
});

describe('adjustSourceRiskTierForSourceLists', () => {
  const trustedMatch = {
    kind: 'trusted' as const,
    list: 'trustedSites' as const,
    pattern: '*.arxiv.org',
    subject: 'arxiv.org',
  };
  const deniedMatch = {
    kind: 'denied' as const,
    list: 'deniedSites' as const,
    pattern: 'malware.example',
    subject: 'malware.example',
  };

  it('lowers exactly one step on a trusted hit', () => {
    expect(adjustSourceRiskTierForSourceLists('hostile', trustedMatch).tier).toBe('untrusted');
    expect(adjustSourceRiskTierForSourceLists('untrusted', trustedMatch).tier).toBe('standard');
    expect(adjustSourceRiskTierForSourceLists('standard', trustedMatch).tier).toBe('trusted');
  });

  it('never lowers below trusted', () => {
    const adjusted = adjustSourceRiskTierForSourceLists('trusted', trustedMatch);
    expect(adjusted.tier).toBe('trusted');
    expect(adjusted.adjustment).toBeUndefined();
  });

  it('raises to hostile on a denied hit', () => {
    for (const base of ['trusted', 'standard', 'untrusted'] as const) {
      const adjusted = adjustSourceRiskTierForSourceLists(base, deniedMatch);
      expect(adjusted.tier).toBe('hostile');
      expect(adjusted.adjustment?.kind).toBe('raised_to_hostile');
    }
    expect(adjustSourceRiskTierForSourceLists('hostile', deniedMatch).adjustment).toBeUndefined();
  });

  it('is a no-op without a match', () => {
    const adjusted = adjustSourceRiskTierForSourceLists('untrusted', null);
    expect(adjusted).toEqual({ tier: 'untrusted' });
  });
});
