import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionTools,
  normalizeTransportTools,
} from './transport-tool-schema.js';

describe('transport tool schema authority', () => {
  it('never treats a model-only schema as execution authority', () => {
    const tool = {
      name: 'notify',
      description: 'Notify an operator.',
      modelParameters: {
        type: 'object',
        properties: { action: { type: 'string' } },
      },
    };

    expect(normalizeTransportTools([tool])).toEqual([{
      name: 'notify',
      description: 'Notify an operator.',
      inputSchema: tool.modelParameters,
    }]);
    expect(() => normalizeExecutionTools([tool]))
      .toThrow('inputSchema or parameters must be an object');
  });
});
