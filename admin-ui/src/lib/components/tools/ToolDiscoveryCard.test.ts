import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AdminToolHealthView } from '$lib/types/tools';
import ToolDiscoveryCard from './ToolDiscoveryCard.svelte';

function tool(name: 'tool_search' | 'toolset', actions: string[]): AdminToolHealthView {
  return {
    name,
    description: `${name} description`,
    scope: 'core',
    health: { status: 'healthy', detail: `${name} ready` },
    contexts: {
      chat: { status: 'available', detail: 'available' },
      internalHeartbeat: { status: 'available', detail: 'available' },
    },
    schema: {
      actions: actions.map(action => ({ name: action, requiredCapabilities: [] })),
      requiredParameters: [],
      requiredCapabilities: [],
      bundleMembership: [],
      reversibility: 'reversible',
    },
  };
}

describe('ToolDiscoveryCard', () => {
  it('renders discovery and toolset management as one canonical search surface', () => {
    const body = render(ToolDiscoveryCard, {
      props: {
        toolSearch: tool('tool_search', ['search']),
        toolset: tool('toolset', ['list', 'pin', 'unpin']),
      },
    }).body;

    expect(body.match(/<article/g)).toHaveLength(1);
    expect(body).toContain('Tool search');
    expect(body).toContain('Search actions');
    expect(body).toContain('Toolset management');
    expect(body).toContain('pin');
    expect(body).not.toContain('<code class="text-sm font-medium text-shadow-900">toolset</code>');
  });
});
