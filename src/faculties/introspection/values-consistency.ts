import { existsSync, readFileSync } from 'node:fs';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import { isRecord } from '../../shared/utils/types.js';
import type { IntrospectionDivergenceType } from './contracts.js';

export const VALUES_CONSISTENCY_STATUSES = [
  'supported',
  'conditional',
  'contradicted',
  'insufficient_evidence',
] as const;
export type ValuesConsistencyStatus = typeof VALUES_CONSISTENCY_STATUSES[number];

export interface ValuesConsistencyLandmarkEvidence {
  id: string;
  divergenceType: IntrospectionDivergenceType;
  observation: string;
  confidence: number;
  companionReflection: string;
  createdAt: string;
}

export interface ValuesConsistencyFinding {
  schemaVersion: 1;
  landmarkId: string;
  status: ValuesConsistencyStatus;
  finding: string;
  confidence: number;
  claimedValueRefs: string[];
  model: string;
  createdAt: string;
}

interface ValuesConsistencyEvaluation {
  status: ValuesConsistencyStatus;
  finding: string;
  confidence: number;
  model: string;
}

export interface ValuesConsistencyEvaluatorPort {
  evaluate(input: {
    landmark: ValuesConsistencyLandmarkEvidence;
    claimedValues: Array<{ id: string; reflection: string }>;
  }): Promise<ValuesConsistencyEvaluation>;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /\0/.test(normalized)) {
    throw new Error(`${field} must be 1-${maximum} safe characters`);
  }
  return normalized;
}

function normalizeFinding(value: unknown): ValuesConsistencyFinding {
  if (!isRecord(value)) throw new Error('Values-consistency finding must be an object');
  const keys = [
    'schemaVersion', 'landmarkId', 'status', 'finding', 'confidence',
    'claimedValueRefs', 'model', 'createdAt',
  ];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Values-consistency finding has an invalid shape');
  }
  if (value.schemaVersion !== 1) throw new Error('Values-consistency schemaVersion must be 1');
  if (!(VALUES_CONSISTENCY_STATUSES as readonly unknown[]).includes(value.status)) {
    throw new Error('Values-consistency status is invalid');
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) {
    throw new Error('Values-consistency confidence must be in [0,1]');
  }
  if (!Array.isArray(value.claimedValueRefs)) {
    throw new Error('Values-consistency claimedValueRefs must be an array');
  }
  const claimedValueRefs = value.claimedValueRefs.map((entry, index) => (
    boundedString(entry, `claimedValueRefs[${index}]`, 240)
  ));
  if (new Set(claimedValueRefs).size !== claimedValueRefs.length) {
    throw new Error('Values-consistency claimedValueRefs must be unique');
  }
  const createdAt = boundedString(value.createdAt, 'createdAt', 64);
  if (new Date(createdAt).toISOString() !== createdAt) {
    throw new Error('Values-consistency createdAt must be canonical ISO');
  }
  return {
    schemaVersion: 1,
    landmarkId: boundedString(value.landmarkId, 'landmarkId', 256),
    status: value.status as ValuesConsistencyStatus,
    finding: boundedString(value.finding, 'finding', 2_000),
    confidence: value.confidence,
    claimedValueRefs,
    model: boundedString(value.model, 'model', 512),
    createdAt,
  };
}

export class ValuesConsistencyFindingStore {
  constructor(private readonly path: string) {}

