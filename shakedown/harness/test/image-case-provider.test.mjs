import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImageGenerationCases,
  imageProviderProofFailures,
  resolveImageCaseProvider,
  resolveImageCaseProviderForCases,
} from '../lib/image-case-provider.mjs';

const EDIT_URLS = ['https://images.example.test/source.png'];

function successfulResult(toolName, provider) {
  return {
    toolName,
    isError: false,
    contentText: JSON.stringify({ status: 'image_generated', provider, mode: 'create', imageCount: 1 }),
  };
}

test('unset selects the deployment settings provider; an explicit round names its provider', () => {
  assert.equal(resolveImageCaseProviderForCases({ caseIds: new Set(['image_create']), phase: 'baseline' }, {}), 'settings');
  assert.equal(resolveImageCaseProviderForCases({ caseIds: new Set(), phase: 'apprentice' }, {}), 'settings');
  assert.equal(
    resolveImageCaseProviderForCases(
      { caseIds: new Set(), phase: 'apprentice' },
      { PSFN_SHAKEDOWN_IMAGE_PROVIDER: 'openrouter' },
    ),
    'openrouter',
  );
});

test('runs without image cases do not require a provider', () => {
  assert.equal(resolveImageCaseProviderForCases({ caseIds: new Set(['memory_write_patch']), phase: 'apprentice' }, {}), null);
  assert.equal(resolveImageCaseProviderForCases({ caseIds: new Set(), phase: 'baseline' }, {}), null);
  assert.equal(resolveImageCaseProviderForCases({ caseIds: new Set(), phase: 'nursery' }, {}), null);
});

test('an unknown provider is rejected', () => {
  assert.throws(
    () => resolveImageCaseProvider({ PSFN_SHAKEDOWN_IMAGE_PROVIDER: 'midjourney' }),
    /expected one of settings, auto, fal, comfyui, comfyui_mcp, openrouter/u,
  );
});

test('no image case prompt hard-codes provider "auto"', () => {
  for (const provider of ['settings', 'openrouter', 'fal']) {
    for (const testCase of buildImageGenerationCases({ runToken: 'tok', provider, editSourceUrls: EDIT_URLS })) {
      assert.equal(testCase.message.includes('provider "auto"'), false, `${provider}/${testCase.id}`);
    }
  }
});

test('settings omits provider so the configured imageProvider selects', () => {
  const cases = buildImageGenerationCases({ runToken: 'tok', provider: 'settings', editSourceUrls: EDIT_URLS });
  assert.deepEqual(cases.map((testCase) => testCase.id), ['image_create', 'image_edit', 'selfie_create']);
  for (const testCase of cases) {
    assert.equal(/provider "/u.test(testCase.message), false, testCase.id);
  }
});

test('an explicit openrouter round passes the provider and requires an openrouter result', () => {
  const cases = buildImageGenerationCases({ runToken: 'tok', provider: 'openrouter', editSourceUrls: EDIT_URLS });
  for (const testCase of cases) {
    assert.match(testCase.message, /provider "openrouter", /u);
  }
  const [imageCreate, , selfie] = cases;
  assert.deepEqual(
    imageCreate.validateParsedAssistant({
      parsedAssistant: { worked: true },
      archiveToolMessages: [successfulResult('generate_image', 'openrouter')],
    }),
    [],
  );
  // A companion claim alone, or a result from another provider, is not proof.
  assert.deepEqual(
    imageCreate.validateParsedAssistant({ parsedAssistant: { worked: true }, archiveToolMessages: [] }),
    ['generate_image must succeed on provider "openrouter"; observed no successful provider result'],
  );
  assert.deepEqual(
    selfie.validateParsedAssistant({
      parsedAssistant: { worked: true },
      archiveToolMessages: [successfulResult('selfie_create', 'comfyui')],
    }),
    ['selfie_create must succeed on provider "openrouter"; observed comfyui'],
  );
});

test('failed tool results never count as provider proof', () => {
  assert.deepEqual(
    imageProviderProofFailures([
      { ...successfulResult('generate_image', 'openrouter'), isError: true },
    ], 'generate_image', 'openrouter'),
    ['generate_image must succeed on provider "openrouter"; observed no successful provider result'],
  );
});

test('settings rounds keep the worked-or-tool-success verdict', () => {
  const [imageCreate] = buildImageGenerationCases({ runToken: 'tok', provider: 'settings', editSourceUrls: EDIT_URLS });
  assert.deepEqual(
    imageCreate.validateParsedAssistant({
      parsedAssistant: {},
      archiveToolMessages: [successfulResult('generate_image', 'openrouter')],
    }),
    [],
  );
  assert.deepEqual(
    imageCreate.validateParsedAssistant({ parsedAssistant: {}, archiveToolMessages: [] }),
    ['image_create worked must be true or have successful generate_image tool proof'],
  );
});
