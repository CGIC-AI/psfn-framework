import type { LLMProviderPort } from '../../../core/agent/contracts.js';
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
    const response = await options.llmProvider.complete(
      {
        systemPrompt,
        messages: [{ role: 'user', content: options.requestPrompt }],
        correlation: options.correlation,
      },
      'memory',
    );
    return options.parse(response.content);
  } catch (error) {
    if (options.onError) {
      return options.onError(error);
    }
    throw error;
  }
}
