import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface OpenAIMessage {
  content?: unknown;
  role?: string;
}

interface OpenAIRequest {
  max_tokens?: number;
  messages?: OpenAIMessage[];
  model?: string;
  stream?: boolean;
}

export interface IcpCertificationModelRequest {
  model: string;
}

export interface IcpCertificationModelServer {
  baseUrl: string;
  readonly requests: readonly IcpCertificationModelRequest[];
  queueConsentDecision(decision: IcpCertificationConsentDecision): void;
  stop(): Promise<void>;
}

export type IcpCertificationConsentDecision = 'send' | 'defer' | 'decline';

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function renderChatResponse(
  promptText: string,
  consentDecision: IcpCertificationConsentDecision,
): string {
  if (promptText.includes('private consent moment')) {
    return consentDecision === 'send'
      ? '{"action":"send"}'
      : JSON.stringify({ action: consentDecision, reason: `fixture_${consentDecision}` });
  }
  if (promptText.includes('initiate one natural message to the peer')) {
    return 'I wanted to check in and share a quiet hello.';
  }
  if (promptText.includes('favorite dessert') || promptText.includes('tiramisu')) {
    return 'I heard the primary user\'s favorite dessert is tiramisu.';
  }
  if (promptText.includes('thunderstorms')) {
    return 'I heard the primary user loves watching thunderstorms at night.';
  }
  if (promptText.includes('hello')) return 'Hello. I am here and ready.';
  if (promptText.includes('orientation') || promptText.includes('capabilities')) {
    return 'I can hold onto facts, answer questions, and use the analysis workbench when a large-context problem needs it.';
  }
  if (promptText.includes('what do you think') || promptText.includes('how are you feeling')) {
    return 'I am steady, curious, and taking this in.';
  }
  if (promptText.includes('17 * 23') || promptText.includes('calculate 17 * 23')) {
    return 'FINAL("391")';
  }
  return 'Acknowledged.';
}

function renderExtractionXml(promptText: string): string {
  const companionMarker = promptText.includes('you are certification a.')
    ? 'A'
    : promptText.includes('you are certification b.')
      ? 'B'
      : 'unknown';
  return [
    '<response>',
    '<fact>',
    `<text>Certification ${companionMarker} extraction marker is schema-private.</text>`,
    '<type>semantic</type>',
    '<importance>0.99</importance>',
    '<emotional_valence>0</emotional_valence>',
    '<confidence>0.99</confidence>',
    `<tags>certification,schema-private,companion-${companionMarker.toLowerCase()}</tags>`,
    '<sensitivity>personal</sensitivity>',
    '</fact>',
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

async function readJsonRequest(request: IncomingMessage): Promise<OpenAIRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const decoded = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenAI-compatible fixture request must be an object');
  }
  return parsed as OpenAIRequest;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStreamingResponse(
  response: ServerResponse,
  model: string,
  content: string,
  outputTokens: number,
): void {
  const id = `chatcmpl-certification-${Date.now()}`;
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  response.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 128,
      completion_tokens: outputTokens,
      total_tokens: 128 + outputTokens,
    },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

export async function startIcpCertificationModelServer(): Promise<IcpCertificationModelServer> {
  const requests: IcpCertificationModelRequest[] = [];
  const consentDecisions: IcpCertificationConsentDecision[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: 'not found' } });
        return;
      }
      const body = await readJsonRequest(request);
      const model = typeof body.model === 'string' ? body.model : 'unknown';
      const prompt = (body.messages ?? []).map(message => normalizeText(message.content))
        .join('\n')
        .toLowerCase();
      requests.push({ model });
      const extraction = model.includes('deepseek') && !prompt.includes('private consent moment');
      const consentDecision = prompt.includes('private consent moment')
        ? (consentDecisions.shift() ?? 'send')
        : 'send';
      const content = extraction
        ? renderExtractionXml(prompt)
        : renderChatResponse(prompt, consentDecision);
      const requestedOutputTokens = typeof body.max_tokens === 'number'
        ? Math.max(1, Math.floor(body.max_tokens))
        : undefined;
      const outputTokens = extraction ? 88 : Math.min(36, requestedOutputTokens ?? 36);
      if (body.stream === true) {
        sendStreamingResponse(response, model, content, outputTokens);
        return;
      }
      sendJson(response, 200, {
        id: `chatcmpl-certification-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1_000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 128,
          completion_tokens: outputTokens,
          total_tokens: 128 + outputTokens,
        },
      });
    } catch (error) {
      sendJson(response, 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new Error('ICP certification model server did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    queueConsentDecision(decision) {
      consentDecisions.push(decision);
    },
    async stop() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}
