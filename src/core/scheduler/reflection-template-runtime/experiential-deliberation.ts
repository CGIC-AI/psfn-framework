import type { LLMProviderPort } from '../../agent/contracts.js';
import type { ReflectionTemplate } from '../reflection-policy.js';
import { runDeliberation } from '../../../primitives/llm/deliberation.js';
import type { DeliberationResult, DeliberationStageDefinition } from '../../../primitives/llm/deliberation.js';
import type { ValuesDeliberationMetadata } from '../../../faculties/values/store.js';
import type { ContextMessage, CorrelationMetadata } from '../../../shared/contracts/runtime.js';
import type { OwnTimeDeliberationCaps, OwnTimeDeliberationShape } from './own-time-deliberation-caps.js';
import {
  extractEmbeddedJsonObject,
  normalizeUnsupportedClaimFlags,
  type ReflectionMetacognitiveFlag,
} from './prompt-formatting.js';

const DELIBERATION_DEFAULT_INPUT_USD_PER_MILLION_TOKENS = 2;
const DELIBERATION_DEFAULT_OUTPUT_USD_PER_MILLION_TOKENS = 8;

interface ExperientialDeliberationLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface ExperientialDeliberationExecutionResult {
  reflection: string;
  metadata: ValuesDeliberationMetadata;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
  /** The raw run, for the caller's cap reporting. */
  deliberation: DeliberationResult;
}

export interface RunExperientialTemplateDeliberationInput {
  llmProvider?: LLMProviderPort;
  template: ReflectionTemplate;
  prompt: string;
  authoritativeSystemPrompt: string;
  correlation: Partial<CorrelationMetadata>;
  logger: ExperientialDeliberationLogger;
  /** Own-time run caps, resolved by the caller (see own-time-deliberation-caps). */
  caps: OwnTimeDeliberationCaps;
  toDeliberationMetadata(result: DeliberationResult): ValuesDeliberationMetadata;
}

const buildExperientialEvidenceMessages = (
  template: ReflectionTemplate,
  prompt: string,
): { systemPrompt: string; messages: ContextMessage[] } => ({
  systemPrompt:
    `This is my evidence pass on my "${template.name}" reflection. `
    + 'I gather only what is directly grounded in the reflection context in front of me — '
    + 'three to six honest observations, no speculation and nothing I cannot support.',
  messages: [{
    role: 'user',
    content: [
      `Template: ${template.name} (${template.id})`,
      'Stage: evidence',
      'Reflection context:',
      prompt,
    ].join('\n\n'),
  }],
});

const buildExperientialSynthesisMessages = (
  template: ReflectionTemplate,
  prompt: string,
  evidence: string,
): { systemPrompt: string; messages: ContextMessage[] } => ({
  systemPrompt:
    `This is my synthesis pass on my "${template.name}" reflection. `
    + 'I write a grounded reflection using only the evidence I gathered, in two to five sentences, '
    + 'and I say plainly where the evidence is only partial rather than forcing a neat story over it.',
  messages: [{
    role: 'user',
    content: [
      `Template: ${template.name} (${template.id})`,
      'Stage: synthesis',
      'Original reflection context:',
      prompt,
      'Grounded evidence:',
      evidence,
    ].join('\n\n'),
  }],
});

const buildExperientialContradictionMessages = (
  template: ReflectionTemplate,
  prompt: string,
  evidence: string,
  synthesis: string,
): { systemPrompt: string; messages: ContextMessage[] } => ({
  systemPrompt:
    `This is my contradiction pass on my "${template.name}" reflection — I keep myself honest. `
    + 'I compare my candidate reflection against the grounded evidence. '
    + 'Return strict JSON with keys "revisedReflection" and "unsupportedClaims". '
    + '"unsupportedClaims" must be an array of objects with "claim", "reason", and "confidence" in [0,1]. '
    + 'If every claim is supported, return an empty array and preserve the reflection.',
  messages: [{
    role: 'user',
    content: [
      `Template: ${template.name} (${template.id})`,
      'Stage: contradiction',
      'Original reflection context:',
      prompt,
      'Grounded evidence:',
      evidence,
      'Candidate reflection:',
      synthesis,
      'Return JSON only.',
    ].join('\n\n'),
  }],
});

const parseExperientialContradictionResponse = (
  raw: string,
  fallbackReflection: string,
  logger: ExperientialDeliberationLogger,
): { revisedReflection: string; metacognitiveFlags: ReflectionMetacognitiveFlag[] } => {
  const jsonObject = extractEmbeddedJsonObject(raw);
  if (!jsonObject) {
    return {
      revisedReflection: fallbackReflection,
      metacognitiveFlags: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonObject) as {
      revisedReflection?: unknown;
      unsupportedClaims?: unknown;
    };
    const revisedReflection = typeof parsed.revisedReflection === 'string'
      && parsed.revisedReflection.trim().length > 0
      ? parsed.revisedReflection.trim()
      : fallbackReflection;
    return {
      revisedReflection,
      metacognitiveFlags: normalizeUnsupportedClaimFlags(parsed.unsupportedClaims),
    };
  } catch (error) {
    logger.warn('Experiential contradiction pass returned invalid JSON; preserving synthesis', {
      error: String(error),
    });
    return {
      revisedReflection: fallbackReflection,
      metacognitiveFlags: [],
    };
  }
};

