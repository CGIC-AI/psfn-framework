import type { ValuesMetacognitiveFlag } from './narrative-context-types.js';

interface NarrativeContextErrorOptions {
  contextPrefix: string;
}

function buildErrorMessage(options: NarrativeContextErrorOptions, detail: string): string {
  const prefix = options.contextPrefix.trim();
  if (!prefix) return detail;
  return `${prefix} ${detail}`;
}

export function normalizeNarrativeSnapshotRef(
  raw: unknown,
  options: NarrativeContextErrorOptions,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(buildErrorMessage(options, 'internalStateSnapshotRef must be a non-empty string when provided'));
  }
  return raw.trim();
}

export function normalizeNarrativeMetacognitiveFlags(
  raw: unknown,
  options: NarrativeContextErrorOptions,
): ValuesMetacognitiveFlag[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(buildErrorMessage(options, 'metacognitiveFlags must be an array when provided'));
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(buildErrorMessage(options, `metacognitiveFlags[${String(index)}] must be an object`));
    }
    const flagRaw = (entry as { flag?: unknown }).flag;
    if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
      throw new Error(buildErrorMessage(options, `metacognitiveFlags[${String(index)}].flag must be a non-empty string`));
    }
    const confidenceRaw = (entry as { confidence?: unknown }).confidence;
    if (
      typeof confidenceRaw !== 'number'
      || !Number.isFinite(confidenceRaw)
      || confidenceRaw < 0
      || confidenceRaw > 1
    ) {
      throw new Error(buildErrorMessage(options, `metacognitiveFlags[${String(index)}].confidence must be in [0, 1]`));
    }
    const evidenceRaw = (entry as { evidence?: unknown }).evidence;
    if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
      throw new Error(buildErrorMessage(options, `metacognitiveFlags[${String(index)}].evidence must be a non-empty string`));
    }
    return {
      flag: flagRaw.trim(),
      confidence: Number(confidenceRaw.toFixed(4)),
      ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
    };
  });
}
