import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  EXTRACTION_CHUNK_LLM_CONCURRENCY,
  executeExtractionLlmPass,
  formatExistingFactsSection,
  mapWithConcurrency,
  renderExtractionChunkPrompt,
  resolveExtractionChunkRequestId,
  type ExtractionChunkPromptContext,
} from './llm-pass.js';
import { buildExtractionNamingGuidance } from './naming.js';
import { buildExperientialSelfDirectedExtractionGuidance } from './self-directed.js';

const PROMPT_TEMPLATE = 'Known facts:\n{existing_facts}\n\nTranscript:\n{recent_messages}';

function entry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'api:test',
    role: id % 2 === 1 ? 'user' : 'assistant',
    content: `line ${id}`,
    timestamp: id,
    ...(id % 2 === 1 ? { authorName: 'Alex' } : {}),
    ...overrides,
  };
}

function promptContext(
  overrides: Partial<ExtractionChunkPromptContext> = {},
): ExtractionChunkPromptContext {
  return {
    extractionPrompt: PROMPT_TEMPLATE,
    existingFacts: '(none yet)',
    participantNames: {},
    characterName: 'Lyra',
    experientialCompanionName: undefined,
    personaPreamble: null,
    ...overrides,
  };
}

function factResponse(...texts: string[]): string {
  const facts = texts.map(text => `<fact>
<text>${text}</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.9</confidence>
</fact>`).join('\n');
  return `<response>\n${facts}\n</response>`;
}

describe('formatExistingFactsSection', () => {
  it('renders one bullet per memory with its type', () => {
    expect(formatExistingFactsSection([
      { type: 'semantic', text: 'User enjoys board games' },
      { type: 'episodic', text: 'Visited the arcade' },
    ])).toBe('- [semantic] User enjoys board games\n- [episodic] Visited the arcade');
  });

  it('falls back to the (none yet) placeholder when no memories exist', () => {
    expect(formatExistingFactsSection([])).toBe('(none yet)');
  });
});

describe('renderExtractionChunkPrompt', () => {
  it('substitutes existing facts and the formatted transcript into the template', () => {
    const rendered = renderExtractionChunkPrompt(
      [entry(1), entry(2)],
      promptContext({ existingFacts: '- [semantic] Existing fact' }),
    );
    expect(rendered).toBe([
      'Known facts:',
      '- [semantic] Existing fact',
      '',
      'Transcript:',
      '[message_id:1] Alex: line 1',
      '[message_id:2] Lyra: line 2',
    ].join('\n'));
  });

  it('prefers the resolved companion participant name over the character name', () => {
    const rendered = renderExtractionChunkPrompt(
      [entry(2)],
      promptContext({ participantNames: { companionName: 'Nova' } }),
    );
    expect(rendered).toContain('[message_id:2] Nova: line 2');
    expect(rendered).toContain(buildExtractionNamingGuidance({ companionName: 'Nova' }));
  });

  it('appends naming guidance after the rendered template when participant names resolve', () => {
    const names = { userName: 'Alex', companionName: 'Lyra' };
    const rendered = renderExtractionChunkPrompt(
      [entry(1)],
      promptContext({ participantNames: names }),
    );
    expect(rendered.endsWith(`\n\n${buildExtractionNamingGuidance(names)}`)).toBe(true);
  });

  it('omits empty guidance sections entirely', () => {
    const rendered = renderExtractionChunkPrompt([entry(1)], promptContext());
    expect(rendered).not.toContain('\n\n\n');
    expect(rendered.endsWith('[message_id:1] Alex: line 1')).toBe(true);
  });

  it('appends experiential self-directed guidance when a companion name is set', () => {
    const rendered = renderExtractionChunkPrompt(
      [entry(2)],
      promptContext({ experientialCompanionName: 'Lyra' }),
    );
    expect(rendered.endsWith(
      `\n\n${buildExperientialSelfDirectedExtractionGuidance('Lyra')}`,
    )).toBe(true);
  });

  it('prepends the persona preamble around the assembled task prompt', () => {
    const prepend = vi.fn((_purpose: string, prompt: string) => `PERSONA\n\n${prompt}`);
    const rendered = renderExtractionChunkPrompt(
      [entry(1)],
      promptContext({ personaPreamble: { prepend } }),
    );
    expect(prepend).toHaveBeenCalledWith('memory_extraction', expect.stringContaining('Transcript:'));
    expect(rendered.startsWith('PERSONA\n\n')).toBe(true);
  });
});

