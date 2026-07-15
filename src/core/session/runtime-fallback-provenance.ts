import type { RuntimeFallbackProvenance } from '../../shared/contracts/runtime.js';
import { normalizeRuntimeFallbackProvenance } from '../../shared/runtime-fallback-provenance.js';
import { isRecord } from '../../shared/utils/types.js';

export const SESSION_METADATA_RUNTIME_FALLBACK_PROVENANCE_KEY = 'runtimeFallbackProvenance';

interface SessionMetadataEnvelope {
  [key: string]: unknown;
}

function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing runtime fallback provenance parsing');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for runtime fallback provenance parsing');
  }
  return parsed;
}

export function buildSessionMetadataWithRuntimeFallbackProvenance(
  existingMetadata: string | undefined,
  provenance: RuntimeFallbackProvenance,
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  return JSON.stringify({
    ...base,
    [SESSION_METADATA_RUNTIME_FALLBACK_PROVENANCE_KEY]: normalizeRuntimeFallbackProvenance(provenance),
  });
}

export function parseSessionRuntimeFallbackProvenance(
  metadata: string | undefined,
): RuntimeFallbackProvenance | null {
  const envelope = parseMetadataEnvelope(metadata);
  const raw = envelope[SESSION_METADATA_RUNTIME_FALLBACK_PROVENANCE_KEY];
  return raw === undefined
    ? null
    : normalizeRuntimeFallbackProvenance(raw, `metadata.${SESSION_METADATA_RUNTIME_FALLBACK_PROVENANCE_KEY}`);
}
