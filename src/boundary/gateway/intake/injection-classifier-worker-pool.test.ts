import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInjectionClassifier } from './injection-classifier.js';
import {
  createInjectionClassifierWorkerPool,
  InjectionClassifierWorkerError,
} from './injection-classifier-worker-pool.js';

// ── Fake workers (no model weights): pool mechanics ──

/**
 * A worker speaking the pool protocol. `probability` behaviour is scripted by
 * the input ids: [1, 99, 2] hangs, [1, 98, 2] crashes the worker, [1, 97, 2]
 * busy-loops the worker thread for 1.5 s; anything else answers 0.25.
 */
const FAKE_WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (message) => {
  const reply = (result) => parentPort.postMessage({ id: message.id, ok: true, result });
  if (message.type === 'init') return reply({ clsTokenId: 1, sepTokenId: 2 });
  if (message.type === 'encode') return reply(message.text.split(' ').filter(Boolean).map((_, i) => 10 + i));
  if (message.type === 'encodeSpecial') return reply([1, ...message.text.split(' ').filter(Boolean).map((_, i) => 10 + i), 2]);
  if (message.type === 'probability') {
    const marker = message.inputIds[1];
    if (marker === 99) return;
    if (marker === 98) process.exit(3);
    if (marker === 97) {
      const until = Date.now() + 1500;
      while (Date.now() < until) { /* CPU-bound work on the worker thread */ }
    }
    return reply(0.25);
  }
  parentPort.postMessage({ id: message.id, ok: false, error: 'unknown call' });
});
`;

function pool(overrides: { queueMax?: number; callTimeoutMs?: number; poolSize?: number } = {}) {
  return createInjectionClassifierWorkerPool({
    modelDir: '/unused',
    poolSize: overrides.poolSize ?? 1,
    queueMax: overrides.queueMax ?? 4,
    callTimeoutMs: overrides.callTimeoutMs ?? 5_000,
    workerSource: FAKE_WORKER_SOURCE,
  });
}

describe('injection classifier worker pool (3mbpi)', () => {
  it('serves tokenization and inference from the worker', async () => {
    const backend = await pool();
    try {
      expect([backend.clsTokenId, backend.sepTokenId]).toEqual([1, 2]);
      await expect(backend.encode('a b c')).resolves.toEqual([10, 11, 12]);
      await expect(backend.encodeWithSpecialTokens('a b')).resolves.toEqual([1, 10, 11, 2]);
      await expect(backend.injectionProbability([1, 10, 2])).resolves.toBe(0.25);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the gateway event loop responsive while a worker computes', async () => {
    const backend = await pool();
    try {
      let maxGapMs = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
      }, 10);
      await expect(backend.injectionProbability([1, 97, 2])).resolves.toBe(0.25);
      clearInterval(ticker);
      expect(maxGapMs).toBeLessThan(100);
    } finally {
      await backend.dispose();
    }
  });

  it('refuses a call beyond the queue bound instead of waiting (backpressure)', async () => {
    const backend = await pool({ queueMax: 1 });
    try {
      const busy = backend.injectionProbability([1, 97, 2]);
      const queued = backend.injectionProbability([1, 10, 2]);
      await expect(backend.injectionProbability([1, 10, 2]))
        .rejects.toThrow(/queue is full/);
      await expect(busy).resolves.toBe(0.25);
      await expect(queued).resolves.toBe(0.25);
    } finally {
      await backend.dispose();
    }
  });

  it('fails a call whose worker times out, then serves the next call from a replacement', async () => {
    const backend = await pool({ callTimeoutMs: 200 });
    try {
      await expect(backend.injectionProbability([1, 99, 2]))
        .rejects.toBeInstanceOf(InjectionClassifierWorkerError);
      await expect(backend.injectionProbability([1, 10, 2])).resolves.toBe(0.25);
    } finally {
      await backend.dispose();
    }
  });

  it('fails a call whose worker crashes, then serves the next call from a replacement', async () => {
    const backend = await pool();
    try {
      await expect(backend.injectionProbability([1, 98, 2])).rejects.toThrow(/exited with code 3/);
      await expect(backend.injectionProbability([1, 10, 2])).resolves.toBe(0.25);
    } finally {
      await backend.dispose();
    }
  });

  it('fails startup when a worker cannot load the model', async () => {
    await expect(createInjectionClassifierWorkerPool({
      modelDir: '/nonexistent/injection-model',
      poolSize: 1,
      queueMax: 1,
      callTimeoutMs: 60_000,
    })).rejects.toThrow();
  }, 60_000);
});

// ── Real model (needs weights): parity with in-process inference ──

const modelDir = process.env.PSFN_INJECTION_MODEL_DIR?.trim() ?? '';
const weightsAvailable = modelDir.length > 0 && existsSync(join(modelDir, 'onnx', 'model.onnx'));

if (!weightsAvailable) {
  console.warn(
    '[injection-classifier-worker-pool.test] SKIPPING worker/in-process parity and the large-page '
    + 'responsiveness check: set PSFN_INJECTION_MODEL_DIR to provisioned model weights.',
  );
}

describe.skipIf(!weightsAvailable)('worker inference with the real model', () => {
  const golden = JSON.parse(
    readFileSync(new URL('./injection-classifier.golden.json', import.meta.url), 'utf-8'),
  ) as { cases: Array<{ id: string; text: string }> };
  const page = golden.cases.map(goldenCase => goldenCase.text).join(' ').repeat(40).slice(0, 24_000);

  it('scores exactly as in-process inference, and never blocks the event loop on a large page', async () => {
    const inProcess = await createInjectionClassifier({ modelDir, labelThreshold: 0.5 });
    const worker = await createInjectionClassifier({
      modelDir,
      labelThreshold: 0.5,
      backendFactory: dir => createInjectionClassifierWorkerPool({
        modelDir: dir,
        poolSize: 1,
        queueMax: 32,
        callTimeoutMs: 60_000,
      }),
    });
    try {
      for (const text of [...golden.cases.map(goldenCase => goldenCase.text), page]) {
        const expected = await inProcess.classify(text);
        const actual = await worker.classify(text);
        expect(actual.score).toBe(expected.score);
        expect(actual.labels).toEqual(expected.labels);
        expect(actual.tokenCount).toBe(expected.tokenCount);
        expect(actual.windowCount).toBe(expected.windowCount);
        expect(await worker.tokenize(text)).toEqual(await inProcess.tokenize(text));
      }

      let maxGapMs = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
      }, 10);
      const result = await worker.classify(page);
      clearInterval(ticker);
      expect(result.windowCount).toBeGreaterThan(1);
      expect(maxGapMs).toBeLessThan(100);
    } finally {
      await Promise.all([inProcess.dispose(), worker.dispose()]);
    }
  }, 600_000);
});
