export const LLM_RESPONSE_SCHEMA_VERSION = 1 as const;
export const LLM_RESPONSE_ARTIFACT_TYPE = 'psfn.llm_response_run' as const;

export type LlmResponseProviderId = 'fixture' | 'openrouter' | 'deepseek';
export type LlmResponseCaseModality = 'chat' | 'vision' | 'fallback' | 'error';
export type LlmResponseStatus = 'ok' | 'failed';
export type LlmResponseFailureKind =
  | 'provider_error'
  | 'provider_http_error'
  | 'malformed_response'
  | 'timeout'
  | 'unsupported_case'
  | 'configuration_error';

export interface LlmResponseTarget {
  providerId: LlmResponseProviderId;
  modelId: string;
}

export interface LlmResponseCase {
  id: string;
  title: string;
  modality: LlmResponseCaseModality;
  systemPrompt?: string;
  userPrompt: string;
  imageDataUri?: string;
  maxOutputTokens: number;
  temperature: number;
  tags: string[];
}

export interface LlmResponseTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmProviderSuccess {
  status: 'ok';
  responseText: string;
  stopReason?: string;
  tokenUsage?: LlmResponseTokenUsage;
  sanitizedRawResponse?: unknown;
}

export interface LlmProviderFailure {
  status: 'failed';
  failure: LlmResponseFailure;
  sanitizedRawResponse?: unknown;
}

export type LlmProviderResult = LlmProviderSuccess | LlmProviderFailure;

export interface LlmResponseFailure {
  kind: LlmResponseFailureKind;
  message: string;
  statusCode?: number;
}

export interface LlmResponseEntry {
  caseId: string;
  caseTitle: string;
  modality: LlmResponseCaseModality;
  providerId: LlmResponseProviderId;
  modelId: string;
  status: LlmResponseStatus;
  latencyMs: number;
  stopReason?: string;
  tokenUsage?: LlmResponseTokenUsage;
  response?: {
    body: string;
    bodySha256: string;
    truncated: boolean;
    rawResponseRef?: string;
  };
  failure?: LlmResponseFailure;
}

export interface LlmResponseRunArtifact {
  schemaVersion: typeof LLM_RESPONSE_SCHEMA_VERSION;
  artifactType: typeof LLM_RESPONSE_ARTIFACT_TYPE;
  run: {
    id: string;
    capturedAt: string;
    targetCount: number;
    caseCount: number;
    liveProvidersEnabled: boolean;
  };
  targets: Array<{
    providerId: LlmResponseProviderId;
    modelId: string;
    secretSources: string[];
  }>;
  cases: Array<{
    id: string;
    title: string;
    modality: LlmResponseCaseModality;
    tags: string[];
  }>;
  responses: LlmResponseEntry[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    failuresByKind: Record<string, number>;
  };
}

export interface CompanionShapeResponseSetProjection {
  schemaVersion: 1;
  runId: string;
  capturedAt: string;
  responses: Array<{
    scenarioId: string;
    modelId: string;
    providerId: string;
    response: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    notes?: string;
  }>;
}
