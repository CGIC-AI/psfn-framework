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

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

class OfflineCacheInputError extends Error {}

const CACHE_DIR = process.env.PSFN_SMOKE_MODEL_CACHE_DIR || '/app/models/transformers';
const EMOTION_MODEL = process.env.PSFN_SMOKE_TEXT_EMOTION_MODEL || 'SamLowe/roberta-base-go_emotions-onnx';
const EMOTION_DTYPE = process.env.PSFN_SMOKE_TEXT_EMOTION_DTYPE || 'fp32';
const EMBEDDING_MODEL = process.env.PSFN_SMOKE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DTYPE = process.env.PSFN_SMOKE_EMBEDDING_DTYPE || 'fp32';
const CACHE_INPUT_DIR = process.env.PSFN_SMOKE_MODEL_CACHE_INPUT_DIR?.trim() || null;
const OFFLINE_VALUE = process.env.PSFN_SMOKE_MODEL_PREFETCH_OFFLINE?.trim() ?? '';

function log(msg) {
  console.log(`[model-prefetch] ${msg}`);
}

function cacheEntries(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory).filter(entry => entry !== '.gitkeep');
}

function requiredRevision(name) {
  const value = process.env[name]?.trim() ?? '';
  if (value.length !== 40 || [...value].some(character => !'0123456789abcdef'.includes(character))) {
    throw new OfflineCacheInputError(`${name} must be an exact 40-character lowercase commit SHA`);
  }
  return value;
}

function modelDirectory(root, model) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, model);
  const relativePath = relative(rootPath, target);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new OfflineCacheInputError(`model id resolves outside its cache root: ${model}`);
  }
  return target;
}

function replaceRuntimeModelAlias(modelRoot, revision) {
  const pinnedRoot = join(modelRoot, revision);
  const pinnedEntries = cacheEntries(pinnedRoot);
  if (pinnedEntries.length === 0) {
    throw new OfflineCacheInputError(
      `pinned cache is missing model revision ${revision} under ${modelRoot}`,
    );
  }
  mkdirSync(modelRoot, { recursive: true });
  for (const entry of cacheEntries(modelRoot)) {
    if (entry === revision) continue;
    rmSync(join(modelRoot, entry), { recursive: true, force: true });
  }
  for (const entry of pinnedEntries) {
    cpSync(join(pinnedRoot, entry), join(modelRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

function copyPinnedModelInput(inputRoot, cacheRoot, model, revision) {
  const sourceModelRoot = modelDirectory(inputRoot, model);
  const sourcePinnedRoot = join(sourceModelRoot, revision);
  if (cacheEntries(sourcePinnedRoot).length === 0) {
    throw new OfflineCacheInputError(
      `offline cache input is missing ${model}@${revision}. Populate the cache on a host `
      + 'that can reach Hugging Face, then transfer the complete cache directory.',
    );
  }

  const targetModelRoot = modelDirectory(cacheRoot, model);
  if (resolve(sourceModelRoot) !== resolve(targetModelRoot)) {
    rmSync(targetModelRoot, { recursive: true, force: true });
    mkdirSync(targetModelRoot, { recursive: true });
    cpSync(sourcePinnedRoot, join(targetModelRoot, revision), {
      recursive: true,
      force: true,
    });
  }
  replaceRuntimeModelAlias(targetModelRoot, revision);
}

function resolveOfflineMode() {
  if (OFFLINE_VALUE === '' || OFFLINE_VALUE === '0') return false;
  if (OFFLINE_VALUE === '1') return true;
  throw new OfflineCacheInputError(
    `PSFN_SMOKE_MODEL_PREFETCH_OFFLINE must be 0 or 1; received ${JSON.stringify(OFFLINE_VALUE)}`,
  );
}

function prepareCacheInput(offline, emotionRevision, embeddingRevision) {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (offline && CACHE_INPUT_DIR) {
    if (!existsSync(CACHE_INPUT_DIR) || !statSync(CACHE_INPUT_DIR).isDirectory()) {
      throw new OfflineCacheInputError(
        `configured cache input does not exist or is not a directory: ${CACHE_INPUT_DIR}. `
        + 'Set PSFN_SMOKE_MODEL_CACHE_SOURCE to the transferred cache directory and rerun.',
      );
    }
    if (cacheEntries(CACHE_INPUT_DIR).length === 0) {
      throw new OfflineCacheInputError(
        'offline cache input is empty. Populate a cache on a host that can reach Hugging Face, '
        + 'then set PSFN_SMOKE_MODEL_CACHE_SOURCE to that directory and rerun with '
        + 'PSFN_SMOKE_MODEL_PREFETCH_OFFLINE=1.',
      );
    }
    copyPinnedModelInput(CACHE_INPUT_DIR, CACHE_DIR, EMOTION_MODEL, emotionRevision);
    copyPinnedModelInput(CACHE_INPUT_DIR, CACHE_DIR, EMBEDDING_MODEL, embeddingRevision);
  }
  if (offline && !CACHE_INPUT_DIR) {
    throw new OfflineCacheInputError(
      'offline mode requires a cache input. Set PSFN_SMOKE_MODEL_CACHE_SOURCE to a cache '
      + 'populated on a host that can reach Hugging Face, then rerun with '
      + 'PSFN_SMOKE_MODEL_PREFETCH_OFFLINE=1.',
    );
  }
}

async function main() {
  const offline = resolveOfflineMode();
  const emotionRevision = requiredRevision('PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION');
  const embeddingRevision = requiredRevision('PSFN_SMOKE_EMBEDDING_MODEL_REVISION');
  prepareCacheInput(offline, emotionRevision, embeddingRevision);
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = !offline;

  log(`cache dir: ${CACHE_DIR}`);
  log(`cache input: ${CACHE_INPUT_DIR ?? 'none'}`);
  log(`remote models: ${env.allowRemoteModels ? 'allowed' : 'disabled'}`);

  log(`warming text-emotion classifier: ${EMOTION_MODEL}@${emotionRevision} (${EMOTION_DTYPE})`);
  const classifier = await pipeline('text-classification', EMOTION_MODEL, {
    dtype: EMOTION_DTYPE,
    revision: emotionRevision,
  });
  await classifier('prefetch emotion model', { top_k: 28 });
  replaceRuntimeModelAlias(modelDirectory(CACHE_DIR, EMOTION_MODEL), emotionRevision);
  log(`text-emotion model cached: ${EMOTION_MODEL}@${emotionRevision}`);

  log(`warming embedding provider: ${EMBEDDING_MODEL}@${embeddingRevision} (${EMBEDDING_DTYPE})`);
  const embedder = await pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: EMBEDDING_DTYPE,
    revision: embeddingRevision,
  });
  await embedder('prefetch embedding model', { pooling: 'mean', normalize: true });
  replaceRuntimeModelAlias(modelDirectory(CACHE_DIR, EMBEDDING_MODEL), embeddingRevision);
  log(`embedding model cached: ${EMBEDDING_MODEL}@${embeddingRevision}`);

  log('done');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (error instanceof OfflineCacheInputError) {
    console.error(`[model-prefetch] ${error.message}`);
  } else {
    console.error(`[model-prefetch] FAILED: ${message}`);
    console.error(
      '[model-prefetch] If this host cannot reach Hugging Face, populate the cache on a '
      + 'reachable host, set PSFN_SMOKE_MODEL_CACHE_SOURCE to that directory, and rerun '
      + 'with PSFN_SMOKE_MODEL_PREFETCH_OFFLINE=1.',
    );
  }
  process.exit(error instanceof OfflineCacheInputError ? 2 : 1);
});
