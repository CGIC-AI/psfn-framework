import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetActiveTimezone,
  setActiveTimezone,
} from '../../../shared/time/active-timezone.js';
import type { PurrMemory } from '../types.js';
import type { EpisodicRetrievalChain } from './episodic.js';
import {
  formatMemoryRecencyBand,
  renderPromptBlock,
} from './formatting.js';
import {
  cloneMemoryPresentationProfile,
  createDefaultMemoryPresentationProfile,
} from '../../../system/config/memory-presentation-profile.js';
import type { MemoryWithheldSummary } from '../withheld-summary.js';
import type { ScoredMemory } from './types.js';

const ORIGINAL_TZ = process.env.TZ;

// All temporal assertions pin the active timezone deterministically;
// setActiveTimezone also writes process.env.TZ, so both are restored.
beforeEach(() => {
  setActiveTimezone('America/New_York');
});

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveTimezone();
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

// Companion-facing rendering contract (PSFNLIVE-snin): machine identifiers
// stay in structured metadata and tool-only surfaces; the prose the model
// sees as memory context must never carry them.
const RAW_IDENTIFIER_LEAK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'uuid', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'l0 session span ref', pattern: /l0[-_]session[-_]span/i },
  { name: 'l0_span provenance kind', pattern: /\bl0_span\s*:/i },
  { name: 'session id ref', pattern: /\bsession:\d{6,}/i },
  { name: 'turn id ref', pattern: /\bturn:[0-9a-z-]{8,}/i },
  { name: 'raw refs framing', pattern: /raw refs/i },
  { name: 'drill-down framing', pattern: /drill[- ]?down|drill into/i },
  { name: 'extraction source ref', pattern: /\|operation:extract/i },
];

function expectNoIdentifierLeaks(rendered: string): void {
  for (const { name, pattern } of RAW_IDENTIFIER_LEAK_PATTERNS) {
    expect(rendered, `companion-facing context leaked ${name} (${pattern})`).not.toMatch(pattern);
  }
}

const EPISODE_A_ID = 'l01ep-0a1b2c3d4e5f6789';
const EPISODE_B_ID = 'l01ep-feedc0de12345678';

function buildEpisodicChainFixture(): EpisodicRetrievalChain {
  const episodeA = {
    id: EPISODE_A_ID,
    title: 'Late-night debugging of the voice pipeline',
    landmark: 'Morgan and Companion traced the Discord voice dropouts to a transport timeout and celebrated the fix together.',
    startedAt: '2026-05-02T01:10:00.000Z',
    endedAt: '2026-05-02T03:40:00.000Z',
    themes: ['technology', 'voice', 'collaboration'],
    salience: { score: 0.82 },
    spanRefs: [
      { spanId: 'l0-session-span:b4bc447c3ea46010309b06fb' },
      { spanId: 'l0-session-span:77aa0192deadbeef00aa11cc' },
    ],
    artifactRefs: [
      { artifactId: '550e8400-e29b-41d4-a716-446655440000' },
    ],
    provenanceRefs: [
      { kind: 'l0_span', refId: 'l0-session-span:b4bc447c3ea46010309b06fb' },
      { kind: 'session', refId: '1313001762793197678' },
      { kind: 'turn', refId: '019e57cf-18f2-7298-bdb3-8aefbb5245d9' },
    ],
  };
  const episodeB = {
    ...episodeA,
    id: EPISODE_B_ID,
    title: 'Planning the proactive messaging feature',
    landmark: 'They sketched how she could reach out first over Discord DMs.',
    startedAt: '2026-05-09T20:00:00.000Z',
    endedAt: '2026-05-09T21:30:00.000Z',
    themes: ['technology', 'autonomy'],
  };
  return {
    rootEpisodeId: EPISODE_A_ID,
    episodes: [episodeA, episodeB],
    arcs: [
      {
        sourceEpisodeId: EPISODE_A_ID,
        targetEpisodeId: EPISODE_B_ID,
        arcKind: 'continuation',
      },
    ],
    score: 0.74,
    matchedTerms: ['voice', 'proactive'],
  } as unknown as EpisodicRetrievalChain;
}