/**
 * The experiential 3-stage sequence (evidence → synthesis → contradiction)
 * expressed as a fixed stage config for the shared runDeliberation
 * primitive, which owns the budget loop, token/cost accounting, stop
 * reasons, and per-stage correlation.
 */
const buildExperientialDeliberationStages = (
  template: ReflectionTemplate,
): DeliberationStageDefinition[] => [
  {
    name: 'evidence',
    purpose: template.deliberation?.voices?.[0] ?? 'background',
    buildTurn: ({ prompt }) => buildExperientialEvidenceMessages(template, prompt),
  },
  {
    name: 'synthesis',
    purpose: template.deliberation?.voices?.[1] ?? template.deliberation?.voices?.[0] ?? 'reasoning',
    buildTurn: ({ prompt, stageOutputs }) => buildExperientialSynthesisMessages(
      template,
      prompt,
      stageOutputs.evidence || prompt,
    ),
  },
  {
    name: 'contradiction',
    purpose: 'reasoning',
    buildTurn: ({ prompt, stageOutputs }) => buildExperientialContradictionMessages(
      template,
      prompt,
      stageOutputs.evidence || prompt,
      stageOutputs.synthesis || stageOutputs.evidence || prompt,
    ),
  },
];

function experientialMaxRounds(template: ReflectionTemplate): number {
  return Math.max(1, Math.min(3, Math.floor(template.deliberation?.maxRounds ?? 3)));
}

/** The experiential stage sequence as an own-time run shape: one call per stage. */
export function experientialDeliberationShape(template: ReflectionTemplate): OwnTimeDeliberationShape {
  const stages = buildExperientialDeliberationStages(template);
  return {
    rounds: Math.min(stages.length, experientialMaxRounds(template)),
    callsPerRound: 1,
    // The last stage carries every earlier stage's output.
    carriedOutputs: stages.length - 1,
    purposes: stages.map(stage => stage.purpose),
  };
}

function shapeExperientialDeliberationResult(
  result: DeliberationResult,
  prompt: string,
  logger: ExperientialDeliberationLogger,
): { reflection: string; metacognitiveFlags: ReflectionMetacognitiveFlag[] } {
  const stageOutput = (stageName: string): string =>
    result.rounds.find(round => round.stage === stageName)?.synthesis ?? '';
  const evidence = stageOutput('evidence');
  const synthesis = stageOutput('synthesis');
  const contradictionRaw = stageOutput('contradiction');

  let finalReflection = synthesis || evidence;
  let metacognitiveFlags: ReflectionMetacognitiveFlag[] = [];
  if (contradictionRaw) {
    const parsedContradiction = parseExperientialContradictionResponse(
      contradictionRaw,
      synthesis || evidence || prompt,
      logger,
    );
    metacognitiveFlags = parsedContradiction.metacognitiveFlags;
    finalReflection = parsedContradiction.revisedReflection;
  }

  return {
    reflection: finalReflection.trim() || synthesis.trim() || evidence.trim() || prompt.trim(),
    metacognitiveFlags,
  };
}

export async function runExperientialTemplateDeliberation({
  llmProvider,
  template,
  prompt,
  authoritativeSystemPrompt,
  correlation,
  logger,
  caps,
  toDeliberationMetadata,
}: RunExperientialTemplateDeliberationInput): Promise<ExperientialDeliberationExecutionResult> {
  if (!llmProvider) {
    throw new Error('Experiential deliberation requested without llmProvider');
  }

  const result = await runDeliberation(llmProvider, prompt, {
    episode: {
      kind: 'maintenance_reflection',
      mode: 'background_bounded',
    },
    authoritativeSystemPrompt,
    correlation,
    stages: buildExperientialDeliberationStages(template),
    caps: {
      maxRounds: experientialMaxRounds(template),
      maxTotalTokens: Math.max(256, Math.floor(caps.maxTotalTokens)),
      maxWallTimeMs: Math.max(250, Math.floor(caps.maxWallTimeMs)),
    },
    cost: {
      inputUsdPerMillionTokens: template.deliberation?.inputUsdPerMillionTokens
        ?? DELIBERATION_DEFAULT_INPUT_USD_PER_MILLION_TOKENS,
      outputUsdPerMillionTokens: template.deliberation?.outputUsdPerMillionTokens
        ?? DELIBERATION_DEFAULT_OUTPUT_USD_PER_MILLION_TOKENS,
    },
  });

  const shaped = shapeExperientialDeliberationResult(result, prompt, logger);
  return {
    reflection: shaped.reflection,
    metadata: toDeliberationMetadata(result),
    metacognitiveFlags: shaped.metacognitiveFlags,
    deliberation: result,
  };
}
