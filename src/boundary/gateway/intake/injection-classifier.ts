// ── Cognition Intake Firewall: L1.5 ONNX prompt-injection classifier (htm9.5) ──
//
// In-process ML classifier for the gateway-side intake screening pipeline.
// Runs protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0) through the
// already-pinned @huggingface/transformers runtime (onnxruntime backend, same
// stack as the emotion classifier and local embeddings).
//
// Placement: gateway process, in-process. The gateway already holds the raw
// inbound bytes, so no new process hop and no new credential surface.
//
// Contract with the rest of the firewall:
// - emits a calibrated 0-1 P(injection) score for `envelope.scores` under
//   INJECTION_CLASSIFIER_SCANNER_ID, and at most one `injection/*` label from
//   the closed IntakeRiskLabel taxonomy;
// - the score NEVER hard-blocks alone (known over-defense / false positives —
//   InjecGuard, arXiv 2410.22770). Per-tier screening thresholds live in
//   intake-policy.json (`injectionClassifier.scoreThresholdsByTier`) and are
//   combined with other signals by the decision layer (htm9.2/9.3);
// - model weights are provisioned out-of-band (npm run provision:injection-model)
//   and loaded from a local directory only; loading fails closed with a clear
//   error when weights are absent — there is no silent skip and no runtime
//   download.
//
// Tokenizer note (the historical crux): DeBERTa-v3 uses a SentencePiece
// Unigram tokenizer. We run the model's published `tokenizer.json` through
// transformers.js, whose Unigram + precompiled-charsmap implementation
// reproduces the reference HF Rust `tokenizers` ids exactly. Parity is
// enforced by the committed golden fixture
// (injection-classifier.golden.json + injection-classifier.test.ts), which
// pins reference token ids and reference ONNX probabilities produced by an
// independent Python pipeline.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IntakeRiskLabel } from '../../../shared/contracts/intake-envelope.js';

// ── Identity ──

/** Key for this classifier's calibrated score in `IntakeEnvelope.scores`. */
export const INJECTION_CLASSIFIER_SCANNER_ID = 'onnx-prompt-injection';

/** Pinned model identity; keep in sync with scripts/provision-injection-model.ts. */
export const INJECTION_CLASSIFIER_MODEL_ID = 'protectai/deberta-v3-base-prompt-injection-v2';
export const INJECTION_CLASSIFIER_MODEL_REVISION = 'b722c7fcbeae674abb1a1afb170a0291a379d12e';

/**
 * The single taxonomy label this classifier may attach. The model is a binary
 * SAFE/INJECTION detector and cannot distinguish injection subtypes; finer
 * `injection/*` labels belong to the deterministic L1 scanners (htm9.4).
 */
export const INJECTION_CLASSIFIER_RISK_LABEL: IntakeRiskLabel = 'injection/override_attempt';

// ── Public API ──

export interface InjectionClassification {
  /**
   * Calibrated P(injection) in [0, 1]: softmax probability of the INJECTION
   * class, maximum over token windows. Calibration is currently identity on
   * the model's own softmax output; per-tier decision thresholds compensate.
   */
  score: number;
  /** [] or [INJECTION_CLASSIFIER_RISK_LABEL] (score >= labelThreshold). */
  labels: IntakeRiskLabel[];
  /** Number of 512-token windows scored (long inputs are windowed, not truncated). */
  windowCount: number;
  /** Content token count (without special tokens). */
  tokenCount: number;
  latencyMs: number;
}

export interface InjectionClassifier {
  classify(text: string): Promise<InjectionClassification>;
  /**
   * Token ids for `text` including special tokens ([CLS] ... [SEP]) — the
   * tokenizer-parity surface used by the golden-set test.
   */
  tokenize(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}

/**
 * Minimal backend seam. The default backend wraps @huggingface/transformers;
 * unit tests inject a fake to exercise windowing and labeling without weights.
 */
export interface InjectionClassifierBackend {
  clsTokenId: number;
  sepTokenId: number;
  /** Token ids WITHOUT special tokens. */
  encode(text: string): Promise<number[]>;
  /** Token ids WITH special tokens (reference-tokenizer default form). */
  encodeWithSpecialTokens(text: string): Promise<number[]>;
  /** P(injection) for one full sequence including special tokens. */
  injectionProbability(inputIds: number[]): Promise<number>;
  dispose(): Promise<void>;
}

export type InjectionClassifierBackendFactory = (
  modelDir: string,
) => Promise<InjectionClassifierBackend>;

export interface InjectionClassifierOptions {
  /** Directory holding the provisioned model (config.json, tokenizer.json, onnx/model.onnx). */
  modelDir: string;
  /** Probability at/above which INJECTION_CLASSIFIER_RISK_LABEL is attached. */
  labelThreshold: number;
  /** Model sequence budget per window, incl. the 2 special tokens. Default 512. */
  maxSequenceLength?: number;
  /** Token overlap between consecutive windows. Default 128. */
  windowOverlapTokens?: number;
  /**
   * Hard cap on windows per item (input-size DoS guard). Exceeding it throws —
   * the screening caller decides what to do with an unscoreable item.
   * Default 64 (~24.6k content tokens at the defaults).
   */
  maxWindows?: number;
  /** Test seam; production uses the transformers.js backend. */
  backendFactory?: InjectionClassifierBackendFactory;
}

// ── Validation ──

function invalidOption(field: string, detail: string): Error {
  return new Error(`Invalid injection classifier option: ${field} ${detail}`);
}

function normalizeProbability(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidOption(field, 'must be a finite number in [0, 1]');
  }
  return value;
}

function normalizePositiveInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidOption(field, `must be an integer in [${String(min)}, ${String(max)}]`);
  }
  return value;
}

const DEFAULT_MAX_SEQUENCE_LENGTH = 512;
const DEFAULT_WINDOW_OVERLAP_TOKENS = 128;
const DEFAULT_MAX_WINDOWS = 64;

interface ResolvedInjectionClassifierOptions {
  modelDir: string;
  labelThreshold: number;
  maxSequenceLength: number;
  windowOverlapTokens: number;
  maxWindows: number;
  backendFactory: InjectionClassifierBackendFactory;
}

function resolveOptions(options: InjectionClassifierOptions): ResolvedInjectionClassifierOptions {
  if (typeof options.modelDir !== 'string' || !options.modelDir.trim()) {
    throw invalidOption('modelDir', 'must be a non-empty string');
  }
  const maxSequenceLength = normalizePositiveInteger(
    options.maxSequenceLength ?? DEFAULT_MAX_SEQUENCE_LENGTH,
    'maxSequenceLength',
    16,
    DEFAULT_MAX_SEQUENCE_LENGTH,
  );
  const windowOverlapTokens = normalizePositiveInteger(
    options.windowOverlapTokens ?? DEFAULT_WINDOW_OVERLAP_TOKENS,
    'windowOverlapTokens',
    0,
    maxSequenceLength - 3,
  );
  return {
    modelDir: resolve(options.modelDir.trim()),
    labelThreshold: normalizeProbability(options.labelThreshold, 'labelThreshold'),
    maxSequenceLength,
    windowOverlapTokens,
    maxWindows: normalizePositiveInteger(
      options.maxWindows ?? DEFAULT_MAX_WINDOWS,
      'maxWindows',
      1,
      4096,
    ),
    backendFactory: options.backendFactory ?? createTransformersInjectionBackend,
  };
}

// ── Default backend (@huggingface/transformers + onnxruntime-node) ──

/**
 * Files the provisioning step must have placed in `modelDir`. Checked before
 * touching transformers.js so a missing provision fails with an actionable
 * message instead of a library resolution error.
 */
export const INJECTION_CLASSIFIER_REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  join('onnx', 'model.onnx'),
] as const;

export function assertInjectionModelProvisioned(modelDir: string): void {
  const missing = INJECTION_CLASSIFIER_REQUIRED_FILES
    .filter((file) => !existsSync(join(modelDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `Injection classifier model is not provisioned at ${modelDir} `
      + `(missing: ${missing.join(', ')}). `
      + `Run \`npm run provision:injection-model -- --dest ${modelDir}\` to fetch `
      + `${INJECTION_CLASSIFIER_MODEL_ID}@${INJECTION_CLASSIFIER_MODEL_REVISION} `
      + '(pinned revision, sha256-verified). The classifier never downloads at runtime.',
    );
  }
}

interface TransformersTokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
}

interface TransformersLogitsOutputLike {
  logits?: { data?: ArrayLike<number | bigint>; dims?: readonly number[] };
}

interface TransformersModelLike {
  config: { id2label?: Record<string, string> };
  (inputs: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
}

function softmaxPair(safeLogit: number, injectionLogit: number): number {
  const max = Math.max(safeLogit, injectionLogit);
  const expSafe = Math.exp(safeLogit - max);
  const expInjection = Math.exp(injectionLogit - max);
  return expInjection / (expSafe + expInjection);
}

async function createTransformersInjectionBackend(
  modelDir: string,
): Promise<InjectionClassifierBackend> {
  assertInjectionModelProvisioned(modelDir);

  const { AutoTokenizer, AutoModelForSequenceClassification, Tensor } =
    await import('@huggingface/transformers');

  // local_files_only is per-call: never mutate the global transformers env,
  // which other components (emotion classifier, embeddings) rely on.
  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, {
    local_files_only: true,
  }) as unknown as TransformersTokenizerLike;
  const model = await AutoModelForSequenceClassification.from_pretrained(modelDir, {
    local_files_only: true,
    dtype: 'fp32',
  }) as unknown as TransformersModelLike;

  const id2label = model.config.id2label ?? {};
  const labelEntries = Object.entries(id2label);
  const injectionEntry = labelEntries.find(([, label]) => label === 'INJECTION');
  const safeEntry = labelEntries.find(([, label]) => label === 'SAFE');
  if (labelEntries.length !== 2 || !injectionEntry || !safeEntry) {
    await model.dispose();
    throw new Error(
      `Injection classifier model at ${modelDir} has unexpected labels `
      + `${JSON.stringify(id2label)}; expected exactly {SAFE, INJECTION}`,
    );
  }
  const injectionIndex = Number(injectionEntry[0]);
  const safeIndex = Number(safeEntry[0]);