describe('resolveExtractionChunkRequestId', () => {
  it('keeps the base request id for a single-chunk pass', () => {
    expect(resolveExtractionChunkRequestId('req-1', 1, 0)).toBe('req-1');
  });

  it('suffixes 1-based chunk ordinals for a multi-chunk pass', () => {
    expect(resolveExtractionChunkRequestId('req-1', 3, 0)).toBe('req-1:chunk:1');
    expect(resolveExtractionChunkRequestId('req-1', 3, 2)).toBe('req-1:chunk:3');
  });
});

describe('executeExtractionLlmPass', () => {
  it('runs a single-pass extraction as one chunk over the whole transcript', async () => {
    const completeChunk = vi.fn().mockResolvedValue(factResponse('User enjoys board games'));
    const result = await executeExtractionLlmPass({
      recentEntries: [entry(1), entry(2)],
      useCompositionalExtraction: false,
      promptContext: promptContext(),
      requestId: 'req-1',
      completeChunk,
    });
    expect(completeChunk).toHaveBeenCalledTimes(1);
    expect(completeChunk).toHaveBeenCalledWith(
      expect.stringContaining('[message_id:1] Alex: line 1\n[message_id:2] Lyra: line 2'),
      'req-1',
    );
    expect(result.chunkCount).toBe(1);
    expect(result.rawParsedFactCount).toBe(1);
    expect(result.crossChunkDeduplicatedCount).toBe(0);
    expect(result.mergedParsedFacts.map(fact => fact.text)).toEqual(['User enjoys board games']);
  });

  it('filters system/tool entries out of the transcript before chunking', async () => {
    const completeChunk = vi.fn().mockResolvedValue(factResponse('kept'));
    await executeExtractionLlmPass({
      recentEntries: [
        entry(1),
        entry(2, { role: 'system', content: 'system line' }),
      ],
      useCompositionalExtraction: false,
      promptContext: promptContext(),
      requestId: 'req-1',
      completeChunk,
    });
    const prompt = completeChunk.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('[message_id:1]');
    expect(prompt).not.toContain('system line');
  });

  it('splits a compositional pass into 10-entry chunks with ordinal request ids', async () => {
    const completeChunk = vi.fn().mockResolvedValue(factResponse('chunk fact'));
    const result = await executeExtractionLlmPass({
      recentEntries: Array.from({ length: 21 }, (_, index) => entry(index + 1)),
      useCompositionalExtraction: true,
      promptContext: promptContext(),
      requestId: 'req-1',
      completeChunk,
    });
    expect(result.chunkCount).toBe(3);
    expect(completeChunk).toHaveBeenCalledTimes(3);
    const requestIds = completeChunk.mock.calls.map(call => call[1]).sort();
    expect(requestIds).toEqual(['req-1:chunk:1', 'req-1:chunk:2', 'req-1:chunk:3']);
    const chunk1Prompt = completeChunk.mock.calls
      .find(call => call[1] === 'req-1:chunk:1')?.[0] as string;
    expect(chunk1Prompt).toContain('[message_id:1]');
    expect(chunk1Prompt).toContain('[message_id:10]');
    expect(chunk1Prompt).not.toContain('[message_id:11]');
  });

  it('merges duplicate facts across chunks and counts the cross-chunk dedupe', async () => {
    const completeChunk = vi.fn()
      .mockResolvedValueOnce(factResponse('Shared fact', 'First-only fact'))
      .mockResolvedValueOnce(factResponse('Shared fact'));
    const result = await executeExtractionLlmPass({
      recentEntries: Array.from({ length: 11 }, (_, index) => entry(index + 1)),
      useCompositionalExtraction: true,
      promptContext: promptContext(),
      requestId: 'req-1',
      completeChunk,
    });
    expect(result.chunkCount).toBe(2);
    expect(result.rawParsedFactCount).toBe(3);
    expect(result.mergedParsedFacts.map(fact => fact.text)).toEqual([
      'Shared fact',
      'First-only fact',
    ]);
    expect(result.crossChunkDeduplicatedCount).toBe(1);
  });

  it('surfaces a chunk completion failure instead of swallowing it', async () => {
    const completeChunk = vi.fn().mockRejectedValue(new Error('provider down'));
    await expect(executeExtractionLlmPass({
      recentEntries: [entry(1)],
      useCompositionalExtraction: false,
      promptContext: promptContext(),
      requestId: 'req-1',
      completeChunk,
    })).rejects.toThrow('provider down');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 2, async value => {
      await new Promise(resolve => setTimeout(resolve, value));
      return value * 10;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('caps in-flight work at the extraction chunk concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      EXTRACTION_CHUNK_LLM_CONCURRENCY,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );
    expect(maxInFlight).toBe(EXTRACTION_CHUNK_LLM_CONCURRENCY);
  });

  it('rethrows the first mapper error and stops starting new work', async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency([1, 2, 3, 4], 1, async (value) => {
      started.push(value);
      if (value === 2) throw new Error('boom');
      return value;
    })).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
