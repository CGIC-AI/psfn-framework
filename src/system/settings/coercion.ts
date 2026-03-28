import type {
  ImportProcessingRouteMode,
  SessionRestartBehavior,
  SubstrateConfig,
} from '../../types.js';
import {
  isStreamingSttProvider,
} from '../../voice/connectors/stt/index.js';
import {
  isStreamingTtsProvider,
} from '../../voice/connectors/tts/index.js';

const IMPORT_PROCESSING_ROUTE_MODE_VALUES = new Set<ImportProcessingRouteMode>([
  'background',
  'openrouter_zdr',
  'local_endpoint',
]);

const SESSION_RESTART_BEHAVIOR_VALUES = new Set<SessionRestartBehavior>([
  'reuse_latest_session',
  'new_session',
]);
const EMBEDDING_PROVIDER_VALUES = new Set<NonNullable<SubstrateConfig['embeddingProvider']>>([
  'ollama',
  'transformers',
  'api',
]);

type RuntimeVoiceTtsProvider = Exclude<SubstrateConfig['ttsProvider'], undefined>;
type RuntimeVoiceSttProvider = Exclude<SubstrateConfig['sttProvider'], undefined>;

export function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function toIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = Number.isInteger(value) ? value : undefined;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const candidate = Number.parseInt(trimmed, 10);
    parsed = Number.isInteger(candidate) ? candidate : undefined;
  }

  if (parsed === undefined) return undefined;
  return parsed >= min && parsed <= max ? parsed : undefined;
}

export function toNumberInRange(value: unknown, min: number, max: number): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = Number.isFinite(value) ? value : undefined;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const candidate = Number.parseFloat(trimmed);
    parsed = Number.isFinite(candidate) ? candidate : undefined;
  }

  if (parsed === undefined) return undefined;
  return parsed >= min && parsed <= max ? parsed : undefined;
}

export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = [...new Set(value
    .map(entry => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean))];
  return cleaned;
}

export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

export function normalizeTtsProvider(value: unknown): RuntimeVoiceTtsProvider | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase() as RuntimeVoiceTtsProvider;
}

export function toConfiguredTtsProvider(value: unknown): RuntimeVoiceTtsProvider | undefined {
  const normalized = normalizeTtsProvider(value);
  if (!normalized) return undefined;
  if (normalized === 'disabled' || isStreamingTtsProvider(normalized)) {
    return normalized;
  }
  return undefined;
}

export function normalizeSttProvider(value: unknown): RuntimeVoiceSttProvider | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase() as RuntimeVoiceSttProvider;
}

export function toConfiguredSttProvider(value: unknown): RuntimeVoiceSttProvider | undefined {
  const normalized = normalizeSttProvider(value);
  if (!normalized) return undefined;
  if (normalized === 'disabled' || isStreamingSttProvider(normalized)) {
    return normalized;
  }
  return undefined;
}

export function resolveRuntimeTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const configured = normalizeTtsProvider(config.ttsProvider);
  return configured ?? 'disabled';
}

export function resolveRuntimeSttProvider(config: SubstrateConfig): RuntimeVoiceSttProvider {
  const configured = normalizeSttProvider(config.sttProvider);
  return configured ?? 'disabled';
}

export function toImportProcessingRouteMode(value: unknown): ImportProcessingRouteMode | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!IMPORT_PROCESSING_ROUTE_MODE_VALUES.has(trimmed as ImportProcessingRouteMode)) return undefined;
  return trimmed as ImportProcessingRouteMode;
}

export function toSessionRestartBehavior(value: unknown): SessionRestartBehavior | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!SESSION_RESTART_BEHAVIOR_VALUES.has(trimmed as SessionRestartBehavior)) return undefined;
  return trimmed as SessionRestartBehavior;
}

export function toEmbeddingProvider(
  value: unknown,
): NonNullable<SubstrateConfig['embeddingProvider']> | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!EMBEDDING_PROVIDER_VALUES.has(trimmed as NonNullable<SubstrateConfig['embeddingProvider']>)) {
    return undefined;
  }
  return trimmed as NonNullable<SubstrateConfig['embeddingProvider']>;
}

function toStrictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[+\-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toStrictNumberInRange(value: unknown, min: number, max: number): number | undefined {
  const parsed = toStrictFiniteNumber(value);
  if (parsed === undefined) return undefined;
  return parsed >= min && parsed <= max ? parsed : undefined;
}

export function toStrictIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = Number.isInteger(value) ? value : undefined;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!/^[+\-]?\d+$/.test(trimmed)) return undefined;
    parsed = Number.parseInt(trimmed, 10);
  }

  if (parsed === undefined) return undefined;
  return parsed >= min && parsed <= max ? parsed : undefined;
}
