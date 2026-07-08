import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from '../../contacts/store.js';
import { createContactTool } from '../../contacts/tools.js';
import { readActiveTurnToolSchemas } from './turn-tool-context.js';
import { toPiTools } from '../../../primitives/llm/conversion.js';
import type { ToolSchema } from '../../../shared/contracts/runtime.js';

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

/**
 * Bead psfn-framework-u9jo.1 AC1/AC4: the tool definitions captured into the
 * turn snapshot must be byte-equal to the tools array serialized to the
 * provider — full name, description, and input schema, with nothing omitted —
 * for both DM and group turns.
 *
 * `readActiveTurnToolSchemas` reads exactly `agent.state.tools` (the same array
 * the agent serializes to the provider); `toPiTools` is the provider serializer.
 */
function makeAgentTools(): ToolSchema[] {
  return [
    {
      name: 'search_memory',
      description: 'Search long-term memory for relevant entries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          filters: {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' } },
              since: { type: 'string', format: 'date-time' },
            },
            additionalProperties: false,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'analysis_workbench',
      description: 'Run a sandboxed analysis task.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
  ];
}

describe('turn snapshot tool definitions are byte-equal to the provider payload', () => {
  for (const scenario of [
    { label: 'DM turn', channelId: 'discord:dm:contact-42' },
    { label: 'group turn', channelId: 'discord:guild:room-7' },
  ]) {
    it(`preserves provider-byte-equal tool schemas for a ${scenario.label}`, () => {
      const sourceTools = makeAgentTools();
      const agent = {
        channelId: scenario.channelId,
        state: { tools: sourceTools.map(tool => ({ ...tool })) },
      };

      const captured = readActiveTurnToolSchemas(agent);
      const providerPayloadTools = toPiTools(captured);

      for (const source of sourceTools) {
        const capturedTool = captured.find(tool => tool.name === source.name);
        expect(capturedTool, `captured schema for ${source.name}`).toBeDefined();
        // Input schema captured verbatim — no omission, no drift.
        expect(JSON.stringify(capturedTool?.inputSchema)).toBe(JSON.stringify(source.inputSchema));

        const providerTool = providerPayloadTools.find(tool => tool.name === source.name);
        expect(providerTool, `provider payload tool for ${source.name}`).toBeDefined();
        expect(providerTool?.description).toBe(source.description);
        // The provider serializer carries the input schema as `parameters`,
        // byte-for-byte.
        expect(JSON.stringify(providerTool?.parameters)).toBe(JSON.stringify(source.inputSchema));
      }

      expect(providerPayloadTools).toHaveLength(sourceTools.length);
    });
  }

  it('never omits or empties an input schema when capturing', () => {
    const captured = readActiveTurnToolSchemas({ state: { tools: makeAgentTools() } });
    expect(captured.length).toBeGreaterThan(0);
    for (const tool of captured) {
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
    }
  });
});
