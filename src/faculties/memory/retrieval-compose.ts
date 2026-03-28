import type { LLMProvider } from '../../core/agent/contracts.js';

export const RETRIEVAL_COMPOSITION_BATCH_SIZE = 4;
export const RETRIEVAL_COMPOSITION_MAX_CANDIDATES = 12;
export const RETRIEVAL_COMPOSITION_FINALIST_LIMIT = 6;

export interface RetrievalComposeCandidate {
  id: string;
  text: string;
  type: string;
  score: number;
  similarity: number;
  importance: number;
  confidence: number;
  salience: number;
  evidenceSupport: number;
  explicitlyQueried: boolean;
}

export interface RetrievalCompositionDecision {
  relevanceById: Map<string, number>;
  finalOrder: string[];
}

interface RetrievalEvaluation {
  id: string;
  relevance: number;
}

export async function composeRetrievalRanking(options: {
  llmClient: LLMProvider;
  query: string;
  channelId: string;
  candidates: RetrievalComposeCandidate[];
}): Promise<RetrievalCompositionDecision | null> {
  const focusCandidates = options.candidates
    .slice(0, RETRIEVAL_COMPOSITION_MAX_CANDIDATES);
  if (focusCandidates.length < 2) return null;

  try {
    const relevanceById = new Map<string, number>();
    const candidateBatches = buildCandidateBatches(focusCandidates, RETRIEVAL_COMPOSITION_BATCH_SIZE);

    for (const [batchIndex, batch] of candidateBatches.entries()) {
      const response = await options.llmClient.complete(
        {
          systemPrompt: buildEvaluationPrompt(options.query, batch),
          messages: [{ role: 'user', content: 'Evaluate the retrieval candidates and return XML only.' }],
          correlation: {
            requestId: `${options.channelId}:retrieval-evaluate:${batchIndex + 1}`,
            channelId: options.channelId,
            callType: 'memory',
            purpose: 'memory.retrieval.evaluate',
          },
        },
        'memory',
      );

      const parsed = parseEvaluationResponse(response.content, batch.map(candidate => candidate.id));
      if (parsed.length === 0) return null;
      for (const evaluation of parsed) {
        const previous = relevanceById.get(evaluation.id) ?? 0;
        relevanceById.set(evaluation.id, Math.max(previous, evaluation.relevance));
      }
    }

    const finalists = focusCandidates
      .map((candidate) => ({
        candidate,
        interimScore: candidate.score * (1 + ((relevanceById.get(candidate.id) ?? 0) * 0.5)),
      }))
      .sort((left, right) => right.interimScore - left.interimScore)
      .slice(0, Math.min(RETRIEVAL_COMPOSITION_FINALIST_LIMIT, focusCandidates.length))
      .map(item => item.candidate);
    if (finalists.length < 2) {
      return {
        relevanceById,
        finalOrder: finalists.map(candidate => candidate.id),
      };
    }

    const composeResponse = await options.llmClient.complete(
      {
        systemPrompt: buildComposePrompt(options.query, finalists),
        messages: [{ role: 'user', content: 'Compose the final retrieval ranking and return XML only.' }],
        correlation: {
          requestId: `${options.channelId}:retrieval-compose`,
          channelId: options.channelId,
          callType: 'memory',
          purpose: 'memory.retrieval.compose',
        },
      },
      'memory',
    );

    return {
      relevanceById,
      finalOrder: parseComposeResponse(
        composeResponse.content,
        finalists.map(candidate => candidate.id),
      ),
    };
  } catch {
    return null;
  }
}

function buildCandidateBatches<T>(values: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push([...values.slice(index, index + batchSize)]);
  }
  return batches;
}

function buildEvaluationPrompt(query: string, candidates: readonly RetrievalComposeCandidate[]): string {
  return `You are evaluating memory retrieval candidates for a user query.

Score each candidate for how helpful it would be to include in the assistant's retrieval context.
Return XML only:
<response>
  <candidate>
    <id>candidate-id</id>
    <relevance>0.0-1.0</relevance>
  </candidate>
</response>

Guidelines:
- Higher relevance means the memory directly helps answer the query or preserve conversation continuity.
- Lower relevance means the memory is redundant, weakly related, or distracts from the user's request.
- Prefer durable facts over generic chatter.
- Use the candidate ids exactly as given.

User query:
${sanitizePromptText(query)}

Candidates:
${candidates.map(formatPromptCandidate).join('\n\n')}`;
}

function buildComposePrompt(query: string, candidates: readonly RetrievalComposeCandidate[]): string {
  return `You are composing a final ranked shortlist of memory retrieval candidates.

Return XML only:
<response>
  <ranking>
    <id>candidate-id</id>
    <id>candidate-id</id>
  </ranking>
</response>

Rules:
- Rank candidates from most helpful to least helpful for answering the user query.
- Prefer direct relevance, durable continuity, and stable factual grounding.
- Use the candidate ids exactly as given.
- Include each candidate id at most once.

User query:
${sanitizePromptText(query)}

Finalists:
${candidates.map(formatPromptCandidate).join('\n\n')}`;
}

function formatPromptCandidate(candidate: RetrievalComposeCandidate, index: number): string {
  return [
    `Candidate ${index + 1}`,
    `id: ${candidate.id}`,
    `type: ${candidate.type}`,
    `text: ${sanitizePromptText(candidate.text, 220)}`,
    `baseline_score: ${candidate.score.toFixed(4)}`,
    `similarity: ${candidate.similarity.toFixed(4)}`,
    `importance: ${candidate.importance.toFixed(4)}`,
    `confidence: ${candidate.confidence.toFixed(4)}`,
    `salience: ${candidate.salience.toFixed(4)}`,
    `evidence_support: ${candidate.evidenceSupport.toFixed(4)}`,
    `explicitly_queried: ${candidate.explicitlyQueried ? 'yes' : 'no'}`,
  ].join('\n');
}

function parseEvaluationResponse(
  xml: string,
  allowedIds: readonly string[],
): RetrievalEvaluation[] {
  const allowedIdSet = new Set(allowedIds);
  const responseMatch = xml.match(/<response>([\s\S]*?)<\/response>/);
  if (!responseMatch) return [];

  const evaluations: RetrievalEvaluation[] = [];
  const candidateBlocks = responseMatch[1].matchAll(/<candidate>([\s\S]*?)<\/candidate>/g);
  for (const match of candidateBlocks) {
    const id = extractTag(match[1], 'id')?.trim();
    if (!id || !allowedIdSet.has(id)) continue;
    const relevance = clampScore01(Number.parseFloat(extractTag(match[1], 'relevance') ?? '0'));
    evaluations.push({ id, relevance });
  }

  return evaluations;
}

function parseComposeResponse(
  xml: string,
  fallbackOrder: readonly string[],
): string[] {
  const fallback = [...fallbackOrder];
  const responseMatch = xml.match(/<response>([\s\S]*?)<\/response>/);
  if (!responseMatch) return fallback;

  const rankingMatch = responseMatch[1].match(/<ranking>([\s\S]*?)<\/ranking>/);
  if (!rankingMatch) return fallback;

  const fallbackSet = new Set(fallback);
  const ordered = [...rankingMatch[1].matchAll(/<id>([\s\S]*?)<\/id>/g)]
    .map((match) => match[1].trim())
    .filter((id, index, values) => fallbackSet.has(id) && values.indexOf(id) === index);

  const remainder = fallback.filter(id => !ordered.includes(id));
  return [...ordered, ...remainder];
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

function clampScore01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function sanitizePromptText(value: string, maxLength = 320): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
