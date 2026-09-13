import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../../shared/utils/types.js';

// Fixed ONNX IR8/opset13 graph: three int64 [batch, sequence] BERT inputs,
// one Constant node producing float32 logits [[0, 1]]. This exercises the real
// tokenizer/native inference/warmup lifecycle, not classification accuracy.
const MODEL_BASE64 = 'CAgSGHBzZm4taWRsZS1wdXJpdHktZml4dHVyZTr+AQpBEgZsb2dpdHMiCENvbnN0YW50Ki0KBXZhbHVlKiEKAgECEAEiCAAAAAAAAIA/Qg9jb25zdGFudF9sb2dpdHOgAQQSF2NvbnN0YW50LWVtb3Rpb24tbG9naXRzWigKCWlucHV0X2lkcxIbChkIBxIVCgcSBWJhdGNoCgoSCHNlcXVlbmNlWi0KDmF0dGVudGlvbl9tYXNrEhsKGQgHEhUKBxIFYmF0Y2gKChIIc2VxdWVuY2VaLQoOdG9rZW5fdHlwZV9pZHMSGwoZCAcSFQoHEgViYXRjaAoKEghzZXF1ZW5jZWIYCgZsb2dpdHMSDgoMCAESCAoCCAEKAggCQgQKABAN';

export function configureIdlePurityEmotionFixture(fixture: {
  runtimeRoot: string; systemDataDir: string;
}): void {
  const modelPath = join(fixture.runtimeRoot, 'models', 'idle-purity-emotion');
  mkdirSync(join(modelPath, 'onnx'), { recursive: true });
  const json = (name: string, value: unknown): void => {
    writeFileSync(join(modelPath, name), `${JSON.stringify(value)}\n`);
  };
  json('config.json', { model_type: 'bert', architectures: ['BertForSequenceClassification'],
    id2label: { 0: 'neutral', 1: 'joy' }, label2id: { neutral: 0, joy: 1 }, num_labels: 2 });
  json('tokenizer_config.json', { tokenizer_class: 'BertTokenizer', model_max_length: 512,
    unk_token: '[UNK]', sep_token: '[SEP]', pad_token: '[PAD]', cls_token: '[CLS]', mask_token: '[MASK]' });
  json('tokenizer.json', {
    version: '1.0', truncation: null, padding: null, added_tokens: [],
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: { type: 'BertProcessing', sep: ['[SEP]', 3], cls: ['[CLS]', 2] },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100,
      vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, '[MASK]': 4 } },
  });
  writeFileSync(join(modelPath, 'onnx', 'model.onnx'), Buffer.from(MODEL_BASE64, 'base64'));
  const settingsPath = join(fixture.systemDataDir, 'settings.json');
  const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!isRecord(settings)) throw new Error('Idle-purity settings fixture must be an object');
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings,
    textEmotionModel: modelPath, textEmotionCacheDir: join(modelPath, 'cache'), textEmotionDtype: 'fp32',
  })}\n`);
}
