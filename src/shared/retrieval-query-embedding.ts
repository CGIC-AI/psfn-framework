import { createHash } from 'node:crypto';
import { requireNonEmptyString } from './utils/strings.js';

export interface RetrievalQueryEmbeddingProvenance {
  provider: string;
  model: string;
  dimensions: number;
}

export interface RetrievalQueryEmbeddingExpected {
  turnId: string;
  requestId: string;
  companionId: string;
  channelId: string;
  canonicalContactId?: string;
  queryText: string;
  provenance: RetrievalQueryEmbeddingProvenance;
}

export interface TurnRetrievalQueryEmbedding {
  readonly turnId: string;
  readonly requestId: string;
  readonly companionId: string;
  readonly channelId: string;
  readonly canonicalContactId?: string;
  readonly queryHash: string;
  readonly provenance: RetrievalQueryEmbeddingProvenance;
  resolve(expected: RetrievalQueryEmbeddingExpected): Promise<Float32Array>;
}

export interface CreateTurnRetrievalQueryEmbeddingInput extends RetrievalQueryEmbeddingExpected {
  embed(text: string): Promise<Float32Array>;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function hashQuery(queryText: string): string {
  return createHash('sha256').update(queryText, 'utf8').digest('hex');
}

function normalizeProvenance(
  provenance: RetrievalQueryEmbeddingProvenance,
): RetrievalQueryEmbeddingProvenance {
  const dimensions = provenance.dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error('Turn retrieval query embedding dimensions must be a positive safe integer');
  }
  return {
    provider: requireNonEmptyString(provenance.provider, 'provider'),
    model: requireNonEmptyString(provenance.model, 'model'),
    dimensions,
  };
}

function provenanceMatches(
  left: RetrievalQueryEmbeddingProvenance,
  right: RetrievalQueryEmbeddingProvenance,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.dimensions === right.dimensions;
}

export function createTurnRetrievalQueryEmbedding(
  input: CreateTurnRetrievalQueryEmbeddingInput,
): TurnRetrievalQueryEmbedding {
  const turnId = requireNonEmptyString(input.turnId, 'turnId');
  const requestId = requireNonEmptyString(input.requestId, 'requestId');
  const companionId = requireNonEmptyString(input.companionId, 'companionId');
  const channelId = requireNonEmptyString(input.channelId, 'channelId');
  const canonicalContactId = normalizeOptional(input.canonicalContactId);
  const queryText = input.queryText;
  const queryHash = hashQuery(queryText);
  const provenance = normalizeProvenance(input.provenance);
  let embeddingPromise: Promise<Float32Array> | undefined;

  const resolve = async (expected: RetrievalQueryEmbeddingExpected): Promise<Float32Array> => {
    const expectedProvenance = normalizeProvenance(expected.provenance);
    if (
      requireNonEmptyString(expected.turnId, 'turnId') !== turnId
      || requireNonEmptyString(expected.requestId, 'requestId') !== requestId
      || requireNonEmptyString(expected.companionId, 'companionId') !== companionId
      || requireNonEmptyString(expected.channelId, 'channelId') !== channelId
      || normalizeOptional(expected.canonicalContactId) !== canonicalContactId
      || hashQuery(expected.queryText) !== queryHash
      || !provenanceMatches(expectedProvenance, provenance)
    ) {
      throw new Error('Turn retrieval query embedding provenance mismatch');
    }

    embeddingPromise ??= input.embed(queryText).then((embedding) => {
      if (!(embedding instanceof Float32Array)) {
        throw new Error('Turn retrieval query embedding provider returned a non-Float32Array value');
      }
      if (embedding.length !== provenance.dimensions) {
        throw new Error(
          `Turn retrieval query embedding dimension mismatch: expected ${provenance.dimensions}, got ${embedding.length}`,
        );
      }
      if (Array.from(embedding).some(value => !Number.isFinite(value))) {
        throw new Error('Turn retrieval query embedding provider returned non-finite values');
      }
      return new Float32Array(embedding);
    });

    return new Float32Array(await embeddingPromise);
  };

  return {
    turnId,
    requestId,
    companionId,
    channelId,
    ...(canonicalContactId ? { canonicalContactId } : {}),
    queryHash,
    provenance,
    resolve,
  };
}
