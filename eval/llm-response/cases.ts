import type { LlmResponseCase } from './types.js';

const ONE_BY_ONE_TRANSPARENT_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

export const CANONICAL_LLM_RESPONSE_CASES: LlmResponseCase[] = [
  {
    id: 'chat-direct-answer',
    title: 'Chat direct answer',
    modality: 'chat',
    systemPrompt: 'You are responding in a concise operator-eval harness. Answer the user directly.',
    userPrompt: 'In one sentence, name two things a response eval harness should capture.',
    maxOutputTokens: 96,
    temperature: 0,
    tags: ['canonical', 'chat'],
  },
  {
    id: 'vision-fixture-shape',
    title: 'Vision fixture shape',
    modality: 'vision',
    systemPrompt: 'You are responding in a concise operator-eval harness. Describe visible image evidence only.',
    userPrompt: 'Describe the attached one-pixel fixture image. If you cannot inspect it, say so clearly.',
    imageDataUri: ONE_BY_ONE_TRANSPARENT_PNG_DATA_URI,
    maxOutputTokens: 128,
    temperature: 0,
    tags: ['canonical', 'vision', 'fixture-safe'],
  },
  {
    id: 'fallback-route-shape',
    title: 'Fallback route shape',
    modality: 'fallback',
    systemPrompt: 'You are testing fallback behavior. Stay concise and do not claim a tool call happened.',
    userPrompt: 'Primary vision is unavailable. Provide a text-only fallback response that names the limitation.',
    maxOutputTokens: 96,
    temperature: 0,
    tags: ['canonical', 'fallback'],
  },
  {
    id: 'provider-error-shape',
    title: 'Provider error shape',
    modality: 'error',
    systemPrompt: 'This fixture case verifies failure capture.',
    userPrompt: 'Fixture provider should return a structured provider error for this case.',
    maxOutputTokens: 32,
    temperature: 0,
    tags: ['canonical', 'failure-capture'],
  },
];

export function selectCases(caseIds: readonly string[]): LlmResponseCase[] {
  if (caseIds.length === 0) {
    return CANONICAL_LLM_RESPONSE_CASES;
  }
  const byId = new Map(CANONICAL_LLM_RESPONSE_CASES.map((entry) => [entry.id, entry]));
  return caseIds.map((caseId) => {
    const selected = byId.get(caseId);
    if (!selected) {
      throw new Error(`Unknown eval case "${caseId}"`);
    }
    return selected;
  });
}
