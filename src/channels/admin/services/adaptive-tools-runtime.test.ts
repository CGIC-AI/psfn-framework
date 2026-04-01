import { describe, expect, it } from 'vitest';
import { deriveToolHealthViews } from './adaptive-tools-runtime.js';

describe('deriveToolHealthViews', () => {
  it('marks chat and internal heartbeat availability from runtime metadata', () => {
    const views = deriveToolHealthViews({
      catalog: {
        generatedAt: 1,
        tools: [
          {
            name: 'tool_search',
            description: 'Search the non-default tool catalog.',
            scope: 'core',
          },
          {
            name: 'notify_operator',
            description: 'Send an out-of-band operator alert via ntfy.',
            scope: 'extended',
            wiringMeta: {
              requiredServices: ['ntfy'],
              contextRestrictions: {
                disallowInternal: true,
                disallowScheduled: true,
              },
              concurrency: {
                class: 'exclusive',
                exclusivityKeyPolicy: 'category_tool_name',
                exclusivityKey: 'extended:notify_operator',
                interruptibility: 'cooperative',
                eligibility: {
                  foreground: true,
                  background: true,
                },
              },
            },
          },
          {
            name: 'heartbeat_run_template',
            description: 'Run a heartbeat reflection template.',
            scope: 'extended',
            wiringMeta: {
              concurrency: {
                class: 'exclusive',
                exclusivityKeyPolicy: 'category_tool_name',
                exclusivityKey: 'extended:heartbeat_run_template',
                interruptibility: 'cooperative',
                eligibility: {
                  foreground: false,
                  background: true,
                },
              },
            },
          },
          {
            name: 'toolset',
            description: 'Manage non-default tool activation and pinned tools.',
            scope: 'core',
          },
        ],
      },
      state: {
        generatedAt: 2,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['notify_operator', 'heartbeat_run_template'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [
          {
            toolName: 'heartbeat_run_template',
            source: 'autoload',
            activatedAt: 2,
            lastActivatedAt: 2,
          },
        ],
        activeTools: [
          { toolName: 'tool_search', source: 'core' },
          { toolName: 'toolset', source: 'core' },
          { toolName: 'heartbeat_run_template', source: 'autoload' },
        ],
        lastSnapshot: null,
      },
      serviceHealth: [
        {
          serviceId: 'ntfy',
          status: 'healthy',
          detail: 'Configured.',
          checkedAt: 1,
        },
      ],
      recentFailures: [
        {
          toolName: 'toolset',
          channelId: 'api-session',
          message: 'toolset failed once',
          timestamp: 3,
        },
      ],
    });

    const notifyOperator = views.find((entry) => entry.name === 'notify_operator');
    expect(notifyOperator).toMatchObject({
      health: {
        status: 'healthy',
      },
      contexts: {
        chat: {
          status: 'available',
        },
        internalHeartbeat: {
          status: 'not_applicable',
          detail: 'Blocked on internal channels.',
        },
      },
    });

    const toolSearch = views.find((entry) => entry.name === 'tool_search');
    expect(toolSearch).toMatchObject({
      health: {
        status: 'healthy',
      },
      contexts: {
        chat: {
          status: 'active',
          source: 'core',
        },
      },
    });

    const heartbeatTool = views.find((entry) => entry.name === 'heartbeat_run_template');
    expect(heartbeatTool).toMatchObject({
      contexts: {
        chat: {
          status: 'not_applicable',
          detail: 'Background-only tool; not available during direct turns.',
        },
        internalHeartbeat: {
          status: 'active',
          source: 'autoload',
        },
      },
    });

    const toolset = views.find((entry) => entry.name === 'toolset');
    expect(toolset).toMatchObject({
      health: {
        status: 'degraded',
        detail: 'Last failure: toolset failed once',
      },
      contexts: {
        chat: {
          status: 'active',
          source: 'core',
        },
      },
    });
  });
});
