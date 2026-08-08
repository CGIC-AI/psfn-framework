import type { SessionEntry } from '../../../core/session/types.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { injectPromptRuntimeTokens } from '../../../core/identity/prompt-runtime.js';
import type { ExtractedFact, PurrMemory } from '../types.js';
import { parseFactsXml } from './parser.js';
import {
  buildExtractionEntryChunks,
  formatExtractionTranscript,
  isExtractionTranscriptEntry,
  mergeExtractedFactGroups,
} from './chunk-compose.js';
import {
  buildExtractionNamingGuidance,
  type ExtractionParticipantNames,
} from './naming.js';
import { buildExperientialSelfDirectedExtractionGuidance } from './self-directed.js';

export const EXTRACTION_CHUNK_LLM_CONCURRENCY = 2;

export function formatExistingFactsSection(
  existing: readonly Pick<PurrMemory, 'type' | 'text'>[],
): string {
  return existing
    .map(m => `- [${m.type}] ${m.text}`)
    .join('\n') || '(none yet)';
}

export interface ExtractionChunkPromptContext {
  extractionPrompt: string;
  existingFacts: string;
  participantNames: ExtractionParticipantNames;
  characterName: string | undefined;
  experientialCompanionName: string | undefined;
  /** E6.1: soft persona framing prepended before the schema-bound task prompt. */
  personaPreamble: PersonaPreamblePort | null | undefined;
}

export function renderExtractionChunkPrompt(
  chunkEntries: SessionEntry[],
  context: ExtractionChunkPromptContext,
): string {
  const renderedPrompt = injectPromptRuntimeTokens(context.extractionPrompt)
    .replace('{existing_facts}', context.existingFacts)
    .replace('{recent_messages}', formatExtractionTranscript(chunkEntries, {
      charName: context.participantNames.companionName ?? context.characterName,
      userName: context.participantNames.userName,
    }));
  const namingGuidance = buildExtractionNamingGuidance(context.participantNames);
  const selfDirectedGuidance = context.experientialCompanionName
    ? buildExperientialSelfDirectedExtractionGuidance(context.experientialCompanionName)
    : undefined;
  const taskPrompt = [renderedPrompt, namingGuidance, selfDirectedGuidance]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
  // E6.1: soft persona framing precedes the strict task instructions and
  // JSON schema; the schema/format sections stay byte-identical.
  return context.personaPreamble
    ? context.personaPreamble.prepend('memory_extraction', taskPrompt)
    : taskPrompt;
}

export function resolveExtractionChunkRequestId(
  requestId: string,
  chunkCount: number,
  index: number,
): string {
  return chunkCount > 1 ? `${requestId}:chunk:${index + 1}` : requestId;
}

export interface ExtractionLlmPassInput {
  recentEntries: SessionEntry[];
  useCompositionalExtraction: boolean;
  promptContext: ExtractionChunkPromptContext;
  requestId: string;
  /**
   * Completes one chunk's model call. Kept as a port so the durable work-spec
   * construction (preemptionProtected / welfareGrantJobId) stays on the
   * sanctioned welfare path in orchestrator.ts.
   */
  completeChunk: (prompt: string, chunkRequestId: string) => Promise<string>;
}

export interface ExtractionLlmPassResult {
  chunkCount: number;
  rawParsedFactCount: number;
  mergedParsedFacts: ExtractedFact[];
  crossChunkDeduplicatedCount: number;
}

export async function executeExtractionLlmPass(
  input: ExtractionLlmPassInput,
): Promise<ExtractionLlmPassResult> {
  const transcriptEntries = input.recentEntries.filter(isExtractionTranscriptEntry);
  const entryChunks = input.useCompositionalExtraction
    ? buildExtractionEntryChunks(transcriptEntries)
    : [transcriptEntries];
  const parsedFactGroups = await mapWithConcurrency(
    entryChunks,
    EXTRACTION_CHUNK_LLM_CONCURRENCY,
    async (chunkEntries, index): Promise<ExtractedFact[]> => {
      const prompt = renderExtractionChunkPrompt(chunkEntries, input.promptContext);
      const chunkRequestId = resolveExtractionChunkRequestId(
        input.requestId,
        entryChunks.length,
        index,
      );
      const content = await input.completeChunk(prompt, chunkRequestId);
      return parseFactsXml(content);
    },
  );
  const rawParsedFactCount = parsedFactGroups
    .reduce((total, group) => total + group.length, 0);
  const mergedParsedFacts = mergeExtractedFactGroups(parsedFactGroups);
  return {
    chunkCount: entryChunks.length,
    rawParsedFactCount,
    mergedParsedFacts,
    crossChunkDeduplicatedCount: Math.max(0, rawParsedFactCount - mergedParsedFacts.length),
  };
}

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length && firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await mapper(item, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}
