import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import type { CorrelationMetadata } from '../../../shared/contracts/runtime.js';

type EpisodicPersonaSubsystem = Parameters<PersonaPreamblePort['prepend']>[0];

export interface RunEpisodicJudgmentOptions<Result> {
  llmProvider: Pick<LLMProviderPort, 'complete'>;
  personaPreamble?: PersonaPreamblePort | null;
  personaSubsystem: EpisodicPersonaSubsystem;
  systemPrompt: string;
  requestPrompt: string;
  correlation: CorrelationMetadata;
  parse: (content: string) => Result;
  onError?: (error: unknown) => Result | Promise<Result>;
}

export async function runEpisodicJudgment<Result>(
  options: RunEpisodicJudgmentOptions<Result>,
): Promise<Result> {
  try {
    const systemPrompt = options.personaPreamble
      ? options.personaPreamble.prepend(options.personaSubsystem, options.systemPrompt)
      : options.systemPrompt;
    const response = await completeWithWorkSpec(
      options.llmProvider,
      {
        systemPrompt,
        messages: [{ role: 'user', content: options.requestPrompt }],
      },
      buildLLMWorkSpec({ purpose: 'memory', durable: true, correlation: options.correlation }),
    );
    return options.parse(response.content);
  } catch (error) {
    if (options.onError) {
      return options.onError(error);
    }
    throw error;
  }
}
