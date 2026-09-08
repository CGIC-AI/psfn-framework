// ── Durable per-block context source manifest (psfn-framework-ccgdz.4) ──
//
// `TurnRecord.contextManifestRef` used to be a synthesized display string
// (`session:<channelId>|messages:<n>|memory_chars:<n>`) written as if it were a
// reference. It resolved to nothing, and the real `ContextManifest` is counts
// and budgets with no per-item source identity. Prompt assembly took blocks
// built from IDENTIFIED sources — retrieved memories, admitted wiki documents,
// biographical claims — and shipped them as anonymous text.
//
// A `ContextSourceManifest` is the durable answer to "which identified sources
// were rendered into the prompt that produced this generation, and into which
// block?". It mints NO new identifier: like the custody snapshot beside it, the
// key is `turn:<turnId>`.
//
// It is deliberately NOT part of `CustodySnapshot`. The custody snapshot's
// content digest drives first-write-wins divergence detection, and a recovered
// turn re-assembles its prompt (a new datetime anchor, already-drained
// completion notices), so per-block text hashes legitimately differ across a
// replay. Folding the manifest in would turn every recovery into a spurious
// `diverged` custody error.
//
// CONTENT-FREE BY CONSTRUCTION, on the custody-snapshot rules: every field is
// an id, a hash, a count, a closed-vocabulary label, or a bounded identifier,
// and every free-form runtime string goes through `custodyIdentity` — hashed
// always, kept literally only when it structurally cannot carry prose. The
// block's own text is present ONLY as a sha256: identity, never content.

import { createHash } from 'node:crypto';

import { isRecord } from '../../../shared/utils/types.js';
import { normalizeCogSecStructuredProvenanceRef } from '../../../shared/contracts/provenance-ref.js';
import {
  custodyIdentity,
  custodyRefForTurn,
  custodySha256,
  validateCustodyIdentity,
  type CustodyIdentity,
} from './custody-identity.js';

const CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION = 1;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_BOUNDED_TOKEN_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

/**
 * Block placement vocabularies, mirrored from `PromptPlanBlock`. Redeclared
 * here rather than imported so a persisted manifest can never widen a stored
 * vocabulary from a later runtime change without a schema bump.
 */
const MANIFEST_BLOCK_LAYERS = ['prompt_stack', 'runtime', 'session', 'provider'] as const;
const MANIFEST_BLOCK_VOLATILITIES = ['static', 'session_stable', 'turn'] as const;

type ContextSourceManifestLayer = typeof MANIFEST_BLOCK_LAYERS[number];
type ContextSourceManifestVolatility = typeof MANIFEST_BLOCK_VOLATILITIES[number];

/**
 * One identified source rendered into one block. `ref` carries the source's
 * runtime reference (`memory:<id>`, `wiki:<docId>`, `bio:<claimId>`) bound the
 * custody way; the admission fields carry the same evidence as
 * `CogSecStructuredProvenanceRef` (psfn-framework-ccgdz.3).
 */
interface ContextSourceManifestSource {
  readonly kind: string;
  readonly ref: CustodyIdentity;
  readonly receiptId?: string;
  readonly contentSha256?: string;
  readonly envelopeId?: string;
}

interface ContextSourceManifestBlock {
  readonly blockId: CustodyIdentity;
  readonly layer: ContextSourceManifestLayer;
  readonly volatility: ContextSourceManifestVolatility;
  readonly producer: CustodyIdentity;
  readonly scopeKey?: CustodyIdentity;
  readonly tokensEst: number;
  /** sha256 of the exact rendered block text. Identity, never the text. */
  readonly renderedTextSha256: string;
  readonly sources: readonly ContextSourceManifestSource[];
}

export interface ContextSourceManifest {
  readonly schemaVersion: typeof CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION;
  readonly generationContextRef: string;
  readonly turnId: string;
  /** Every ordered block, in the exact order it serialized to the provider. */
  readonly blocks: readonly ContextSourceManifestBlock[];
  /** Blocks that listed at least one identified source. */
  readonly sourcedBlockCount: number;
  readonly sourceCount: number;
}

/** The manifest key for a turn. Shares the custody snapshot's ref exactly. */
export function contextSourceManifestRefForTurn(turnId: string): string {
  return custodyRefForTurn(turnId);
}

