import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceProviderSelection } from './voice-provider-selection';

test('uses only explicit provider ids from settings payload', () => {
  assert.deepEqual(
    resolveVoiceProviderSelection({
      ttsProvider: 'echo',
      sttProvider: 'deepgram',
    }),
    {
      ttsProvider: 'echo',
      sttProvider: 'deepgram',
    },
  );
});

test('defaults both providers to disabled when settings payload is unset or blank', () => {
  assert.deepEqual(resolveVoiceProviderSelection({}), {
    ttsProvider: 'disabled',
    sttProvider: 'disabled',
  });
  assert.deepEqual(resolveVoiceProviderSelection({
    ttsProvider: '   ',
    sttProvider: '   ',
  }), {
    ttsProvider: 'disabled',
    sttProvider: 'disabled',
  });
});

test('does not infer sttProvider from credential-shaped payload keys', () => {
  assert.deepEqual(
    resolveVoiceProviderSelection({
      deepgramApiKey: 'secret',
    } as { sttProvider?: unknown; ttsProvider?: unknown }),
    {
      ttsProvider: 'disabled',
      sttProvider: 'disabled',
    },
  );
});
