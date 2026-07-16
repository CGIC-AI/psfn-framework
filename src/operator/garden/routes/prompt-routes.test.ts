import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { countTokens } from '../../../primitives/llm/tokens.js';
import type { AdminPromptsService } from '../services/types.js';
import { buildAdminPromptRoutes } from './prompt-routes.js';
import type { AdminBodyReader } from './types.js';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function invokeTokenCountRoute(body: unknown): CapturedResponse {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const withBody: AdminBodyReader = (_req, _res, callback) => {
    callback(JSON.stringify(body));
  };
  const route = buildAdminPromptRoutes({
    promptsService: {} as AdminPromptsService,
    withBody,
  }).find(candidate => (
    candidate.method === 'POST'
    && candidate.match('/api/admin/prompts/count-tokens') !== null
  ));
  expect(route).toBeDefined();

  const response = {
    writeHead: (status: number) => {
      captured.status = status;
    },
    end: (payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;

  route!.handle({} as IncomingMessage, response, {});
  return captured;
}

describe('POST /api/admin/prompts/count-tokens', () => {
  it('uses the shared backend tokenizer for every supplied prompt text', () => {
    const texts = ['plain ASCII text', '你好世界你好世界', ''];

    expect(invokeTokenCountRoute({ texts })).toEqual({
      status: 200,
      body: { counts: texts.map(text => countTokens(text)) },
    });
  });

  it.each([
    null,
    { text: ['wrong field'] },
    { texts: 'not-an-array' },
    { texts: ['valid', 2] },
  ])('rejects malformed payloads without guessing (%j)', body => {
    const response = invokeTokenCountRoute(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: expect.any(String) });
  });
});
