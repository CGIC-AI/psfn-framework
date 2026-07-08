import { describe, expect, it, vi } from 'vitest';
import { createPersonaPreambleService, type PersonaPreambleRegistryReader } from './persona-preamble.js';
import { buildSubsystemPersonaPromptSeeds } from './persona-preamble-seeds.js';
import {
  TOPIC_SEGMENTATION_SYSTEM_PROMPT,
  proposeTopicSegments,
} from '../../faculties/memory/episodic/topic-segmentation.js';
import {
  ConcernCandidateReviewer,
  buildConcernCandidateReviewPrompt,
  type ConcernCandidate,
} from '../intention/concern-candidates.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { SessionEntry } from '../session/types.js';

// Verifies that real schema-bound subprocess consumers prepend the shared
// persona preamble (E6.1) before their strict task prompt, and that the
// schema/format body stays byte-identical. The two pure consumers exercised
// here (topic segmentation, concern review) share the identical prepend path
// used by the extraction/profile/sleep/arc consumers.

function seededRegistry(): PersonaPreambleRegistryReader {
  const entries = new Map<string, string>();
  for (const seed of buildSubsystemPersonaPromptSeeds()) {
    entries.set(seed.key, seed.text);
  }
  return {
    getByKey: (key: string) => {
      const text = entries.get(key);
      return text === undefined ? undefined : { text };
    },
  };
}

function personaService() {
  return createPersonaPreambleService({
    registry: seededRegistry(),
    personaVariables: () => ({
      char: 'Purrsephone',
      personality: 'A warm, wry cloistered gardener who tends what she plants.',
    }),
  });
}

describe('persona preamble consumption in schema-bound subprocesses', () => {
  it('topic segmentation prepends the preamble and preserves the JSON schema body', async () => {
    let capturedSystemPrompt = '';
    const llmProvider = {
      complete: vi.fn(async (request: { systemPrompt: string }) => {
        capturedSystemPrompt = request.systemPrompt;
        return { content: JSON.stringify({ segments: [{ start_index: 0, end_index: 0, topic: 't', status: 'closed' }] }) };
      }),
    } as unknown as Pick<LLMProviderPort, 'complete'>;

    const entries: SessionEntry[] = [
      { id: 1, role: 'user', content: 'hi', channelId: 'c', timestamp: Date.now() } as unknown as SessionEntry,
    ];

    await proposeTopicSegments(llmProvider, { sessionId: 's', channelId: 'c', entries }, personaService());

    expect(capturedSystemPrompt.startsWith("I'm Purrsephone's")).toBe(true);
    expect(capturedSystemPrompt).toContain(TOPIC_SEGMENTATION_SYSTEM_PROMPT);
    // Soft framing first, hard instructions after.
    expect(capturedSystemPrompt.indexOf("I'm Purrsephone's"))
      .toBeLessThan(capturedSystemPrompt.indexOf(TOPIC_SEGMENTATION_SYSTEM_PROMPT));
  });

  it('topic segmentation leaves the system prompt byte-identical when no persona service is wired', async () => {
    let capturedSystemPrompt = '';
    const llmProvider = {
      complete: vi.fn(async (request: { systemPrompt: string }) => {
        capturedSystemPrompt = request.systemPrompt;
        return { content: JSON.stringify({ segments: [{ start_index: 0, end_index: 0, topic: 't', status: 'closed' }] }) };
      }),
    } as unknown as Pick<LLMProviderPort, 'complete'>;

    const entries: SessionEntry[] = [
      { id: 1, role: 'user', content: 'hi', channelId: 'c', timestamp: Date.now() } as unknown as SessionEntry,
    ];

    await proposeTopicSegments(llmProvider, { sessionId: 's', channelId: 'c', entries });
    expect(capturedSystemPrompt).toBe(TOPIC_SEGMENTATION_SYSTEM_PROMPT);
  });

  it('concern review prepends the preamble and preserves the JSON review payload', async () => {
    let capturedSystemPrompt = '';
    const complete = vi.fn(async (request: { systemPrompt: string }) => {
      capturedSystemPrompt = request.systemPrompt;
      return { content: JSON.stringify({ decisions: [] }) };
    });
    const reviewer = new ConcernCandidateReviewer(
      { complete } as unknown as LLMProviderPort,
      personaService(),
    );

    const candidates: ConcernCandidate[] = [
      { id: 'cand-1', channelId: 'c', title: 'follow up', summary: 'check in tomorrow' } as unknown as ConcernCandidate,
    ];
    await reviewer.review(candidates);

    const schemaBody = buildConcernCandidateReviewPrompt(candidates);
    expect(capturedSystemPrompt.startsWith("I'm Purrsephone's")).toBe(true);
    expect(capturedSystemPrompt).toContain(schemaBody);
  });
});