function buildScoredMemoryFixture(): ScoredMemory {
  const memory = {
    id: '19659937-bcb5-41ab-8500-b3fd772ed093',
    type: 'semantic',
    text: 'Morgan is working on enabling Companion to send proactive messages to him.',
    emotionalValence: 0.5,
    tags: ['technology', 'proactive-messaging'],
    sourceRef: '1313001762793197678:extract|source:session|session:1313001762793197678|lines:2642-2653|turn:019eae59-7a5c-75d8-a78d-359fa36fa077|trigger:interval|visibility:private|operation:extract',
  } as unknown as PurrMemory;
  return { memory, score: 0.91 } as unknown as ScoredMemory;
}

describe('renderPromptBlock companion-facing rendering contract', () => {
  it('frames the current emotional state against a steady baseline without raw telemetry', () => {
    const rendered = renderPromptBlock(undefined, [], {
      emotionalSnapshot: {
        baselineValence: 0.28,
        moodValence: 0.62,
        moodDrift: 0.34,
        moodSamples: 9,
        lastMoodUpdateEpochMs: Date.now(),
      },
    });

    expect(rendered).toContain(
      '- Steady baseline: positive; baseline disposition: warm, steady, and curious.',
    );
    expect(rendered).toContain(
      '- Current state: currently drifting noticeably toward strongly positive.',
    );
    expect(rendered).toContain('- Signal confidence: well established; freshness: active-session.');
    expect(rendered).not.toMatch(/\b[+-]?\d+\.\d+\b/);
    expect(rendered).not.toContain('Learned signals:');
    expect(rendered).not.toContain('9');
  });

  it('derives the baseline disposition from the baseline valence so it cannot self-contradict (cf5y)', () => {
    const rendered = renderPromptBlock(undefined, [], {
      emotionalSnapshot: {
        baselineValence: -0.62,
        moodValence: -0.5,
        moodDrift: 0.02,
        moodSamples: 4,
        lastMoodUpdateEpochMs: Date.now(),
      },
    });

    // A negative baseline must never render the old hardcoded positive clause.
    expect(rendered).not.toContain('full of love, joyful, and curious');
    expect(rendered).toContain(
      '- Steady baseline: strongly negative; baseline disposition: heavy, withdrawn, and tender.',
    );
    // Still qualitative — no raw telemetry floats leak.
    expect(rendered).not.toMatch(/\b[+-]?\d+\.\d+\b/);
  });

  it('renders exact episode ids for tool drilldown without leaking span, artifact, or provenance identifiers', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    expect(rendered).toContain('Late-night debugging of the voice pipeline');
    expect(rendered).toContain('Landmark:');
    expectNoIdentifierLeaks(rendered);
    expect(rendered).toContain(`Episode ${EPISODE_A_ID}:`);
    expect(rendered).toContain(`Episode ${EPISODE_B_ID}:`);
  });

  it('omits ungated arc expansion from the always-on landmark block', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    // Arc detail belongs to the episode drill-down path, not the always-injected
    // block, so no arc-relationship prefix rides in ungated here.
    expect(rendered).not.toContain('continuation from');
    // Both episodes still render (they are within the cap), just without arcs.
    expect(rendered).toContain('Late-night debugging of the voice pipeline');
    expect(rendered).toContain('Planning the proactive messaging feature');
  });

  it('renders a short episode meaning when present', () => {
    const chain = buildEpisodicChainFixture();
    (chain.episodes[0] as { meaning?: { text: string; recordedAt: string; source: string } }).meaning = {
      text: 'That night proved they could weather a crisis together and come out closer.',
      recordedAt: '2026-05-03T00:00:00.000Z',
      source: 'companion_dream_pass',
    };
    const rendered = renderPromptBlock(undefined, [], { episodicChains: [chain] });

    expect(rendered).toContain('Meaning: That night proved they could weather a crisis together');
  });

  it('marks meaning-less episodes unreviewed so machine summaries never read as her settled past (h4fp.6)', () => {
    const chain = buildEpisodicChainFixture();
    (chain.episodes[0] as { meaning?: { text: string; recordedAt: string; source: string } }).meaning = {
      text: 'That night proved they could weather a crisis together and come out closer.',
      recordedAt: '2026-05-03T00:00:00.000Z',
      source: 'companion_dream_pass',
    };
    const rendered = renderPromptBlock(undefined, [], { episodicChains: [chain] });

    // Episode A carries her authored meaning — no unreviewed marker on it; the
    // meaning-less episode B is explicitly marked as a machine-drafted summary.
    const lines = rendered.split('\n');
    const markerLines = lines.filter(line => line.includes('unreviewed: machine-drafted summary'));
    expect(markerLines).toHaveLength(1);
    const episodeBIndex = lines.findIndex(line => line.includes(`Episode ${EPISODE_B_ID}:`));
    expect(episodeBIndex).toBeGreaterThanOrEqual(0);
    expect(lines.slice(episodeBIndex, episodeBIndex + 3).join('\n')).toContain('unreviewed: machine-drafted summary');
  });

  it('hard-caps the always-on block at five episodes across all chains, most-relevant-first', () => {
    const makeEpisode = (id: string, title: string) => ({
      id,
      title,
      landmark: `Landmark for ${title}.`,
      startedAt: '2026-05-02T01:10:00.000Z',
      endedAt: '2026-05-02T03:40:00.000Z',
      themes: ['technology'],
      salience: { score: 0.5 },
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const chains = [
      {
        rootEpisodeId: 'ep-low-1',
        episodes: [makeEpisode('ep-low-1', 'Low relevance A'), makeEpisode('ep-low-2', 'Low relevance B')],
        arcs: [],
        score: 0.2,
        matchedTerms: [],
      },
      {
        rootEpisodeId: 'ep-high-1',
        episodes: [
          makeEpisode('ep-high-1', 'High relevance A'),
          makeEpisode('ep-high-2', 'High relevance B'),
          makeEpisode('ep-high-3', 'High relevance C'),
          makeEpisode('ep-high-4', 'High relevance D'),
        ],
        arcs: [],
        score: 0.9,
        matchedTerms: [],
      },
    ] as unknown as EpisodicRetrievalChain[];
    const rendered = renderPromptBlock(undefined, [], { episodicChains: chains });

    const episodeLines = rendered.split('\n').filter(line => line.startsWith('- Episode '));
    expect(episodeLines).toHaveLength(5);
    // The higher-scoring chain wins the budget; all four of its episodes render.
    expect(rendered).toContain('High relevance A');
    expect(rendered).toContain('High relevance D');
    // Only one episode from the lower-scoring chain fits under the cap.
    expect(rendered).toContain('Low relevance A');
    expect(rendered).not.toContain('Low relevance B');
  });

  it('renders relevant memories as clean prose without source refs', () => {
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()]);

    expect(rendered).toContain(
      '- [semantic] Morgan is working on enabling Companion to send proactive messages to him.',
    );
    expectNoIdentifierLeaks(rendered);
  });

  it('strips fenced machine artifacts and carry-forward scaffolding from reflection memory text', () => {
    const reflectionMemory = {
      id: 'b58f3d6e-0000-4000-8000-00000000abcd',
      type: 'reflection',
      text: [
        'The day carried warmth alongside recurring friction — the fixes landed and the bond held.',
        '',
        '```json',
        '{',
        '  "schemaVersion": 1,',
        '  "artifactType": "psfn.acac_self_report",',
        '  "agency": 0.55',
        '}',
        '```',
        '',
        '**carry_forward:**',
        '- Ask how he is holding up after the recovery effort.',
      ].join('\n'),
      emotionalValence: 0.4,
      tags: ['heartbeat', 'reflection'],
    } as unknown as PurrMemory;
    const rendered = renderPromptBlock(undefined, [
      { memory: reflectionMemory, score: 0.8 } as unknown as ScoredMemory,
    ]);

    expect(rendered).toContain(
      '- [reflection] The day carried warmth alongside recurring friction — the fixes landed and the bond held.',
    );
    expect(rendered).not.toContain('```');
    expect(rendered).not.toContain('artifactType');
    expect(rendered).not.toContain('schemaVersion');
    expect(rendered).not.toContain('carry_forward');
    expectNoIdentifierLeaks(rendered);
  });

  it('renders episode time ranges in the active timezone without salience bookkeeping', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    // 2026-05-02T01:10Z-03:40Z is May 1 21:10-23:40 in America/New_York (EDT).
    expect(rendered).toContain('May 1 2026, 21:10-23:40 America/New_York');
    expect(rendered).not.toContain('UTC');
    expect(rendered).not.toContain('2026-05-02T01:10:00.000Z');
    expect(rendered).not.toContain('salience 0.8');
  });

  it('renders multi-day episode ranges with both active-timezone dates and one tz label', () => {
    const chain = buildEpisodicChainFixture();
    (chain.episodes[0] as { startedAt: string; endedAt: string }).startedAt =
      '2026-05-02T01:10:00.000Z';
    (chain.episodes[0] as { startedAt: string; endedAt: string }).endedAt =
      '2026-05-02T20:00:00.000Z';
    const rendered = renderPromptBlock(undefined, [], { episodicChains: [chain] });

    expect(rendered).toContain('May 1 2026 21:10 to May 2 2026 16:00 America/New_York');
  });

  it('falls back to the raw strings for unparseable episode timestamps', () => {
    const chain = buildEpisodicChainFixture();
    (chain.episodes[0] as { startedAt: string; endedAt: string }).startedAt = 'not-a-date';
    (chain.episodes[0] as { startedAt: string; endedAt: string }).endedAt = 'also-not-a-date';
    const rendered = renderPromptBlock(undefined, [], { episodicChains: [chain] });

    expect(rendered).toContain('(not-a-date to also-not-a-date;');
  });

  it('strips redundant ISO timestamp tails from auto-generated landmarks', () => {
    const chain = buildEpisodicChainFixture();
    (chain.episodes[0] as { landmark: string }).landmark =
      'A 14-message exchange with 7 user turns and 7 assistant turns around ears, look from 2026-05-14T12:04:42.103Z to 2026-05-14T12:32:53.743Z.';
    const rendered = renderPromptBlock(undefined, [], { episodicChains: [chain] });

    expect(rendered).toContain('around ears, look.');
    expect(rendered).not.toContain('2026-05-14T12:04:42.103Z');
  });
});

