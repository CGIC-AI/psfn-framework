// ── Tool Wiring Validator ──
// Startup-time contract check to prevent tools from being registered
// when their runtime dependencies are missing. Catches the class of bugs
// where a tool appears available but crashes at invocation because its
// backing service (e.g. gateway RPC method) is not wired.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ToolWiringValidator');

/**
 * Metadata that a tool can optionally declare to describe its runtime
 * dependencies. Tools that operate purely on injected closures (most tools)
 * don't need this — only tools whose execute() delegates to a service object
 * whose methods might not exist (e.g. GatewayClient).
 */
export interface ToolWiringMeta {
  /**
   * Gateway RPC method names this tool requires (e.g. 'git.status', 'git.diff').
   * Validated in gateway mode by checking that the gateway client exposes
   * corresponding methods.
   */
  requiredGatewayMethods?: string[];

  /**
   * Arbitrary named service dependencies this tool requires.
   * Validated against a provided set of available service names.
   */
  requiredServices?: string[];

  /**
   * Optional turn-context restrictions that make the tool not applicable in
   * specific runtime contexts even when it is otherwise registered.
   */
  contextRestrictions?: ToolContextRestrictions;

  /**
   * Required tool-concurrency metadata for bounded scheduler execution.
   * When concurrency metadata enforcement is enabled, tools missing this
   * metadata are disabled (fail-closed).
   */
  concurrency?: ToolConcurrencyMeta;
}

export type ToolConcurrencyClass =
  | 'exclusive'
  | 'read_only'
  | 'spawn_shard';

export type ToolExclusivityKeyPolicy =
  | 'none'
  | 'category_tool_name'
  | 'static_key';

export type ToolInterruptibility =
  | 'cooperative'
  | 'non_interruptible';

export interface ToolExecutionEligibility {
  foreground: boolean;
  background: boolean;
}

export interface ToolContextRestrictions {
  disallowInternal?: boolean;
  disallowScheduled?: boolean;
}

export interface ToolConcurrencyMeta {
  /**
   * Concurrency execution class used by scheduler logic.
   */
  class: ToolConcurrencyClass;

  /**
   * Explicit policy that explains how exclusivityKey was derived.
   * - none: tool is not serialized via exclusivity key
   * - category_tool_name: key is generated from <category>:<toolName>
   * - static_key: key is explicitly authored in metadata
   */
  exclusivityKeyPolicy: ToolExclusivityKeyPolicy;

  /**
   * Required for exclusive class to serialize conflicting operations.
   */
  exclusivityKey?: string;

  /**
   * Optional upper bound for parallel classes.
   */
  maxParallel?: number;

  /**
   * Whether the tool is safe to interrupt when turn control changes.
   */
  interruptibility: ToolInterruptibility;

  /**
   * Whether the tool can be scheduled in foreground and/or background turns.
   * At least one lane must be enabled.
   */
  eligibility: ToolExecutionEligibility;
}

/** An AgentTool that optionally carries wiring metadata */
export type WirableTool = AgentTool<any> & {
  wiringMeta?: ToolWiringMeta;
};

export function cloneToolWiringMeta(meta: ToolWiringMeta | undefined): ToolWiringMeta | undefined {
  if (!meta) return undefined;

  return {
    ...(meta.requiredGatewayMethods ? { requiredGatewayMethods: [...meta.requiredGatewayMethods] } : {}),
    ...(meta.requiredServices ? { requiredServices: [...meta.requiredServices] } : {}),
    ...(meta.contextRestrictions
      ? {
        contextRestrictions: {
          ...(meta.contextRestrictions.disallowInternal !== undefined
            ? { disallowInternal: meta.contextRestrictions.disallowInternal }
            : {}),
          ...(meta.contextRestrictions.disallowScheduled !== undefined
            ? { disallowScheduled: meta.contextRestrictions.disallowScheduled }
            : {}),
        },
      }
      : {}),
    ...(meta.concurrency
      ? {
        concurrency: {
          ...meta.concurrency,
          eligibility: {
            foreground: meta.concurrency.eligibility.foreground,
            background: meta.concurrency.eligibility.background,
          },
        },
      }
      : {}),
  };
}

/**
 * Expected requiredGatewayMethods coverage for known gateway-dependent tools.
 * If a tool appears in this map in gateway mode, it must declare matching
 * requiredGatewayMethods metadata or it is disabled.
 */