  const boundary = tokenizer.encode('');
  if (boundary.length !== 2) {
    await model.dispose();
    throw new Error(
      `Injection classifier tokenizer at ${modelDir} produced ${String(boundary.length)} `
      + 'special tokens for empty input; expected exactly [CLS, SEP]',
    );
  }
  const [clsTokenId, sepTokenId] = boundary as [number, number];

  return {
    clsTokenId,
    sepTokenId,
    encode: (text) => Promise.resolve(tokenizer.encode(text, { add_special_tokens: false })),
    encodeWithSpecialTokens: (text) => Promise.resolve(tokenizer.encode(text)),
    async injectionProbability(inputIds) {
      const length = inputIds.length;
      const inputTensor = new Tensor(
        'int64',
        BigInt64Array.from(inputIds, (id) => BigInt(id)),
        [1, length],
      );
      const attentionTensor = new Tensor(
        'int64',
        BigInt64Array.from({ length }, () => 1n),
        [1, length],
      );
      const output = await model({ input_ids: inputTensor, attention_mask: attentionTensor });
      const logits = (output as TransformersLogitsOutputLike).logits;
      const data = logits?.data;
      if (!data || data.length !== 2) {
        throw new Error(
          `Injection classifier returned malformed logits (length ${String(data?.length ?? 'none')}); expected 2`,
        );
      }
      const injectionLogit = Number(data[injectionIndex]);
      const safeLogit = Number(data[safeIndex]);
      if (!Number.isFinite(injectionLogit) || !Number.isFinite(safeLogit)) {
        throw new Error('Injection classifier returned non-finite logits');
      }
      return softmaxPair(safeLogit, injectionLogit);
    },
    dispose: () => model.dispose(),
  };
}

// ── Classifier ──

function windowTokenIds(
  ids: readonly number[],
  contentCapacity: number,
  overlap: number,
  maxWindows: number,
): number[][] {
  const advance = contentCapacity - overlap;
  const windows: number[][] = [];
  for (let start = 0; ; start += advance) {
    windows.push(ids.slice(start, start + contentCapacity));
    if (start + contentCapacity >= ids.length) break;
    if (windows.length >= maxWindows) {
      throw new Error(
        `Injection classifier input exceeds ${String(maxWindows)} windows `
        + `(${String(ids.length)} tokens); refusing to score a partially covered item`,
      );
    }
  }
  return windows;
}

class OnnxInjectionClassifier implements InjectionClassifier {
  constructor(
    private readonly backend: InjectionClassifierBackend,
    private readonly options: ResolvedInjectionClassifierOptions,
  ) {}

  async classify(text: string): Promise<InjectionClassification> {
    if (typeof text !== 'string') {
      throw new TypeError('Injection classifier input must be a string');
    }
    if (!text.trim()) {
      throw new RangeError('Injection classifier input must be non-empty');
    }
    const startedAt = performance.now();

    const ids = await this.backend.encode(text);
    if (ids.length === 0) {
      throw new Error(
        'Injection classifier input tokenized to zero tokens; refusing to emit a score for unscoreable content',
      );
    }
    const contentCapacity = this.options.maxSequenceLength - 2;
    const windows = windowTokenIds(
      ids,
      contentCapacity,
      this.options.windowOverlapTokens,
      this.options.maxWindows,
    );

    let score = 0;
    for (const window of windows) {
      const probability = await this.backend.injectionProbability([
        this.backend.clsTokenId,
        ...window,
        this.backend.sepTokenId,
      ]);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error(
          `Injection classifier backend returned an out-of-range probability: ${String(probability)}`,
        );
      }
      score = Math.max(score, probability);
    }

    return {
      score,
      labels: score >= this.options.labelThreshold ? [INJECTION_CLASSIFIER_RISK_LABEL] : [],
      windowCount: windows.length,
      tokenCount: ids.length,
      latencyMs: performance.now() - startedAt,
    };
  }

  tokenize(text: string): Promise<number[]> {
    return this.backend.encodeWithSpecialTokens(text);
  }

  dispose(): Promise<void> {
    return this.backend.dispose();
  }
}

/**
 * Loads and warms the classifier. Fails closed at creation time: missing
 * weights, unexpected label maps, or a broken tokenizer throw here rather
 * than on the first screened item.
 */
export async function createInjectionClassifier(
  options: InjectionClassifierOptions,
): Promise<InjectionClassifier> {
  const resolved = resolveOptions(options);
  const backend = await resolved.backendFactory(resolved.modelDir);
  const classifier = new OnnxInjectionClassifier(backend, resolved);
  try {
    // Forces tokenizer + ONNX session initialization so per-item latency is
    // steady-state from the first real classification.
    await classifier.classify('__psfn_injection_classifier_warmup__');
  } catch (error) {
    await backend.dispose();
    throw new Error(
      `Injection classifier warmup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return classifier;
}
