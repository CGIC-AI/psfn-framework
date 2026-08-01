import { describe, expect, it } from 'vitest';
import type { DisclosureLineage } from './contracts.js';
import {
  admittedToolResultRequiresConfidentialFloor,
  applyAdmittedToolResultDisclosureFloor,
} from './mcp-turn-context.js';

describe('admittedToolResultRequiresConfidentialFloor', () => {
  it.each(['catalog', 'search', 'inspect', 'release'])(
    'preserves sensitivity for screened MCP %s metadata',
    (action) => {
      expect(admittedToolResultRequiresConfidentialFloor({
        toolName: 'mcp',
        arguments: { action },
      })).toBe(false);
    },
  );

  it.each([
    { toolName: 'mcp', arguments: { action: 'call' } },
    { toolName: 'mcp', arguments: {} },
    { toolName: 'fs', arguments: { path: '/tmp/a' } },
  ])('keeps the confidential floor for content-bearing results: $toolName', (input) => {
    expect(admittedToolResultRequiresConfidentialFloor(input)).toBe(true);
  });

  it('keeps a public search-inspect sequence usable and tightens after the remote call', () => {
    const publicLineage = { effectiveSensitivity: 'public' } as DisclosureLineage;
    const afterSearch = applyAdmittedToolResultDisclosureFloor(publicLineage, {
      toolName: 'mcp',
      arguments: { action: 'search', query: 'game' },
    });
    const afterInspect = applyAdmittedToolResultDisclosureFloor(afterSearch, {
      toolName: 'mcp',
      arguments: { action: 'inspect', server_id: 'game', tool_name: 'move' },
    });
    const afterCall = applyAdmittedToolResultDisclosureFloor(afterInspect, {
      toolName: 'mcp',
      arguments: { action: 'call', server_id: 'game', tool_name: 'move', arguments: { move: 'e4' } },
    });

    expect(afterSearch?.effectiveSensitivity).toBe('public');
    expect(afterInspect?.effectiveSensitivity).toBe('public');
    expect(afterCall?.effectiveSensitivity).toBe('confidential');
  });
});