export type GatewayToolMetadataCoverage = Readonly<Record<string, readonly string[]>>;

export const DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE: GatewayToolMetadataCoverage = Object.freeze({
  fs: Object.freeze(['fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.edit']),
  notify: Object.freeze(['discord.send', 'notify.ntfy']),
  repo: Object.freeze([
    'git.status',
    'git.diff',
    'git.apply_patch',
    'git.commit',
    'git.create_branch',
    'git.open_pr',
  ]),
  vault: Object.freeze(['vault.write', 'vault.read', 'vault.search', 'vault.daily']),
  issue_ready: Object.freeze(['beads.ready']),
  issue_show: Object.freeze(['beads.show']),
  issue_create: Object.freeze(['beads.create']),
  issue_update: Object.freeze(['beads.update']),
  issue_close: Object.freeze(['beads.close']),
  issue_sync: Object.freeze(['beads.sync']),
  media: Object.freeze(['image.create', 'image.edit', 'web.fetch_binary']),
  shell: Object.freeze(['shell.exec']),
  web: Object.freeze(['web.fetch']),
});

// ── Validation Types ──

export type RuntimeMode = 'single' | 'gateway';

export interface ToolValidationResult {
  toolName: string;
  valid: boolean;
  missingGatewayMethods: string[];
  missingServices: string[];
  missingGatewayMetadataCoverage: string[];
  missingConcurrencyMetadata: string[];
}

export interface ValidationReport {
  mode: RuntimeMode;
  totalTools: number;
  validTools: number;
  invalidTools: ToolValidationResult[];
}

// ── Gateway Method Probing ──

/**
 * Extracts the set of method names that a gateway client exposes.
 * Works by inspecting own property names that are functions, filtering
 * out private/lifecycle methods.
 */
export function extractGatewayMethods(client: object): Set<string> {
  const methods = new Set<string>();
  const proto = Object.getPrototypeOf(client) as Record<string, unknown> | null;
  if (!proto) return methods;

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    if (typeof (proto as Record<string, unknown>)[key] === 'function') {
      methods.add(key);
    }
  }
  return methods;
}

/**
 * Maps well-known gateway RPC method names to their corresponding
 * GatewayClient method names. The RPC protocol uses dot-notation
 * (e.g. 'git.status') while the client uses camelCase (e.g. 'gitStatus').
 */
const RPC_TO_CLIENT_METHOD: Record<string, string> = {
  'git.status': 'gitStatus',
  'git.diff': 'gitDiff',
  'git.create_branch': 'gitCreateBranch',
  'git.apply_patch': 'gitApplyPatch',
  'git.commit': 'gitCommit',
  'git.open_pr': 'gitOpenPR',
  'beads.ready': 'beadsReady',
  'beads.show': 'beadsShow',
  'beads.create': 'beadsCreate',
  'beads.update': 'beadsUpdate',
  'beads.close': 'beadsClose',
  'beads.sync': 'beadsSync',
  'image.create': 'imageCreate',
  'image.edit': 'imageEdit',
  'llm.chat': 'stream',
  'llm.complete': 'complete',
  'llm.embed': 'embed',
  'discord.send': 'discordSend',
  'discord.typing': 'discordTyping',
  'web.fetch': 'webFetch',
  'web.fetch_binary': 'webFetchBinary',
  'shell.exec': 'shellExec',
  'shard.backend.request': 'shardBackendRequest',
  'fs.read': 'fsRead',
  'fs.write': 'fsWrite',
  'fs.list': 'fsList',
  'fs.search': 'fsSearch',
  'fs.edit': 'fsEdit',
  'notify.ntfy': 'notifyNtfy',
  'session.hmac.sign': 'sessionHmacSign',
  'session.hmac.verify': 'sessionHmacVerify',
  'confirmation.list': 'listConfirmationQueue',
  'confirmation.resolve': 'resolveConfirmationQueue',
};

/**
 * Resolves an RPC method name to the corresponding GatewayClient method name.
 * Falls back to the RPC name itself if no mapping is found.
 */
export function resolveClientMethod(rpcMethod: string): string {
  return RPC_TO_CLIENT_METHOD[rpcMethod] ?? rpcMethod;
}

// ── Validation Logic ──

