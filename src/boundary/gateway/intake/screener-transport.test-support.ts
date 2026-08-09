import { COGSEC_TRANSPORT_ERROR_MAX_CHARS } from '../../../core/cogsec/intake/screening-envelope-policy.js';
import {
  screenerModelId,
  type ScreenerTestCompletion,
  type ScreenerTestCompletionInput,
} from './screener-transport.js';

export type ScreenerFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

interface ScreenerChoiceMessage {
  content?: unknown;
}

function extractMessageText(message: ScreenerChoiceMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part) {
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }
    return '';
  }).join('');
}

function requestBody(input: ScreenerTestCompletionInput): Record<string, unknown> {
  return {
    model: screenerModelId(input.model),
    temperature: 0,
    response_format: { type: 'json_object' },
    ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ],
  };
}

/** Adapts legacy wire-shape fixtures to the production transport's narrow test seam. */
export function adaptScreenerFetch(fetch: ScreenerFetch): ScreenerTestCompletion {
  return async (input) => {
    const response = await fetch('https://provider.test/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-key',
      },
      body: JSON.stringify(requestBody(input)),
      signal: input.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `provider returned ${String(response.status)} ${response.statusText}`
        + (detail ? `: ${detail.slice(0, COGSEC_TRANSPORT_ERROR_MAX_CHARS)}` : ''),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      return '';
    }
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    return extractMessageText((choices[0] as { message?: ScreenerChoiceMessage }).message);
  };
}