/** The shape prompt assembly hands in: one plan block's content-free facts. */
export interface ContextSourceManifestBlockInput {
  id: string;
  layer: string;
  volatility: string;
  producer: string;
  scopeKey?: string;
  tokensEst: number;
  renderedText: string;
  sources?: readonly {
    kind: string;
    refId: string;
    receiptId?: string;
    contentSha256?: string;
    envelopeId?: string;
  }[];
}

function isManifestLayer(value: unknown): value is ContextSourceManifestLayer {
  return typeof value === 'string'
    && (MANIFEST_BLOCK_LAYERS as readonly string[]).includes(value);
}

function isManifestVolatility(value: unknown): value is ContextSourceManifestVolatility {
  return typeof value === 'string'
    && (MANIFEST_BLOCK_VOLATILITIES as readonly string[]).includes(value);
}

function invalid(field: string, requirement: string): Error {
  return new Error(`Context source manifest ${field} ${requirement}`);
}

function buildSource(
  source: NonNullable<ContextSourceManifestBlockInput['sources']>[number],
): ContextSourceManifestSource | null {
  // The one shared normalizer keeps a manifest source and a memory/episode ref
  // from ever disagreeing about what a valid identity looks like. A ref with an
  // unusable kind/refId is dropped; a malformed identity field is dropped alone,
  // which loses verification rather than asserting it.
  const normalized = normalizeCogSecStructuredProvenanceRef(source);
  if (!normalized) return null;
  return {
    kind: normalized.kind,
    ref: custodyIdentity(normalized.refId),
    ...(normalized.receiptId ? { receiptId: normalized.receiptId } : {}),
    ...(normalized.contentSha256 ? { contentSha256: normalized.contentSha256 } : {}),
    ...(normalized.envelopeId ? { envelopeId: normalized.envelopeId } : {}),
  };
}

/**
 * Serialize one turn's assembled prompt plan into its durable source manifest.
 *
 * Every ordered block is recorded, not only the sourced ones: a block that
 * rendered text and listed NO source is exactly the gap an audit needs to see,
 * and omitting it would make an unsourced prompt look like a short one.
 */
export function buildContextSourceManifest(input: {
  turnId: string;
  blocks: readonly ContextSourceManifestBlockInput[];
}): ContextSourceManifest {
  const blocks = input.blocks.map((block): ContextSourceManifestBlock => {
    if (!isManifestLayer(block.layer)) {
      throw invalid(`blocks[${block.id}].layer`, 'must be a known prompt plan layer');
    }
    if (!isManifestVolatility(block.volatility)) {
      throw invalid(`blocks[${block.id}].volatility`, 'must be a known prompt plan volatility');
    }
    const sources = (block.sources ?? [])
      .map(buildSource)
      .filter((source): source is ContextSourceManifestSource => source !== null);
    const scopeKey = block.scopeKey?.trim();
    return {
      blockId: custodyIdentity(block.id),
      layer: block.layer,
      volatility: block.volatility,
      producer: custodyIdentity(block.producer),
      ...(scopeKey ? { scopeKey: custodyIdentity(scopeKey) } : {}),
      tokensEst: block.tokensEst,
      renderedTextSha256: custodySha256(block.renderedText),
      sources,
    };
  });
  return validateContextSourceManifest({
    schemaVersion: CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION,
    generationContextRef: contextSourceManifestRefForTurn(input.turnId),
    turnId: input.turnId,
    blocks,
    sourcedBlockCount: blocks.filter(block => block.sources.length > 0).length,
    sourceCount: blocks.reduce((total, block) => total + block.sources.length, 0),
  });
}

/**
 * Identity digest of a manifest's content. Unlike the custody snapshot there is
 * no excluded field: the manifest IS the assembled prompt's source shape, so
 * two manifests differ exactly when the assembled prompt differed.
 */
export function contextSourceManifestContentDigest(
  manifest: ContextSourceManifest,
): string {
  return createHash('sha256')
    .update(JSON.stringify(manifest), 'utf8')
    .digest('hex');
}

function validateCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(field, 'must be a non-negative safe integer');
  }
  return value as number;
}

function validateOptionalBoundedToken(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MANIFEST_BOUNDED_TOKEN_PATTERN.test(value)) {
    throw invalid(field, 'must be a bounded safe identifier');
  }
  return value;
}