export interface ValidateToolsOptions {
  mode: RuntimeMode;
  tools: readonly AgentTool<any>[];
  /** Available gateway client methods (gateway mode only) */
  gatewayClientMethods?: Set<string>;
  /** Expected metadata coverage for known gateway-dependent tools */
  requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage;
  /** Available service names */
  availableServices?: Set<string>;
  /** Require per-tool concurrency metadata (fail-closed when missing/invalid) */
  requireConcurrencyMetadata?: boolean;
}

/**
 * Validates that all registered tools have their runtime dependencies satisfied.
 * Returns a report describing which tools are valid and which have missing deps.
 */
export function validateToolWiring(options: ValidateToolsOptions): ValidationReport {
  const {
    mode,
    tools,
    gatewayClientMethods,
    requiredGatewayMetadataCoverage,
    availableServices,
    requireConcurrencyMetadata = false,
  } = options;
  const results: ToolValidationResult[] = [];

  for (const tool of tools) {
    const wirable = tool as WirableTool;
    const meta = wirable.wiringMeta;
    const missingGatewayMethods: string[] = [];
    const missingServices: string[] = [];
    const missingGatewayMetadataCoverage: string[] = [];
    const missingConcurrencyMetadata: string[] = [];

    // Check gateway method dependencies
    if (mode === 'gateway' && meta?.requiredGatewayMethods && gatewayClientMethods) {
      for (const rpcMethod of meta.requiredGatewayMethods) {
        const clientMethod = resolveClientMethod(rpcMethod);
        if (!gatewayClientMethods.has(clientMethod)) {
          missingGatewayMethods.push(`${rpcMethod} (client: ${clientMethod})`);
        }
      }
    }

    // Enforce metadata coverage for known gateway-dependent tools.
    if (mode === 'gateway') {
      const expectedCoverage = requiredGatewayMetadataCoverage?.[tool.name];
      if (expectedCoverage && expectedCoverage.length > 0) {
        if (!meta?.requiredGatewayMethods || meta.requiredGatewayMethods.length === 0) {
          missingGatewayMetadataCoverage.push(
            `requiredGatewayMethods metadata missing (expected: ${expectedCoverage.join(', ')})`,
          );
        } else {
          const declared = new Set(meta.requiredGatewayMethods);
          for (const expectedRpcMethod of expectedCoverage) {
            if (!declared.has(expectedRpcMethod)) {
              missingGatewayMetadataCoverage.push(
                `requiredGatewayMethods missing "${expectedRpcMethod}"`,
              );
            }
          }
        }
      }
    }

    // Check service dependencies
    if (meta?.requiredServices && availableServices) {
      for (const service of meta.requiredServices) {
        if (!availableServices.has(service)) {
          missingServices.push(service);
        }
      }
    }

    if (requireConcurrencyMetadata) {
      const concurrency = meta?.concurrency;
      if (!concurrency) {
        missingConcurrencyMetadata.push('concurrency metadata missing');
      } else {
        const concurrencyClass = (concurrency as { class?: unknown }).class;
        if (
          concurrencyClass !== 'exclusive'
          && concurrencyClass !== 'read_only'
          && concurrencyClass !== 'spawn_shard'
        ) {
          missingConcurrencyMetadata.push(
            `invalid concurrency.class "${String(concurrencyClass)}"`,
          );
        }

        const exclusivityKeyPolicy = (
          concurrency as { exclusivityKeyPolicy?: unknown }
        ).exclusivityKeyPolicy;
        if (
          exclusivityKeyPolicy !== 'none'
          && exclusivityKeyPolicy !== 'category_tool_name'
          && exclusivityKeyPolicy !== 'static_key'
        ) {
          missingConcurrencyMetadata.push(
            `invalid concurrency.exclusivityKeyPolicy "${String(exclusivityKeyPolicy)}"`,
          );
        }

        if (
          concurrency.class === 'exclusive'
          && (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0)
        ) {
          missingConcurrencyMetadata.push('exclusive tools require non-empty concurrency.exclusivityKey');
        }

        if (
          concurrency.class === 'exclusive'
          && concurrency.exclusivityKeyPolicy === 'none'
        ) {
          missingConcurrencyMetadata.push('exclusive tools require non-none concurrency.exclusivityKeyPolicy');
        }

        if (
          concurrency.class !== 'exclusive'
          && concurrency.exclusivityKeyPolicy !== 'none'
        ) {
          missingConcurrencyMetadata.push('non-exclusive tools must use concurrency.exclusivityKeyPolicy "none"');
        }

        if (
          concurrency.class !== 'exclusive'
          && concurrency.exclusivityKey !== undefined
        ) {
          missingConcurrencyMetadata.push('non-exclusive tools must not set concurrency.exclusivityKey');
        }

        if (
          concurrency.maxParallel !== undefined
          && (!Number.isInteger(concurrency.maxParallel) || concurrency.maxParallel <= 0)
        ) {
          missingConcurrencyMetadata.push('concurrency.maxParallel must be a positive integer when provided');
        }

        const interruptibility = (concurrency as { interruptibility?: unknown }).interruptibility;
        if (
          interruptibility !== 'cooperative'
          && interruptibility !== 'non_interruptible'
        ) {
          missingConcurrencyMetadata.push(
            `invalid concurrency.interruptibility "${String(interruptibility)}"`,
          );
        }

        const eligibility = (concurrency as { eligibility?: unknown }).eligibility;
        if (!eligibility || typeof eligibility !== 'object') {
          missingConcurrencyMetadata.push('concurrency.eligibility metadata missing');
        } else {
          const { foreground, background } = eligibility as {
            foreground?: unknown;
            background?: unknown;
          };
          if (typeof foreground !== 'boolean' || typeof background !== 'boolean') {
            missingConcurrencyMetadata.push('concurrency.eligibility must include boolean foreground/background flags');
          } else if (!foreground && !background) {
            missingConcurrencyMetadata.push('concurrency.eligibility must enable at least one lane');
          }
        }
      }
    }

    if (
      missingGatewayMethods.length > 0
      || missingServices.length > 0
      || missingGatewayMetadataCoverage.length > 0
      || missingConcurrencyMetadata.length > 0
    ) {
      results.push({
        toolName: tool.name,
        valid: false,
        missingGatewayMethods,
        missingServices,
        missingGatewayMetadataCoverage,
        missingConcurrencyMetadata,
      });
    }
  }

  return {
    mode,
    totalTools: tools.length,
    validTools: tools.length - results.length,
    invalidTools: results,
  };
}

