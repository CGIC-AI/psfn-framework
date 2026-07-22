#!/usr/bin/env node
// ── Compose smoke model prefetch (psfn-framework-65rk.12) ──
// The Compose analogue of the Helm model-prefetch Job. The isolated agent has no
// outbound network, so the in-process @huggingface/transformers models it warms
// at startup (text-emotion classifier + embedding provider) must already be in
// the shared model cache. This one-shot runs on the egress network BEFORE the
// gateway/agent and downloads both models into the cache dir both processes read
// (settings.json pins textEmotionCacheDir + the embedding default to
// <cwd>/models/transformers = /app/models/transformers).
//
// Model ids/dtypes mirror config/settings.seed.json (SamLowe/roberta-base-go_
// emotions-onnx @ fp32, Xenova/all-MiniLM-L6-v2 @ fp32). Idempotent: a warm
// cache re-runs as a no-op download.

import process from 'node:process';

const CACHE_DIR = process.env.PSFN_SMOKE_MODEL_CACHE_DIR || '/app/models/transformers';
const EMOTION_MODEL = process.env.PSFN_SMOKE_TEXT_EMOTION_MODEL || 'SamLowe/roberta-base-go_emotions-onnx';
const EMOTION_DTYPE = process.env.PSFN_SMOKE_TEXT_EMOTION_DTYPE || 'fp32';
const EMBEDDING_MODEL = process.env.PSFN_SMOKE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DTYPE = process.env.PSFN_SMOKE_EMBEDDING_DTYPE || 'fp32';

function log(msg) {
  console.log(`[model-prefetch] ${msg}`);
}

async function main() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = true;

  log(`cache dir: ${CACHE_DIR}`);

  log(`warming text-emotion classifier: ${EMOTION_MODEL} (${EMOTION_DTYPE})`);
  const classifier = await pipeline('text-classification', EMOTION_MODEL, { dtype: EMOTION_DTYPE });
  await classifier('prefetch emotion model', { top_k: 28 });
  log(`text-emotion model cached: ${EMOTION_MODEL}`);

  log(`warming embedding provider: ${EMBEDDING_MODEL} (${EMBEDDING_DTYPE})`);
  const embedder = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE });
  await embedder('prefetch embedding model', { pooling: 'mean', normalize: true });
  log(`embedding model cached: ${EMBEDDING_MODEL}`);

  log('done');
}

main().catch((error) => {
  console.error(`[model-prefetch] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
