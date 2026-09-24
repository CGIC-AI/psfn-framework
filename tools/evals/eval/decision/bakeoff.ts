// Jev vs local decision bake-off (epic 4lf3r .9).
//
// Offline by default (a deterministic fixture backend). Live runs are explicit
// and spend money / need a local model server:
//
//   npm --prefix tools/evals run eval:decision:bakeoff -- --live \
//     --jev-model typesafe/jev-1.13 [--jev-snapshot typesafe/jev-1.13-20260917] \
//     --local-endpoint http://127.0.0.1:18080/v1 --local-model <served-model-id> \
//     [--run-id <id>] [--output-dir eval/decision/results]
//
// Jev is called through the production transport (ZDR-only routing) with
// OPENROUTER_API_KEY; the local side is the production generic local backend
// against any OpenAI-compatible chat endpoint. Each case yields one
// comparison record plus its labeled truth, aggregated by aggregate.ts
// (accuracy, Brier/reliability, latency, cost). The artifact records the
// requested models and the snapshot that actually answered.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LLMContext, LLMResponse } from '../../../../src/shared/contracts/runtime.js';
import { createLocalDecisionBackend } from '../../../../src/primitives/llm/decision/local-backend.js';
import { requestJevDecision, type DecisionsFetch } from '../../../../src/primitives/llm/decision/jev-transport.js';
import { buildDecisionShadowRecord } from '../../../../src/primitives/llm/decision/shadow-record.js';
import type { DecisionAnswers, DecisionOutcome } from '../../../../src/primitives/llm/decision/types.js';
import { buildLLMWorkSpec } from '../../../../src/primitives/llm/work-spec.js';
import {
  aggregateDecisionComparison,
  renderComparisonMarkdown,
  type DecisionComparisonReport,
  type LabeledShadowRecord,
} from './aggregate.js';
import { BAKEOFF_CASES, type BakeoffCase } from './bakeoff-cases.js';

export interface BakeoffBackend {
  id: string;
  model: string;
  decide(testCase: BakeoffCase): Promise<DecisionOutcome>;
}

export interface BakeoffArtifact {
  schemaVersion: 1;
  artifactType: 'psfn.decision_bakeoff';
  runId: string;
  generatedAt: string;
  local: { id: string; model: string };
  jev: { id: string; model: string; answeredBy: string[] };
  caseCount: number;
  rows: LabeledShadowRecord[];
  report: DecisionComparisonReport;
}

export async function runBakeoff(input: {
  cases: readonly BakeoffCase[];
  local: BakeoffBackend;
  jev: BakeoffBackend;
  runId: string;
  now?: () => Date;
}): Promise<BakeoffArtifact> {
  const now = input.now ?? (() => new Date());
  const rows: LabeledShadowRecord[] = [];
  for (const testCase of input.cases) {
    const [local, jev] = await Promise.all([input.local.decide(testCase), input.jev.decide(testCase)]);
    rows.push({
      record: buildDecisionShadowRecord({
        siteId: testCase.siteId,
        questions: testCase.questions,
        local,
        jev,
        recordedAtMs: now().getTime(),
      }),
      truth: testCase.truth,
    });
  }
  const answeredBy = [...new Set(rows.flatMap(row => (row.record.jev.model ? [row.record.jev.model] : [])))];
  return {
    schemaVersion: 1,
    artifactType: 'psfn.decision_bakeoff',
    runId: input.runId,
    generatedAt: now().toISOString(),
    local: { id: input.local.id, model: input.local.model },
    jev: { id: input.jev.id, model: input.jev.model, answeredBy },
    caseCount: input.cases.length,
    rows,
    report: aggregateDecisionComparison(rows),
  };
}

/** Deterministic offline backend: answers from the labels with a fixed skew. */
export function createFixtureBackend(id: string, correctness: number): BakeoffBackend {
  return {
    id,
    model: `fixture:${id}`,
    async decide(testCase) {
      const answers: DecisionAnswers = {};
      for (const [name, value] of Object.entries(testCase.truth)) {
        if (typeof value === 'boolean') {
          answers[name] = { type: 'noul', pYes: value ? correctness : 1 - correctness };
        } else if (typeof value === 'string') {
          answers[name] = { type: 'choice', choice: value, confidence: correctness };
        } else {
          answers[name] = { type: 'score', score: value };
        }
      }
      return { ok: true, answers, backend: 'local', probabilitySource: 'self_report_uncalibrated', latencyMs: 1 };
    },
  };
}

