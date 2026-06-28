import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CANONICAL_LLM_RESPONSE_CASES } from './cases.js';
import { invokeProvider, type InvokeProviderOptions } from './providers.js';
import { collectEnvSecrets, redactSecrets, redactString } from './redaction.js';
import { isLiveProvider, secretSourceNamesForTarget } from './targets.js';
import {
  LLM_RESPONSE_ARTIFACT_TYPE,
  LLM_RESPONSE_SCHEMA_VERSION,
  type CompanionShapeResponseSetProjection,
  type LlmProviderResult,
  type LlmResponseCase,
  type LlmResponseEntry,
  type LlmResponseRunArtifact,
  type LlmResponseTarget,
} from './types.js';

const DEFAULT_RESPONSE_BODY_LIMIT = 12_000;

export interface CollectLlmResponseOptions {
  runId: string;
  targets: LlmResponseTarget[];
  cases?: LlmResponseCase[];
  outputDir?: string;
  liveProvidersEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  generatedAt?: string;
  invokeProviderFn?: (options: InvokeProviderOptions) => Promise<LlmProviderResult>;
}

export async function collectLlmResponses(options: CollectLlmResponseOptions): Promise<LlmResponseRunArtifact> {
  const env = options.env ?? process.env;
  const secrets = collectEnvSecrets(env);
  const evalCases = options.cases ?? CANONICAL_LLM_RESPONSE_CASES;
  const liveProvidersEnabled = options.liveProvidersEnabled ?? false;
  const responses: LlmResponseEntry[] = [];
  const invoke = options.invokeProviderFn ?? invokeProvider;
  const rawResponseDir = options.outputDir ? path.join(options.outputDir, 'raw-responses') : undefined;

  if (options.targets.length === 0) {
    throw new Error('At least one target is required');
  }
  for (const target of options.targets) {
    if (isLiveProvider(target.providerId) && !liveProvidersEnabled) {
      throw new Error(`Live provider "${target.providerId}" requires explicit --live opt-in`);
    }
  }
  if (rawResponseDir) {
    mkdirSync(rawResponseDir, { recursive: true });
  }

  for (const target of options.targets) {
    for (const evalCase of evalCases) {
      const started = performance.now();
      const result = await invoke({
        target,
        evalCase,
        env,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
      });
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      const entry = buildResponseEntry({
        runId: options.runId,
        target,
        evalCase,
        result,
        latencyMs,
        rawResponseDir,
        secrets,
      });
      responses.push(entry);
    }
  }

  const artifact: LlmResponseRunArtifact = {
    schemaVersion: LLM_RESPONSE_SCHEMA_VERSION,
    artifactType: LLM_RESPONSE_ARTIFACT_TYPE,
    run: {
      id: options.runId,
      capturedAt: options.generatedAt ?? new Date().toISOString(),
      targetCount: options.targets.length,
      caseCount: evalCases.length,
      liveProvidersEnabled,
    },
    targets: options.targets.map((target) => ({
      providerId: target.providerId,
      modelId: target.modelId,
      secretSources: secretSourceNamesForTarget(target),
    })),
    cases: evalCases.map((evalCase) => ({
      id: evalCase.id,
      title: evalCase.title,
      modality: evalCase.modality,
      tags: [...evalCase.tags],
    })),
    responses,
    summary: summarizeResponses(responses),
  };

  return redactSecrets(artifact, secrets);
}

export function writeLlmResponseArtifact(artifact: LlmResponseRunArtifact, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${safeFilePart(artifact.run.id)}.json`);
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function projectCompanionShapeResponseSet(artifact: LlmResponseRunArtifact): CompanionShapeResponseSetProjection {
  return {
    schemaVersion: 1,
    runId: artifact.run.id,
    capturedAt: artifact.run.capturedAt,
    responses: artifact.responses
      .filter((entry) => entry.status === 'ok' && entry.response)
      .map((entry) => ({
        scenarioId: entry.caseId,
        modelId: entry.modelId,
        providerId: entry.providerId,
        response: entry.response?.body ?? '',
        latencyMs: entry.latencyMs,
        ...(entry.tokenUsage?.inputTokens === undefined ? {} : { inputTokens: entry.tokenUsage.inputTokens }),
        ...(entry.tokenUsage?.outputTokens === undefined ? {} : { outputTokens: entry.tokenUsage.outputTokens }),
        notes: `Projected from ${LLM_RESPONSE_ARTIFACT_TYPE}`,
      })),
  };
}

function buildResponseEntry(params: {
  runId: string;
  target: LlmResponseTarget;
  evalCase: LlmResponseCase;
  result: LlmProviderResult;
  latencyMs: number;
  rawResponseDir?: string;
  secrets: ReturnType<typeof collectEnvSecrets>;
}): LlmResponseEntry {
  const base = {
    caseId: params.evalCase.id,
    caseTitle: params.evalCase.title,
    modality: params.evalCase.modality,
    providerId: params.target.providerId,
    modelId: params.target.modelId,
    latencyMs: params.latencyMs,
  };

  if (params.result.status === 'failed') {
    writeRawResponseIfPresent(params);
    return {
      ...base,
      status: 'failed',
      failure: params.result.failure,
    };
  }

  const redactedBody = redactString(params.result.responseText, params.secrets);
  const truncated = redactedBody.length > DEFAULT_RESPONSE_BODY_LIMIT;
  const body = truncated ? redactedBody.slice(0, DEFAULT_RESPONSE_BODY_LIMIT) : redactedBody;
  const rawResponseRef = writeRawResponseIfPresent(params);

  return {
    ...base,
    status: 'ok',
    ...(params.result.stopReason ? { stopReason: params.result.stopReason } : {}),
    ...(params.result.tokenUsage ? { tokenUsage: params.result.tokenUsage } : {}),
    response: {
      body,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      truncated,
      ...(rawResponseRef ? { rawResponseRef } : {}),
    },
  };
}

function writeRawResponseIfPresent(params: {
  runId: string;
  target: LlmResponseTarget;
  evalCase: LlmResponseCase;
  result: LlmProviderResult;
  rawResponseDir?: string;
  secrets: ReturnType<typeof collectEnvSecrets>;
}): string | undefined {
  if (!params.rawResponseDir || params.result.sanitizedRawResponse === undefined) {
    return undefined;
  }
  const fileName = [
    safeFilePart(params.runId),
    safeFilePart(params.target.providerId),
    safeFilePart(params.target.modelId),
    safeFilePart(params.evalCase.id),
    'raw.json',
  ].join('__');
  const absolutePath = path.join(params.rawResponseDir, fileName);
  const sanitized = redactSecrets(params.result.sanitizedRawResponse, params.secrets);
  writeFileSync(absolutePath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  return path.relative(path.dirname(params.rawResponseDir), absolutePath);
}

function summarizeResponses(responses: readonly LlmResponseEntry[]): LlmResponseRunArtifact['summary'] {
  const failuresByKind: Record<string, number> = {};
  for (const response of responses) {
    if (response.status === 'failed' && response.failure) {
      failuresByKind[response.failure.kind] = (failuresByKind[response.failure.kind] ?? 0) + 1;
    }
  }
  const ok = responses.filter((entry) => entry.status === 'ok').length;
  return {
    total: responses.length,
    ok,
    failed: responses.length - ok,
    failuresByKind,
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}
