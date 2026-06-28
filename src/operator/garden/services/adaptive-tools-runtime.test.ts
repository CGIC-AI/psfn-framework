import { describe, expect, it } from 'vitest';
import { deriveToolHealthViews, deriveToolInventoryGroups } from './adaptive-tools-runtime.js';

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
            name: 'notify',
            description: 'Unified notification surface for operator briefs, lightweight outbound sends, and approval escalation.',
            scope: 'extended',
            wiringMeta: {
              requiredServices: ['ntfy'],
              requiredGatewayMethods: ['discord.send', 'notify.ntfy'],
              concurrency: {
                class: 'exclusive',
                exclusivityKeyPolicy: 'category_tool_name',
                exclusivityKey: 'extended:notify',
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
        extendedTools: ['notify', 'heartbeat_run_template'],
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

    const notifyOperator = views.find((entry) => entry.name === 'notify');
    expect(notifyOperator).toMatchObject({
      health: {
        status: 'healthy',
      },
      contexts: {
        chat: {
          status: 'available',
        },
        internalHeartbeat: {
          status: 'available',
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

    expect(deriveToolInventoryGroups(views)).toEqual([
      expect.objectContaining({
        key: 'control_surface',
        title: 'Control Surface',
        accent: 'bg-moss-400',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'tool_search' }),
          expect.objectContaining({ name: 'toolset' }),
        ]),
      }),
      expect.objectContaining({
        key: 'managed_toolset',
        title: 'Managed Toolset',
        accent: 'bg-gold-400',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'notify' }),
          expect.objectContaining({ name: 'heartbeat_run_template' }),
        ]),
      }),
    ]);
  });

  it('shows external vault bridge health and degrades when gateway action coverage is partial', () => {
    const views = deriveToolHealthViews({
      catalog: {
        generatedAt: 1,
        tools: [
          {
            name: 'vault',
            description: 'Legacy external Obsidian/Vault bridge for bounded read, write, search, and daily-note compatibility.',
            scope: 'extended',
            wiringMeta: {
              requiredServices: ['vault'],
              requiredGatewayMethods: ['vault.write', 'vault.read', 'vault.search', 'vault.daily'],
            },
          },
        ],
      },
      state: {
        generatedAt: 2,
        coreTools: [],
        extendedTools: ['vault'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      },
      serviceHealth: [
        {
          serviceId: 'gateway',
          status: 'healthy',
          detail: 'Gateway is configured.',
          checkedAt: 1,
        },
        {
          serviceId: 'vault',
          status: 'healthy',
          detail: 'Gateway vault RPC is enabled for read, search.',
          checkedAt: 1,
          availableActions: ['read', 'search'],
        },
      ],
      recentFailures: [],
    });

    expect(views).toEqual([
      expect.objectContaining({
        name: 'vault',
        health: {
          status: 'degraded',
          detail: 'External vault bridge is missing actions required by the tool: write, daily.',
        },
        contexts: {
          chat: {
            status: 'available',
            detail: 'Extended tool can be activated or pinned on demand.',
          },
          internalHeartbeat: {
            status: 'available',
            detail: 'Extended tool can be activated or pinned on demand.',
          },
        },
      }),
    ]);
  });

  it('adds a conditional external vault bridge tool when vault service health is unavailable', () => {
    const views = deriveToolHealthViews({
      catalog: {
        generatedAt: 1,
        tools: [],
      },
      state: null,
      serviceHealth: [
        {
          serviceId: 'vault',
          status: 'unavailable',
          detail: 'Gateway vault RPC is enabled but operations are not configured.',
          checkedAt: 1,
        },
      ],
      recentFailures: [],
    });

    expect(views).toEqual([
      expect.objectContaining({
        name: 'vault',
        scope: 'conditional',
        health: {
          status: 'unavailable',
          detail: 'Gateway vault RPC is enabled but operations are not configured.',
        },
      }),
    ]);
  });
});
