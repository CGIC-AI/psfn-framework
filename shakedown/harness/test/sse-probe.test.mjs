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
    assert.deepEqual(result.stream.parseErrors, []);
    assert.ok(Number.isFinite(result.stream.firstContentAtMs));
    assert.ok(Number.isFinite(result.stream.terminalAtMs));
    assert.ok(result.stream.firstContentAtMs <= result.stream.terminalAtMs);
    assert.equal(result.turnRecord, persisted);
  });
});

test('SSE probe records malformed data frames so persisted proof fails closed', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {definitely-not-json}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"valid"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  }, async (apiUrl) => {
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: {},
      message: 'malformed fixture',
      waitForTurnRecord: async () => null,
    });
    assert.equal(result.stream.contentText, 'valid');
    assert.equal(result.stream.parseErrors.length, 1);
    assert.equal(result.stream.parseErrors[0].event, 1);
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

test('SSE probe captures the gateway error body and content type on a non-2xx refusal', async () => {
  const refusal = JSON.stringify({
    error: {
      message: 'Testing-harness chat requests require exact run and manifest identifiers',
      type: 'testing_harness_provenance_required',
    },
  });
  await withServer((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(refusal);
  }, async (apiUrl) => {
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: {},
      message: 'refused fixture',
      waitForTurnRecord: async () => null,
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.contentType, 'application/json');
    assert.equal(result.response.rawText, refusal);
    assert.equal(result.response.body.error.type, 'testing_harness_provenance_required');
    assert.equal(result.response.fetchError, null);
    // A refusal is not a stream: no deltas, no terminal marker.
    assert.equal(result.stream.eventCount, 0);
    assert.equal(result.stream.firstContentAtMs, null);
    assert.equal(result.stream.terminalAtMs, null);
  });
});

test('SSE probe bounds a pathological non-2xx error body', async () => {
  const huge = 'x'.repeat(5000);
  await withServer((_request, response) => {
    response.writeHead(502, { 'Content-Type': 'text/html' });
    response.end(huge);
  }, async (apiUrl) => {
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: {},
      message: 'bounded fixture',
      waitForTurnRecord: async () => null,
    });
    assert.equal(result.response.status, 502);
    assert.equal(result.response.body, null);
    assert.ok(result.response.rawText.length < 2100);
    assert.ok(result.response.rawText.endsWith('…[truncated]'));
  });
});

test('SSE probe still reports a 2xx stream body-free', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  }, async (apiUrl) => {
    const result = await probeSseChatCompletion({
      apiUrl,
      headers: {},
      message: 'content-free fixture',
      waitForTurnRecord: async () => null,
    });
    // Model output never enters the response envelope persisted into artifacts.
    assert.equal(result.response.rawText, '');
    assert.equal(result.response.body, null);
    assert.equal(result.stream.contentText, 'hi');
  });
});