function validateSource(value: unknown, field: string): ContextSourceManifestSource {
  if (!isRecord(value)) throw invalid(field, 'must be an object');
  if (typeof value.kind !== 'string' || !MANIFEST_BOUNDED_TOKEN_PATTERN.test(value.kind)) {
    throw invalid(`${field}.kind`, 'must be a bounded safe identifier');
  }
  if (value.contentSha256 !== undefined
    && (typeof value.contentSha256 !== 'string'
      || !SHA256_HEX_PATTERN.test(value.contentSha256))) {
    throw invalid(`${field}.contentSha256`, 'must be 64 lowercase hex characters');
  }
  const receiptId = validateOptionalBoundedToken(value.receiptId, `${field}.receiptId`);
  const envelopeId = validateOptionalBoundedToken(value.envelopeId, `${field}.envelopeId`);
  return {
    kind: value.kind,
    ref: validateCustodyIdentity(value.ref, `${field}.ref`),
    ...(receiptId ? { receiptId } : {}),
    ...(value.contentSha256 !== undefined
      ? { contentSha256: value.contentSha256 as string }
      : {}),
    ...(envelopeId ? { envelopeId } : {}),
  };
}

function validateBlock(value: unknown, index: number): ContextSourceManifestBlock {
  const field = `blocks[${index}]`;
  if (!isRecord(value)) throw invalid(field, 'must be an object');
  if (!isManifestLayer(value.layer)) {
    throw invalid(`${field}.layer`, 'must be a known prompt plan layer');
  }
  if (!isManifestVolatility(value.volatility)) {
    throw invalid(`${field}.volatility`, 'must be a known prompt plan volatility');
  }
  if (typeof value.renderedTextSha256 !== 'string'
    || !SHA256_HEX_PATTERN.test(value.renderedTextSha256)) {
    throw invalid(`${field}.renderedTextSha256`, 'must be 64 lowercase hex characters');
  }
  if (!Array.isArray(value.sources)) throw invalid(`${field}.sources`, 'must be an array');
  return {
    blockId: validateCustodyIdentity(value.blockId, `${field}.blockId`),
    layer: value.layer,
    volatility: value.volatility,
    producer: validateCustodyIdentity(value.producer, `${field}.producer`),
    ...(value.scopeKey !== undefined
      ? { scopeKey: validateCustodyIdentity(value.scopeKey, `${field}.scopeKey`) }
      : {}),
    tokensEst: validateCount(value.tokensEst, `${field}.tokensEst`),
    renderedTextSha256: value.renderedTextSha256,
    sources: value.sources.map(
      (source, sourceIndex) => validateSource(source, `${field}.sources[${sourceIndex}]`),
    ),
  };
}

/**
 * Re-validate on every read as well as every write (the custody-snapshot
 * posture): a row edited in the database is a load failure, never a quiet
 * claim about what the prompt was assembled from.
 */
export function validateContextSourceManifest(value: unknown): ContextSourceManifest {
  if (!isRecord(value)) throw invalid('record', 'must be an object');
  if (value.schemaVersion !== CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION) {
    throw invalid('schemaVersion', `must be ${CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof value.turnId !== 'string'
    || !MANIFEST_BOUNDED_TOKEN_PATTERN.test(value.turnId)) {
    throw invalid('turnId', 'must be a bounded safe identifier');
  }
  if (value.generationContextRef !== contextSourceManifestRefForTurn(value.turnId)) {
    throw invalid('generationContextRef', 'must be turn:<turnId>');
  }
  if (!Array.isArray(value.blocks)) throw invalid('blocks', 'must be an array');
  const blocks = value.blocks.map((block, index) => validateBlock(block, index));
  const sourcedBlockCount = validateCount(value.sourcedBlockCount, 'sourcedBlockCount');
  const sourceCount = validateCount(value.sourceCount, 'sourceCount');
  if (sourcedBlockCount !== blocks.filter(block => block.sources.length > 0).length) {
    throw invalid('sourcedBlockCount', 'must match the blocks that list sources');
  }
  if (sourceCount !== blocks.reduce((total, block) => total + block.sources.length, 0)) {
    throw invalid('sourceCount', 'must match the total listed sources');
  }
  return {
    schemaVersion: CONTEXT_SOURCE_MANIFEST_SCHEMA_VERSION,
    generationContextRef: value.generationContextRef,
    turnId: value.turnId,
    blocks,
    sourcedBlockCount,
    sourceCount,
  };
}

/** Outcome of recording one manifest; mirrors the custody snapshot's. */
export type ContextSourceManifestRecordOutcome =
  | 'recorded'
  | 'duplicate'
  /**
   * A DIFFERENT manifest already stood for this generation context. The stored
   * one is kept — it describes the prompt that actually produced the reply —
   * and the caller surfaces the divergence rather than overwriting it.
   */
  | 'diverged';
