import { describe, it, expect } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
  validateToolWiring,
  validateAndLogToolWiring,
  extractGatewayMethods,
  resolveClientMethod,
  type ToolConcurrencyMeta,
  type WirableTool,
} from './tool-wiring-validator.js';

// ── Helpers ──

function makeTool(name: string, meta?: WirableTool['wiringMeta']): AgentTool<any> {
  const tool: WirableTool = {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
  if (meta) {
    tool.wiringMeta = meta;
  }
  return tool;
}

function makeConcurrencyMeta(
  toolClass: ToolConcurrencyMeta['class'],
  overrides?: Partial<ToolConcurrencyMeta>,
): ToolConcurrencyMeta {
  const eligibility = {
    foreground: true,
    background: true,
    ...(overrides?.eligibility ?? {}),
  };

  const base: ToolConcurrencyMeta = {
    class: toolClass,
    exclusivityKeyPolicy: toolClass === 'exclusive' ? 'category_tool_name' : 'none',
    ...(toolClass === 'exclusive' ? { exclusivityKey: 'core:test_tool' } : {}),
    ...(toolClass === 'exclusive' ? {} : { maxParallel: 3 }),
    interruptibility: toolClass === 'shard' ? 'non_interruptible' : 'cooperative',
    eligibility,
  };

  return {
    ...base,
    ...overrides,
    ...(overrides?.eligibility ? { eligibility: { ...eligibility, ...overrides.eligibility } } : {}),
  };
}

// ── Tests ──

describe('resolveClientMethod', () => {
  it('maps known RPC methods to client method names', () => {
    expect(resolveClientMethod('git.status')).toBe('gitStatus');
    expect(resolveClientMethod('git.diff')).toBe('gitDiff');
    expect(resolveClientMethod('git.create_branch')).toBe('gitCreateBranch');
    expect(resolveClientMethod('git.apply_patch')).toBe('gitApplyPatch');
    expect(resolveClientMethod('git.commit')).toBe('gitCommit');
    expect(resolveClientMethod('git.open_pr')).toBe('gitOpenPR');
    expect(resolveClientMethod('beads.ready')).toBe('beadsReady');
    expect(resolveClientMethod('beads.create')).toBe('beadsCreate');
    expect(resolveClientMethod('image.create')).toBe('imageCreate');
    expect(resolveClientMethod('image.edit')).toBe('imageEdit');
    expect(resolveClientMethod('llm.chat')).toBe('stream');
    expect(resolveClientMethod('llm.complete')).toBe('complete');
    expect(resolveClientMethod('discord.send')).toBe('discordSend');
    expect(resolveClientMethod('shell.exec')).toBe('shellExec');
  });

  it('falls back to the RPC name for unknown methods', () => {
    expect(resolveClientMethod('unknown.method')).toBe('unknown.method');
  });
});

describe('extractGatewayMethods', () => {
  it('extracts method names from an object prototype', () => {
    class FakeClient {
      gitStatus(): void { /* noop */ }
      gitDiff(): void { /* noop */ }
      embed(): void { /* noop */ }
    }
    const client = new FakeClient();
    const methods = extractGatewayMethods(client);
    expect(methods.has('gitStatus')).toBe(true);
    expect(methods.has('gitDiff')).toBe(true);
    expect(methods.has('embed')).toBe(true);
    // constructor should be excluded
    expect(methods.has('constructor')).toBe(false);
  });

  it('returns Object.prototype methods for plain objects', () => {
    const methods = extractGatewayMethods({});
    // Plain objects inherit from Object.prototype — they will have toString, etc.
    // The important thing is that custom client methods are included
    expect(methods.has('toString')).toBe(true);
    // But no custom methods
    expect(methods.has('gitStatus')).toBe(false);
  });
});

describe('validateToolWiring', () => {
  it('passes tools without wiringMeta', () => {
    const tools = [
      makeTool('memory_write'),
      makeTool('think'),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools,
    });
    expect(report.totalTools).toBe(2);
    expect(report.validTools).toBe(2);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('passes tools with satisfied gateway dependencies', () => {
    const tools = [
      makeTool('repo', {
        requiredGatewayMethods: ['git.status', 'git.diff', 'git.commit'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus', 'gitDiff', 'gitCommit']),
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(1);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('flags tools with missing gateway dependencies', () => {
    const tools = [
      makeTool('repo', {
        requiredGatewayMethods: ['git.status', 'git.commit'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo');
    expect(report.invalidTools[0].missingGatewayMethods).toEqual(['git.commit (client: gitCommit)']);
  });

  it('flags gateway-dependent tools with missing required metadata coverage', () => {
    const tools = [
      makeTool('repo'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitCommit']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage).toEqual([
      'requiredGatewayMethods metadata missing (expected: git.status, git.diff, git.apply_patch, git.commit, git.create_branch, git.open_pr)',
    ]);
  });

  it('includes shell in default gateway metadata coverage', () => {
    const report = validateToolWiring({
      mode: 'gateway',
      tools: [makeTool('shell')],
      gatewayClientMethods: new Set(['shellExec']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });

    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('shell');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('shell.exec');
  });

  it('requires unified beads tools to declare all beads gateway methods', () => {
    const report = validateToolWiring({
      mode: 'gateway',
      tools: [makeTool('beads')],
      gatewayClientMethods: new Set([
        'beadsReady',
        'beadsShow',
        'beadsCreate',
        'beadsUpdate',
        'beadsClose',
        'beadsSync',
      ]),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });

    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('beads');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('beads.ready');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('beads.sync');
  });

  it('flags gateway-dependent tools with partial metadata coverage', () => {
    const tools = [
      makeTool('repo', {
        requiredGatewayMethods: ['git.status'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus', 'gitCommit']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].missingGatewayMetadataCoverage).toEqual(expect.arrayContaining([
      'requiredGatewayMethods missing "git.diff"',
      'requiredGatewayMethods missing "git.apply_patch"',
      'requiredGatewayMethods missing "git.commit"',
      'requiredGatewayMethods missing "git.create_branch"',
      'requiredGatewayMethods missing "git.open_pr"',
    ]));
  });

  it('requires unified web tools to declare web.fetch gateway coverage', () => {
    const report = validateToolWiring({
      mode: 'gateway',
      tools: [makeTool('web')],
      gatewayClientMethods: new Set(['webFetch']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });

    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('web');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('web.fetch');
  });

  it('skips gateway method checks in direct runtime mode', () => {
    const tools = [
      makeTool('repo', {
        requiredGatewayMethods: ['git.status'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(1);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('flags tools with missing service dependencies', () => {
    const tools = [
      makeTool('custom_tool', {
        requiredServices: ['memoryStore', 'embeddingService'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools,
      availableServices: new Set(['memoryStore']),
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].missingServices).toEqual(['embeddingService']);
  });

  it('validates multiple missing dependencies on a single tool', () => {
    const tools = [
      makeTool('multi_dep_tool', {
        requiredGatewayMethods: ['git.status', 'git.nonexistent'],
        requiredServices: ['missing_service'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
      availableServices: new Set(),
    });
    expect(report.invalidTools).toHaveLength(1);
    const invalid = report.invalidTools[0];
    expect(invalid.missingGatewayMethods).toHaveLength(1);
    expect(invalid.missingGatewayMethods[0]).toContain('git.nonexistent');
    expect(invalid.missingServices).toEqual(['missing_service']);
  });

  it('handles empty tool list', () => {
    const report = validateToolWiring({
      mode: 'gateway',
      tools: [],
      gatewayClientMethods: new Set(),
    });
    expect(report.totalTools).toBe(0);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('handles mix of annotated and unannotated tools', () => {
    const tools = [
      makeTool('plain_tool'),
      makeTool('annotated_ok', { requiredGatewayMethods: ['git.status'] }),
      makeTool('annotated_bad', { requiredGatewayMethods: ['git.nonexistent'] }),
      makeTool('another_plain'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
    });
    expect(report.totalTools).toBe(4);
    expect(report.validTools).toBe(3);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('annotated_bad');
  });

  it('fails closed when concurrency metadata is required and missing', () => {
    const tools = [
      makeTool('repo', { requiredGatewayMethods: ['git.status'] }),
      makeTool('memory_write'),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools,
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(2);
    expect(report.invalidTools[0].missingConcurrencyMetadata).toContain('concurrency metadata missing');
    expect(report.invalidTools[1].missingConcurrencyMetadata).toContain('concurrency metadata missing');
  });

  it('accepts valid concurrency metadata when required', () => {
    const tools = [
      makeTool('repo', {
        requiredGatewayMethods: [
          'git.status',
          'git.diff',
          'git.apply_patch',
          'git.commit',
          'git.create_branch',
          'git.open_pr',
        ],
        concurrency: makeConcurrencyMeta('read_only', { maxParallel: 3 }),
      }),
      makeTool('memory_write', {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKey: 'core:memory_write',
          exclusivityKeyPolicy: 'static_key',
        }),
      }),
      makeTool('shard', {
        concurrency: makeConcurrencyMeta('shard', { maxParallel: 5 }),
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set([
        'gitStatus',
        'gitDiff',
        'gitApplyPatch',
        'gitCommit',
        'gitCreateBranch',
        'gitOpenPR',
      ]),
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('rejects invalid exclusive concurrency metadata when required', () => {
    const tools = [
      makeTool('memory_delete', {
        concurrency: {
          ...makeConcurrencyMeta('exclusive', {
            exclusivityKey: undefined,
            exclusivityKeyPolicy: 'none',
          }),
          // explicit any-casts verify validator fail-closed behavior for invalid metadata
          interruptibility: 'invalid' as any,
        },
      }),
      makeTool('repo', {
        concurrency: makeConcurrencyMeta('read_only', {
          maxParallel: 0,
          exclusivityKeyPolicy: 'static_key' as any,
          exclusivityKey: 'core:repo',
          eligibility: { foreground: false, background: false },
        }),
      }),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools,
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(2);
    expect(report.invalidTools[0].missingConcurrencyMetadata.join(' ')).toContain('exclusive tools require');
    expect(report.invalidTools[0].missingConcurrencyMetadata.join(' ')).toContain('interruptibility');
    expect(report.invalidTools[1].missingConcurrencyMetadata.join(' ')).toContain('maxParallel');
    expect(report.invalidTools[1].missingConcurrencyMetadata.join(' ')).toContain('eligibility');
  });
});

describe('validateAndLogToolWiring', () => {
  it('returns empty array when all tools are valid', () => {
    const tools = [
      makeTool('ok_tool'),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'direct',
      tools,
    });
    expect(disabled).toEqual([]);
  });

  it('returns names of disabled tools', () => {
    const tools = [
      makeTool('good_tool'),
      makeTool('bad_tool', {
        requiredGatewayMethods: ['nonexistent.method'],
      }),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(),
    });
    expect(disabled).toEqual(['bad_tool']);
  });

  it('disables tools with missing gateway metadata coverage', () => {
    const tools = [
      makeTool('repo'),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(disabled).toEqual(['repo']);
  });
});

describe('production tools validation', () => {
  it('the unified repo tool passes validation in direct runtime mode', () => {
    const gitTools = [
      makeTool('repo'),
    ];
    const report = validateToolWiring({
      mode: 'direct',
      tools: gitTools,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('the unified repo tool passes validation in gateway mode with full client', () => {
    const gitTools = [
      makeTool('repo', {
        requiredGatewayMethods: [
          'git.status',
          'git.diff',
          'git.apply_patch',
          'git.commit',
          'git.create_branch',
          'git.open_pr',
        ],
      }),
    ];

    const fullClientMethods = new Set([
      'gitStatus',
      'gitDiff',
      'gitCreateBranch',
      'gitApplyPatch',
      'gitCommit',
      'gitOpenPR',
      'stream',
      'complete',
      'embed',
      'embedBatch',
      'discordSend',
      'discordTyping',
      'webFetch',
      'shellExec',
      'fsRead',
      'fsWrite',
      'fsList',
    ]);

    const report = validateToolWiring({
      mode: 'gateway',
      tools: gitTools,
      gatewayClientMethods: fullClientMethods,
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('detects git tools that would fail against incomplete client', () => {
    const gitTools = [
      makeTool('repo', {
        requiredGatewayMethods: ['git.status', 'git.diff', 'git.commit'],
      }),
    ];

    const incompleteClient = new Set([
      'gitStatus',
      'gitDiff',
    ]);

    const report = validateToolWiring({
      mode: 'gateway',
      tools: gitTools,
      gatewayClientMethods: incompleteClient,
    });
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo');
  });
});

describe('extractGatewayMethods with GatewayClient shape', () => {
  it('extracts all expected methods from a GatewayClient-like object', () => {
    // This mirrors the real GatewayClient's public method surface
    class FakeGatewayClient {
      stream(): void { /* noop */ }
      complete(): void { /* noop */ }
      embed(): void { /* noop */ }
      embedBatch(): void { /* noop */ }
      discordSend(): void { /* noop */ }
      discordTyping(): void { /* noop */ }
      webFetch(): void { /* noop */ }
      shellExec(): void { /* noop */ }
      fsRead(): void { /* noop */ }
      fsWrite(): void { /* noop */ }
      fsList(): void { /* noop */ }
      gitStatus(): void { /* noop */ }
      gitDiff(): void { /* noop */ }
      gitCreateBranch(): void { /* noop */ }
      gitApplyPatch(): void { /* noop */ }
      gitCommit(): void { /* noop */ }
      gitOpenPR(): void { /* noop */ }
      notifyNtfy(): void { /* noop */ }
      beadsReady(): void { /* noop */ }
      beadsShow(): void { /* noop */ }
      beadsCreate(): void { /* noop */ }
      beadsUpdate(): void { /* noop */ }
      beadsClose(): void { /* noop */ }
      beadsSync(): void { /* noop */ }
      imageCreate(): void { /* noop */ }
      imageEdit(): void { /* noop */ }
    }

    const methods = extractGatewayMethods(new FakeGatewayClient());

    // Verify all git methods are found
    expect(methods.has('gitStatus')).toBe(true);
    expect(methods.has('gitDiff')).toBe(true);
    expect(methods.has('gitCreateBranch')).toBe(true);
    expect(methods.has('gitApplyPatch')).toBe(true);
    expect(methods.has('gitCommit')).toBe(true);
    expect(methods.has('gitOpenPR')).toBe(true);
    expect(methods.has('beadsReady')).toBe(true);
    expect(methods.has('beadsCreate')).toBe(true);
    expect(methods.has('imageCreate')).toBe(true);
    expect(methods.has('imageEdit')).toBe(true);

    // Verify LLM methods
    expect(methods.has('stream')).toBe(true);
    expect(methods.has('complete')).toBe(true);
    expect(methods.has('embed')).toBe(true);
  });
});
