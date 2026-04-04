import { describe, expect, it } from 'vitest';
import { readActiveTurnToolSchemas } from './turn-tool-context.js';

describe('readActiveTurnToolSchemas', () => {
  it('returns deduped tool schemas in canonical name order', () => {
    const schemas = readActiveTurnToolSchemas({
      state: {
        tools: [
          {
            name: 'zeta_tool',
            description: 'zeta',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'alpha_tool',
            description: 'alpha',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'zeta_tool',
            description: 'replacement zeta',
            inputSchema: { type: 'object', properties: { replacement: { type: 'boolean' } } },
          },
        ],
      },
    });

    expect(schemas.map((schema) => schema.name)).toEqual(['alpha_tool', 'zeta_tool']);
    expect(schemas[1]).toMatchObject({
      name: 'zeta_tool',
      description: 'replacement zeta',
      inputSchema: {
        properties: {
          replacement: { type: 'boolean' },
        },
      },
    });
  });
});
