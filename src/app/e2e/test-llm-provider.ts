import type { LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import type { CompletionPurpose } from '../../shared/contracts/runtime.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';

const MOCK_MODEL = 'psfn-e2e/mock';

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? '');
}

function collectPromptText(context: LLMContext): string {
  const parts = [
    context.systemPrompt,
    ...context.messages.map((message) => normalizeText(message.content)),
  ];
  return parts.join('\n').toLowerCase();
}

function makeResponse(content: string, inputTokens = 96, outputTokens = 24): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: MOCK_MODEL,
    inputTokens,
    outputTokens,
    stopReason: 'stop',
  };
}

function renderChatResponse(promptText: string): string {
  if (promptText.includes('favorite dessert') || promptText.includes('tiramisu')) {
    return 'I heard the primary user\'s favorite dessert is tiramisu.';
  }

  if (promptText.includes('thunderstorms')) {
    return 'I heard the primary user loves watching thunderstorms at night.';
  }

  if (promptText.includes('hello')) {
    return 'Hello. I am here and ready.';
  }

  if (promptText.includes('orientation') || promptText.includes('capabilities')) {
    return 'I can hold onto facts, answer questions, and use the think tool when needed.';
  }

  if (promptText.includes('what do you think') || promptText.includes('how are you feeling')) {
    return 'I am steady, curious, and taking this in.';
  }

  return 'Acknowledged.';
}

function renderExtractionXml(): string {
  return [
    '<response>',
    '<fact>',
    '<text>The primary user\'s favorite dessert is tiramisu.</text>',
    '<type>semantic</type>',
    '<importance>0.96</importance>',
    '<emotional_valence>0.05</emotional_valence>',
    '<confidence>0.98</confidence>',
    '<tags>primary user,dessert,tiramisu</tags>',
    '<sensitivity>personal</sensitivity>',
    '</fact>',
    '<fact>',
    '<text>The primary user likes watching thunderstorms at night.</text>',
    '<type>semantic</type>',
    '<importance>0.92</importance>',
    '<emotional_valence>0.15</emotional_valence>',
    '<confidence>0.95</confidence>',
    '<tags>primary user,thunderstorms,night</tags>',
    '<sensitivity>personal</sensitivity>',
    '</fact>',
    '</response>',
  ].join('');
}

function renderReasoningResponse(promptText: string): string {
  if (promptText.includes('17 * 23') || promptText.includes('calculate 17 * 23')) {
    return 'FINAL("391")';
  }

  if (promptText.includes('how many memories mention the primary user')) {
    return 'FINAL("2 memories mention the primary user: tiramisu and thunderstorms.")';
  }

  if (promptText.includes('memory search')) {
    return 'FINAL("2")';
  }

  return 'FINAL("done")';
}

function respond(context: LLMContext, purpose: CompletionPurpose): LLMResponse {
  const promptText = collectPromptText(context);

  if (purpose === 'extraction') {
    return makeResponse(renderExtractionXml(), 128, 88);
  }

  if (purpose === 'reasoning') {
    return makeResponse(renderReasoningResponse(promptText), 128, 40);
  }

  return makeResponse(renderChatResponse(promptText), 128, 36);
}

export function createScriptedE2ELLMProvider(): LLMProviderPort {
  return {
    stream: async (context) => respond(context, 'chat'),
    complete: async (context, purpose) => respond(context, purpose),
  };
}