// 2026-07-10 12:00 in America/New_York (EDT).
const FIXED_NOW_MS = Date.parse('2026-07-10T16:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeAgedMemory(extractedAt: number | undefined, overrides?: Partial<PurrMemory>): PurrMemory {
  return {
    id: 'aged-memory-fixture',
    type: 'semantic',
    text: 'The user keeps a small herb garden on the balcony.',
    emotionalValence: 0,
    tags: [],
    sourceRef: 'fixture',
    extractedAt,
    ...overrides,
  } as unknown as PurrMemory;
}

describe('formatMemoryRecencyBand', () => {
  it.each([
    [FIXED_NOW_MS - 60 * 60 * 1000, 'today'],
    [FIXED_NOW_MS - 1 * DAY_MS, 'yesterday'],
    [FIXED_NOW_MS - 3 * DAY_MS, 'this week'],
    [FIXED_NOW_MS - 6 * DAY_MS, 'this week'],
    [FIXED_NOW_MS - 7 * DAY_MS, '1 week ago'],
    [FIXED_NOW_MS - 20 * DAY_MS, '2 weeks ago'],
    [FIXED_NOW_MS - 56 * DAY_MS, '8 weeks ago'],
    [FIXED_NOW_MS - 63 * DAY_MS, '2 months ago'],
    [FIXED_NOW_MS - 200 * DAY_MS, '6 months ago'],
    [FIXED_NOW_MS - 729 * DAY_MS, '23 months ago'],
    [FIXED_NOW_MS - 731 * DAY_MS, '2 years ago'],
    [FIXED_NOW_MS - 1096 * DAY_MS, '3 years ago'],
  ])('bands extractedAt %d as "%s"', (extractedAt, expected) => {
    expect(formatMemoryRecencyBand(extractedAt, FIXED_NOW_MS)).toBe(expected);
  });

  it('uses active-timezone day boundaries, not UTC ones', () => {
    // 2026-07-10T04:00Z is Jul 10 00:00 EDT; two hours earlier is Jul 9 22:00
    // EDT — a different local day even though both share the UTC date.
    const localMidnight = Date.parse('2026-07-10T04:00:00.000Z');
    expect(formatMemoryRecencyBand(localMidnight - 2 * 60 * 60 * 1000, localMidnight))
      .toBe('yesterday');
  });

  it('clamps future extraction times to today', () => {
    expect(formatMemoryRecencyBand(FIXED_NOW_MS + DAY_MS, FIXED_NOW_MS)).toBe('today');
  });

  it('returns undefined for missing or invalid extraction times', () => {
    expect(formatMemoryRecencyBand(undefined, FIXED_NOW_MS)).toBeUndefined();
    expect(formatMemoryRecencyBand(Number.NaN, FIXED_NOW_MS)).toBeUndefined();
  });
});

