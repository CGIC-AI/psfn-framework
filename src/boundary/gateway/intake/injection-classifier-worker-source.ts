// L1.5 injection classifier worker (psfn-framework-3mbpi).
//
// Evaluated as a worker thread (the same `eval: true` pattern as the session
// integrity worker, so it runs identically from source and from the bundled
// gateway). Each worker loads the tokenizer and ONNX model ONCE, then serves
// three calls: `encode` (tokenize without special tokens), `encodeSpecial`
// (tokenize with [CLS]/[SEP]) and `probability` (P(INJECTION) for one window).
// The operations mirror the in-process transformers backend in
// injection-classifier.ts exactly — same loader options, label map checks and
// softmax — so scores are identical; the parity test pins that.

export const INJECTION_CLASSIFIER_WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');

if (!parentPort) {
  throw new Error('Injection classifier worker requires a parent port');
}

let tokenizer = null;
let model = null;
let Tensor = null;
let injectionIndex = -1;
let safeIndex = -1;

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

function softmaxPair(safeLogit, injectionLogit) {
  const max = Math.max(safeLogit, injectionLogit);
  const expSafe = Math.exp(safeLogit - max);
  const expInjection = Math.exp(injectionLogit - max);
  return expInjection / (expSafe + expInjection);
}

async function init(modelDir) {
  const transformers = await import('@huggingface/transformers');
  Tensor = transformers.Tensor;
  tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
  model = await transformers.AutoModelForSequenceClassification.from_pretrained(modelDir, {
    local_files_only: true,
    dtype: 'fp32',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  const labels = Object.entries((model.config && model.config.id2label) || {});
  const injection = labels.find(([, label]) => label === 'INJECTION');
  const safe = labels.find(([, label]) => label === 'SAFE');
  if (labels.length !== 2 || !injection || !safe) {
    throw new Error('Injection classifier model at ' + modelDir + ' has unexpected labels; expected exactly {SAFE, INJECTION}');
  }
  injectionIndex = Number(injection[0]);
  safeIndex = Number(safe[0]);
  const boundary = tokenizer.encode('');
  if (boundary.length !== 2) {
    throw new Error('Injection classifier tokenizer produced ' + boundary.length + ' special tokens for empty input; expected exactly [CLS, SEP]');
  }
  return { clsTokenId: boundary[0], sepTokenId: boundary[1] };
}

async function probability(inputIds) {
  const length = inputIds.length;
  const inputTensor = new Tensor('int64', BigInt64Array.from(inputIds, (id) => BigInt(id)), [1, length]);
  const attentionTensor = new Tensor('int64', BigInt64Array.from({ length }, () => 1n), [1, length]);
  const output = await model({ input_ids: inputTensor, attention_mask: attentionTensor });
  const data = output && output.logits && output.logits.data;
  if (!data || data.length !== 2) {
    throw new Error('Injection classifier returned malformed logits; expected 2');
  }
  const injectionLogit = Number(data[injectionIndex]);
  const safeLogit = Number(data[safeIndex]);
  if (!Number.isFinite(injectionLogit) || !Number.isFinite(safeLogit)) {
    throw new Error('Injection classifier returned non-finite logits');
  }
  return softmaxPair(safeLogit, injectionLogit);
}

parentPort.on('message', async (message) => {
  const id = message && message.id;
  try {
    let result;
    if (message.type === 'init') {
      result = await init(message.modelDir);
    } else if (!tokenizer || !model) {
      throw new Error('Injection classifier worker is not initialized');
    } else if (message.type === 'encode') {
      result = tokenizer.encode(message.text, { add_special_tokens: false });
    } else if (message.type === 'encodeSpecial') {
      result = tokenizer.encode(message.text);
    } else if (message.type === 'probability') {
      result = await probability(message.inputIds);
    } else if (message.type === 'dispose') {
      await model.dispose();
      result = true;
    } else {
      throw new Error('Unknown injection classifier worker call: ' + String(message.type));
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: errorMessage(error) });
  }
});
`;
