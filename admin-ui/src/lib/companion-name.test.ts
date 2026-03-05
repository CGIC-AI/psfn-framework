// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  companionNameFromChatBootstrap,
  DEFAULT_COMPANION_NAME,
  normalizeCompanionName,
  normalizeModelRoomBootstrap,
} from './companion-name';

test('normalizes companion names with trimming and fallback', () => {
  assert.equal(normalizeCompanionName('  Nova  '), 'Nova');
  assert.equal(normalizeCompanionName('   '), DEFAULT_COMPANION_NAME);
  assert.equal(normalizeCompanionName(undefined), DEFAULT_COMPANION_NAME);
});

test('derives companion name from chat bootstrap assistantName', () => {
  assert.equal(companionNameFromChatBootstrap({ assistantName: '  Aimi  ' }), 'Aimi');
  assert.equal(companionNameFromChatBootstrap({ assistantName: '' }), DEFAULT_COMPANION_NAME);
});

test('maps legacy model-room psfn payloads to companion', () => {
  const normalized = normalizeModelRoomBootstrap({
    api: { chatCompletionsUrl: '/v1/chat/completions' },
    defaultRoomId: 'garden-model-room',
    psfn: {
      id: 'psfn',
      displayName: '  Aimi  ',
      defaultSystemPromptMode: 'default',
    },
    participants: [],
    constraints: {
      allowedProviders: ['openai'],
      deniedProviders: [],
    },
  });

  assert.equal(normalized.companion.id, 'psfn');
  assert.equal(normalized.companion.displayName, 'Aimi');
});

test('provides a fallback companion when wire payload omits companion data', () => {
  const normalized = normalizeModelRoomBootstrap(
    {
      api: { chatCompletionsUrl: '/v1/chat/completions' },
      defaultRoomId: 'garden-model-room',
      participants: [],
      constraints: {
        allowedProviders: [],
        deniedProviders: [],
      },
    },
    'Orchid',
  );

  assert.equal(normalized.companion.id, 'companion');
  assert.equal(normalized.companion.displayName, 'Orchid');
});
