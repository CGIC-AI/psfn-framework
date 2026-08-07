import { isRecord } from '../../../shared/utils/types.js';
import {
  toBoolean,
  toInterval,
  toPositiveInteger,
  toUnitFactor,
} from './primitives.js';

export interface IntrospectionAuditConfig {
  enabled: boolean;
  intervalMs: number;
  recentSessionLimit: number;
  recentTurnLimit: number;
  maxCandidatesPerRun: number;
  maxSourceChars: number;
  minConfidence: number;
  estimatorMaxTokens: number;
  comparisonMaxTokens: number;
  reflectionMaxTokens: number;
}

export const DEFAULT_INTROSPECTION_AUDIT_CONFIG: IntrospectionAuditConfig = {
  enabled: false,
  intervalMs: 86_400_000,
  recentSessionLimit: 16,
  recentTurnLimit: 64,
  maxCandidatesPerRun: 3,
  maxSourceChars: 4_000,
  minConfidence: 0.7,
  estimatorMaxTokens: 500,
  comparisonMaxTokens: 300,
  reflectionMaxTokens: 300,
};

export function validateIntrospectionAuditConfig(
  value: unknown,
  sourcePath: string,
): IntrospectionAuditConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: introspectionAudit must be an object`);
  }
  return {
    enabled: toBoolean(value.enabled, 'introspectionAudit.enabled'),
    intervalMs: toInterval(value.intervalMs, 'introspectionAudit.intervalMs'),
    recentSessionLimit: toPositiveInteger(value.recentSessionLimit, 'introspectionAudit.recentSessionLimit', 1),
    recentTurnLimit: toPositiveInteger(value.recentTurnLimit, 'introspectionAudit.recentTurnLimit', 1),
    maxCandidatesPerRun: toPositiveInteger(value.maxCandidatesPerRun, 'introspectionAudit.maxCandidatesPerRun', 1),
    maxSourceChars: toPositiveInteger(value.maxSourceChars, 'introspectionAudit.maxSourceChars', 256),
    minConfidence: toUnitFactor(value.minConfidence, 'introspectionAudit.minConfidence'),
    estimatorMaxTokens: toPositiveInteger(value.estimatorMaxTokens, 'introspectionAudit.estimatorMaxTokens', 64),
    comparisonMaxTokens: toPositiveInteger(value.comparisonMaxTokens, 'introspectionAudit.comparisonMaxTokens', 64),
    reflectionMaxTokens: toPositiveInteger(value.reflectionMaxTokens, 'introspectionAudit.reflectionMaxTokens', 64),
  };
}