function createJevBackend(options: { apiKey: string; model: string; snapshot: string | null; timeoutMs: number }): BakeoffBackend {
  return {
    id: 'jev',
    model: options.model,
    async decide(testCase) {
      const result = await requestJevDecision(
        {
          endpointUrl: 'https://openrouter.ai/api/alpha/decisions',
          apiKey: options.apiKey,
          model: options.model,
          expectedSnapshot: options.snapshot,
        },
        { state: testCase.state, questions: testCase.questions },
        { fetch: globalThis.fetch as unknown as DecisionsFetch, signal: AbortSignal.timeout(options.timeoutMs) },
      );
      return result.outcome;
    },
  };
}

function createOpenAiCompatibleLocalBackend(options: {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
}): BakeoffBackend {
  const complete = async (context: LLMContext): Promise<LLMResponse> => {
    const response = await fetch(new URL('chat/completions', options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens,
        messages: [
          { role: 'system', content: context.systemPrompt },
          ...context.messages.map(message => ({ role: message.role, content: message.content })),
        ],
      }),
    });
    if (!response.ok) throw new Error(`local endpoint HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return {
      content: body.choices?.[0]?.message?.content ?? '',
      toolCalls: [],
      model: options.model,
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    };
  };
  const backend = createLocalDecisionBackend({
    llmProvider: { complete: async context => await complete(context) },
    resolveQuestionMode: () => 'combined',
  });
  return {
    id: 'local',
    model: options.model,
    decide: async testCase => await backend.decide({
      siteId: testCase.siteId,
      state: testCase.state,
      questions: testCase.questions,
      workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false, maxOutputTokens: options.maxTokens }),
    }),
  };
}

interface CliOptions {
  live: boolean;
  runId: string;
  outputDir: string;
  jevModel: string;
  jevSnapshot: string | null;
  localEndpoint?: string;
  localModel?: string;
}

function parseCli(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    runId: `decision-bakeoff-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    outputDir: path.resolve('eval/decision/results'),
    jevModel: 'typesafe/jev-1.13',
    jevSnapshot: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--live') options.live = true;
    else if (arg === '--run-id') options.runId = next();
    else if (arg === '--output-dir') options.outputDir = path.resolve(next());
    else if (arg === '--jev-model') options.jevModel = next();
    else if (arg === '--jev-snapshot') options.jevSnapshot = next();
    else if (arg === '--local-endpoint') options.localEndpoint = next();
    else if (arg === '--local-model') options.localModel = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.jevModel.startsWith('~') || options.jevModel.includes('latest')) {
    throw new Error('--jev-model must be a pinned release (aliases are rejected)');
  }
  return options;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseCli(args);
  let local: BakeoffBackend;
  let jev: BakeoffBackend;
  if (options.live) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error('--live requires OPENROUTER_API_KEY');
    if (!options.localEndpoint || !options.localModel) throw new Error('--live requires --local-endpoint and --local-model');
    jev = createJevBackend({ apiKey, model: options.jevModel, snapshot: options.jevSnapshot, timeoutMs: 15_000 });
    local = createOpenAiCompatibleLocalBackend({
      endpoint: options.localEndpoint,
      model: options.localModel,
      ...(process.env.LOCAL_DECISION_API_KEY ? { apiKey: process.env.LOCAL_DECISION_API_KEY } : {}),
      maxTokens: 512,
    });
  } else {
    local = createFixtureBackend('fixture-local', 0.7);
    jev = createFixtureBackend('fixture-jev', 0.9);
  }
  const artifact = await runBakeoff({ cases: BAKEOFF_CASES, local, jev, runId: options.runId });
  mkdirSync(options.outputDir, { recursive: true });
  const target = path.join(options.outputDir, `${options.runId}.json`);
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(renderComparisonMarkdown(artifact.report));
  process.stdout.write(`\nWrote ${target}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
