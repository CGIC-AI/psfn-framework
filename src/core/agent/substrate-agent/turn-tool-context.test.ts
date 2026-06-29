import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from '../../contacts/store.js';
import { createContactTool } from '../../contacts/tools.js';
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

  it('preserves improved contact search guidance for Garden turn snapshots', () => {
    const db = new Database(':memory:');
    try {
      const contactTool = createContactTool(new ContactStore(db, 'primary-user'));
      const schemas = readActiveTurnToolSchemas({
        state: {
          tools: [{
            name: contactTool.name,
            description: contactTool.description,
            inputSchema: contactTool.parameters,
          }],
        },
      });

      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toMatchObject({
        name: 'contact',
        description: expect.stringContaining('action=search with query'),
        inputSchema: {
          properties: {
            query: expect.objectContaining({
              description: expect.stringContaining('Required for action=search'),
            }),
          },
        },
      });
    } finally {
      db.close();
    }
  });
});
