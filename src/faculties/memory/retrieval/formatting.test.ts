import { describe, expect, it } from 'vitest';

import type { PurrMemory } from '../types.js';
import type { EpisodicRetrievalChain } from './episodic.js';
import { renderPromptBlock } from './formatting.js';
import type { ScoredMemory } from './types.js';

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
    landmark: 'V and Purrsephone traced the Discord voice dropouts to a transport timeout and celebrated the fix together.',
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
    text: 'V is working on enabling Purrsephone to send proactive messages to him.',
    emotionalValence: 0.5,
    tags: ['technology', 'proactive-messaging'],
    sourceRef: '1313001762793197678:extract|source:session|session:1313001762793197678|lines:2642-2653|turn:019eae59-7a5c-75d8-a78d-359fa36fa077|trigger:interval|visibility:private|operation:extract',
  } as unknown as PurrMemory;
  return { memory, score: 0.91 } as unknown as ScoredMemory;
}

describe('renderPromptBlock companion-facing rendering contract', () => {
  it('renders episodic landmark chains without raw span, artifact, or provenance identifiers', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    expect(rendered).toContain('Late-night debugging of the voice pipeline');
    expect(rendered).toContain('Landmark:');
    expectNoIdentifierLeaks(rendered);
    expect(rendered).not.toContain(EPISODE_A_ID);
    expect(rendered).not.toContain(EPISODE_B_ID);
  });

  it('describes arc links by episode title instead of episode id', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    expect(rendered).toContain('continuation from "Late-night debugging of the voice pipeline"');
  });

  it('renders relevant memories as clean prose without source refs', () => {
    const rendered = renderPromptBlock(undefined, [buildScoredMemoryFixture()]);

    expect(rendered).toContain(
      '- [semantic] V is working on enabling Purrsephone to send proactive messages to him.',
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

  it('renders episode time ranges as readable dates without salience bookkeeping', () => {
    const rendered = renderPromptBlock(undefined, [], {
      episodicChains: [buildEpisodicChainFixture()],
    });

    expect(rendered).toContain('May 2 2026, 01:10-03:40 UTC');
    expect(rendered).not.toContain('2026-05-02T01:10:00.000Z');
    expect(rendered).not.toContain('salience 0.8');
  });
});
