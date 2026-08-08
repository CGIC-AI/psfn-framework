import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_LLM_TRANSPORT_FILES } from '../verify-model-usage-capture.mjs';

test('limits direct model transport to the canonical LLM capability boundary', () => {
  assert.deepEqual(
    [...CANONICAL_LLM_TRANSPORT_FILES].sort(),
    [
      'src/primitives/llm/client-request-capability.ts',
      'src/primitives/llm/client-stream-capability.ts',
      'src/primitives/llm/client.ts',
      'src/primitives/llm/provider-runtime.ts',
    ],
  );
});