/**
 * Runs validation and logs results. Returns tool names that should be disabled.
 * Does NOT mutate the tool list — caller is responsible for removing invalid tools.
 */
export function validateAndLogToolWiring(options: ValidateToolsOptions): string[] {
  const report = validateToolWiring(options);

  if (report.invalidTools.length === 0) {
    log.info('Tool wiring validation passed', {
      mode: report.mode,
      toolCount: report.totalTools,
    });
    return [];
  }

  const disabledNames: string[] = [];
  for (const invalid of report.invalidTools) {
    const reasons: string[] = [];
    if (invalid.missingGatewayMethods.length > 0) {
      reasons.push(`missing gateway methods: ${invalid.missingGatewayMethods.join(', ')}`);
    }
    if (invalid.missingServices.length > 0) {
      reasons.push(`missing services: ${invalid.missingServices.join(', ')}`);
    }
    if (invalid.missingGatewayMetadataCoverage.length > 0) {
      reasons.push(
        `missing gateway metadata coverage: ${invalid.missingGatewayMetadataCoverage.join(', ')}`,
      );
    }
    if (invalid.missingConcurrencyMetadata.length > 0) {
      reasons.push(`missing concurrency metadata: ${invalid.missingConcurrencyMetadata.join(', ')}`);
    }
    log.warn(`Tool "${invalid.toolName}" disabled — ${reasons.join('; ')}`, {
      tool: invalid.toolName,
      missingGatewayMethods: invalid.missingGatewayMethods,
      missingServices: invalid.missingServices,
      missingGatewayMetadataCoverage: invalid.missingGatewayMetadataCoverage,
      missingConcurrencyMetadata: invalid.missingConcurrencyMetadata,
    });
    disabledNames.push(invalid.toolName);
  }

  log.warn('Tool wiring validation completed with disabled tools', {
    mode: report.mode,
    totalTools: report.totalTools,
    validTools: report.validTools,
    disabledCount: disabledNames.length,
    disabledTools: disabledNames,
  });

  return disabledNames;
}