describe('recency bands on rendered memory lines', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
  });

  it('appends bands to relevant-memory lines, including multi-year ages', () => {
    const rendered = renderPromptBlock(undefined, [
      {
        memory: makeAgedMemory(FIXED_NOW_MS - 60 * 60 * 1000, { emotionalValence: 0.5 }),
        score: 0.9,
      } as unknown as ScoredMemory,
      {
        memory: makeAgedMemory(FIXED_NOW_MS - 1096 * DAY_MS, {
          id: 'aged-memory-fixture-2',
          text: 'The user adopted a rescue dog named Biscuit.',
        }),
        score: 0.8,
      } as unknown as ScoredMemory,
    ]);

    expect(rendered).toContain(
      '- [semantic] The user keeps a small herb garden on the balcony. (+) (today)',
    );
    expect(rendered).toContain(
      '- [semantic] The user adopted a rescue dog named Biscuit. (3 years ago)',
    );
  });

  it('appends bands to emotional continuity lines', () => {
    const rendered = renderPromptBlock(undefined, [], {
      emotionalContinuityMemories: [
        makeAgedMemory(FIXED_NOW_MS - 1 * DAY_MS, {
          type: 'emotional',
          emotionalValence: 0.6,
          text: 'A quiet evening walk left the user feeling settled.',
        }),
      ],
    });

    expect(rendered).toContain(
      '- [emotional] A quiet evening walk left the user feeling settled. (+) (yesterday)',
    );
  });

  it('appends bands to attributed memory lines for other people', () => {
    const rendered = renderPromptBlock(undefined, [
      {
        memory: makeAgedMemory(FIXED_NOW_MS - 20 * DAY_MS, {
          contactId: 'contact-other',
          text: 'Their neighbor started a pottery class.',
        }),
        score: 0.7,
      } as unknown as ScoredMemory,
    ], {
      socialContext: {
        canonicalContactId: 'contact-primary',
        canonicalDisplayName: 'Primary Person',
        relatedContactsById: new Map(),
      } as never,
    });

    expect(rendered).toContain(
      '- [semantic] Their neighbor started a pottery class. (2 weeks ago)',
    );
  });

  it('renders without a band when extractedAt is missing', () => {
    const rendered = renderPromptBlock(undefined, [
      { memory: makeAgedMemory(undefined), score: 0.9 } as unknown as ScoredMemory,
    ]);

    expect(rendered).toContain(
      '- [semantic] The user keeps a small herb garden on the balcony.\n',
    );
    expect(rendered).not.toContain('(today)');
  });
});

