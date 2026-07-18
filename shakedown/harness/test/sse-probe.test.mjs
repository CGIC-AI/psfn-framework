import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { probeSseChatCompletion } from '../lib/sse-probe.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${String(address.port)}/v1/chat/completions`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('SSE probe records the first non-empty delta before the terminal event and binds a turn', async () => {
  await withServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      assert.equal(parsed.messages[0].content, 'stream fixture');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  }, async (apiUrl) => {
    const persisted = {
      status: 'completed',
      userMessage: { content: 'stream fixture' },
      assistantMessage: { content: 'hello' },
    };
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: { Authorization: 'Bearer fixture' },
      message: 'stream fixture',
      waitForTurnRecord: async () => persisted,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.stream.firstContent, 'hello');
    assert.equal(result.stream.contentText, 'hello world');
    assert.ok(Number.isFinite(result.stream.firstContentAtMs));
    assert.ok(Number.isFinite(result.stream.terminalAtMs));
    assert.ok(result.stream.firstContentAtMs <= result.stream.terminalAtMs);
    assert.equal(result.turnRecord, persisted);
  });
});

test('SSE probe keeps missing first content explicit instead of treating terminal success as proof', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, async (apiUrl) => {
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: {},
      message: 'no content fixture',
      waitForTurnRecord: async () => null,
    });
    assert.equal(result.stream.firstContentAtMs, null);
    assert.equal(result.stream.firstContent, '');
    assert.ok(Number.isFinite(result.stream.terminalAtMs));
    assert.equal(result.turnRecord, null);
  });
});
