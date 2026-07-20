import assert from 'node:assert/strict';
import { test } from 'vitest';
import { writePromptMonitorClipboard } from './PromptMonitorTextBlock.helpers';

test('clipboard helper writes the complete text without normalization', async () => {
  let copied = '';
  await writePromptMonitorClipboard('  complete\ntext  ', {
    async writeText(value) {
      copied = value;
    },
  });

  assert.equal(copied, '  complete\ntext  ');
});

test('clipboard helper fails explicitly when clipboard access is unavailable', async () => {
  await assert.rejects(
    () => writePromptMonitorClipboard('text', undefined),
    /Clipboard access is unavailable/,
  );
});