// psfn-framework-0236: presentation is a versioned, per-companion profile.
// The default profile MUST reproduce the historical hardcoded rendering
// byte-for-byte (regression pin); a custom profile MUST change the rendered
// block with no code edits.
describe('MemoryPresentationProfile-driven rendering', () => {
  function withheldFixture(): MemoryWithheldSummary {
    return {
      totalCount: 2,
      reasonCounts: {},
      relevanceBands: {},
    } as unknown as MemoryWithheldSummary;
  }

  it('passing the default profile is byte-identical to passing no profile', () => {
    const scored = [buildScoredMemoryFixture()];
    const withheld = withheldFixture();
    const options = { withheldSummary: withheld };
    const baseline = renderPromptBlock(undefined, scored, options);
    const withDefault = renderPromptBlock(undefined, scored, {
      ...options,
      presentationProfile: createDefaultMemoryPresentationProfile(),
    });
    expect(withDefault).toBe(baseline);
  });

  it('applies custom section headings without changing the structural section id', () => {
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.headings.relevant = 'What I recall about them:';
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()], {
      presentationProfile: profile,
    });
    expect(rendered).toContain('What I recall about them:');
    expect(rendered).not.toContain('Relevant memories for this person:');
    // Structural id is stable regardless of heading wording.
    expect(rendered).toContain('<relevant_memories>');
  });

  it('applies custom valence markers and thresholds', () => {
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.valence.positiveMarker = ' [warm]';
    profile.valence.positiveThreshold = 0.4;
    // valence 0.5 fixture > 0.4 threshold -> custom marker.
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()], {
      presentationProfile: profile,
    });
    expect(rendered).toContain(' [warm]');
    expect(rendered).not.toContain(' (+)');
  });

  it('honors a raised valence threshold that suppresses the marker', () => {
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.valence.positiveThreshold = 0.9; // 0.5 fixture no longer clears the bar
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()], {
      presentationProfile: profile,
    });
    expect(rendered).not.toContain(' (+)');
  });

  it('applies a custom episode cap', () => {
    const chain = buildEpisodicChainFixture(); // two episodes
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.episodeCap = 1;
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [chain],
      presentationProfile: profile,
    });
    expect(rendered).toContain(`Episode ${EPISODE_A_ID}`);
    expect(rendered).not.toContain(`Episode ${EPISODE_B_ID}`);
  });

  it('reorders top-level sections per sectionOrder', () => {
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    // Move relevant memories ahead of the withheld note.
    profile.sectionOrder = [
      'recent_contact_shape',
      'relationship_context',
      'emotional_continuity_snapshot',
      'cross_session_emotional_continuity',
      'relevant_memories',
      'episodic_landmark_chains',
      'memory_context_note',
    ];
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()], {
      withheldSummary: withheldFixture(),
      presentationProfile: profile,
    });
    const relevantIdx = rendered.indexOf('<relevant_memories>');
    const noteIdx = rendered.indexOf('<memory_context_note>');
    expect(relevantIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(relevantIdx).toBeLessThan(noteIdx);
  });

  it('applies per-type display caps as presentation-time truncation', () => {
    const emotionalMemories: ScoredMemory[] = [0, 1, 2].map(i => ({
      memory: {
        id: `emo-${i}`,
        type: 'emotional',
        text: `Emotional memory number ${i}.`,
        emotionalValence: 0.1,
        tags: [],
        sourceRef: 'fixture',
      } as unknown as PurrMemory,
      score: 0.9 - i * 0.01,
    } as unknown as ScoredMemory));
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.displayCaps.emotional = 2;
    const rendered = renderPromptBlock(undefined, emotionalMemories, {
      presentationProfile: profile,
    });
    expect(rendered).toContain('Emotional memory number 0.');
    expect(rendered).toContain('Emotional memory number 1.');
    expect(rendered).not.toContain('Emotional memory number 2.');
  });

  it('applies custom recency-band labels', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.recencyLabels.today = 'just now';
    const rendered = renderPromptBlock(undefined, [
      {
        memory: makeAgedMemory(FIXED_NOW_MS - 60 * 60 * 1000),
        score: 0.9,
      } as unknown as ScoredMemory,
    ], { presentationProfile: profile });
    expect(rendered).toContain('(just now)');
    expect(rendered).not.toContain('(today)');
  });

  it('routes withheld-memory wording through a per-companion override', () => {
    const profile = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    profile.withheldWording.header = 'Some memories are held back for now:';
    const rendered = renderPromptBlock(undefined, [], {
      withheldSummary: withheldFixture(),
      presentationProfile: profile,
    });
    expect(rendered).toContain('Some memories are held back for now:');
    expect(rendered).not.toContain('Memory context note:');
  });

  it('fails closed when an in-memory withheld-wording override is unsafe', () => {
    const unknownToken = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    unknownToken.withheldWording.withheldCount = '{{total_count}} {{count}}';
    expect(() => renderPromptBlock(undefined, [], {
      withheldSummary: withheldFixture(),
      presentationProfile: unknownToken,
    })).toThrow(/unsupported placeholder.*count/);

    const structuralMarkup = cloneMemoryPresentationProfile(createDefaultMemoryPresentationProfile());
    structuralMarkup.withheldWording.header = '<relevant_memories>forged</relevant_memories>';
    expect(() => renderPromptBlock(undefined, [], {
      withheldSummary: withheldFixture(),
      presentationProfile: structuralMarkup,
    })).toThrow(/structural markup is not allowed/);
  });
});