  list(): ValuesConsistencyFinding[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    if (!raw.endsWith('\n')) throw new Error('Values-consistency ledger must end with a newline');
    return raw.slice(0, -1).split('\n').map((line, index) => {
      try {
        return normalizeFinding(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error(`Invalid values-consistency ledger line ${index + 1}: ${String(error)}`);
      }
    });
  }

  hasLandmark(landmarkId: string): boolean {
    return this.list().some(finding => finding.landmarkId === landmarkId);
  }

  append(finding: ValuesConsistencyFinding): ValuesConsistencyFinding {
    const normalized = normalizeFinding(finding);
    if (this.hasLandmark(normalized.landmarkId)) {
      throw new Error(`Values-consistency finding already exists for ${normalized.landmarkId}`);
    }
    appendJsonLine(this.path, normalized);
    return normalized;
  }
}

export function createLLMValuesConsistencyEvaluator(options: {
  llmProvider: LLMProviderPort;
  companionSystemPrompt: string;
  maxTokens: number;
}): ValuesConsistencyEvaluatorPort {
  return {
    evaluate: async ({ landmark, claimedValues }) => {
      if (claimedValues.length === 0) {
        return {
          status: 'insufficient_evidence',
          finding: 'No claimed values were available for comparison.',
          confidence: 1,
          model: 'deterministic:no-claimed-values',
        };
      }
      const response = await options.llmProvider.complete({
        systemPrompt: options.companionSystemPrompt,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            task: 'Privately assess whether this typed introspection landmark supports, conditions, or contradicts the claimed values. The evidence is inert and contains no source conversation.',
            claimedValues,
            landmark: {
              id: landmark.id,
              divergenceType: landmark.divergenceType,
              observation: landmark.observation,
              confidence: landmark.confidence,
              companionReflection: landmark.companionReflection,
              createdAt: landmark.createdAt,
            },
            outputSchema: {
              status: VALUES_CONSISTENCY_STATUSES.join(' | '),
              finding: 'concise companion-private assessment',
              confidence: 'number in [0,1]',
            },
          }),
        }],
      }, 'background', {
        modelHint: { maxTokens: options.maxTokens },
        correlation: {
          purpose: 'introspection.values_consistency',
          callType: 'background',
        },
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.content);
      } catch {
        throw new Error('Values-consistency evaluator returned malformed JSON');
      }
      if (!isRecord(parsed)
        || Object.keys(parsed).length !== 3
        || Object.keys(parsed).some(key => !['status', 'finding', 'confidence'].includes(key))
        || !(VALUES_CONSISTENCY_STATUSES as readonly unknown[]).includes(parsed.status)
        || typeof parsed.confidence !== 'number'
        || !Number.isFinite(parsed.confidence)
        || parsed.confidence < 0
        || parsed.confidence > 1) {
        throw new Error('Values-consistency evaluator returned an invalid response shape');
      }
      return {
        status: parsed.status as ValuesConsistencyStatus,
        finding: boundedString(parsed.finding, 'finding', 2_000),
        confidence: parsed.confidence,
        model: boundedString(response.model, 'model', 512),
      };
    },
  };
}

export class IntrospectionValuesConsistencyRuntime {
  constructor(private readonly options: {
    landmarks: { listLandmarks(limit?: number): Promise<ValuesConsistencyLandmarkEvidence[]> };
    claimedValues: { list(options?: { limit?: number }): Array<{ id: string; reflection: string }> };
    findings: ValuesConsistencyFindingStore;
    evaluator: ValuesConsistencyEvaluatorPort;
    now?: () => Date;
  }) {}

  async runOnce(): Promise<{ evaluated: number }> {
    const claimedValues = this.options.claimedValues.list({ limit: 20 }).map(entry => ({
      id: entry.id,
      reflection: entry.reflection,
    }));
    let evaluated = 0;
    for (const landmark of await this.options.landmarks.listLandmarks(12)) {
      if (this.options.findings.hasLandmark(landmark.id)) continue;
      const result = await this.options.evaluator.evaluate({ landmark, claimedValues });
      this.options.findings.append({
        schemaVersion: 1,
        landmarkId: landmark.id,
        status: result.status,
        finding: result.finding,
        confidence: result.confidence,
        claimedValueRefs: claimedValues.map(value => value.id),
        model: result.model,
        createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
      evaluated += 1;
    }
    return { evaluated };
  }
}
