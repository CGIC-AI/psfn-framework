import { isDeepStrictEqual } from 'node:util';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { readConfirmedApprovalExecution } from '../../../system/capabilities/confirmation-queue.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import {
  McpBrokerError,
  type McpGatewayBroker,
  type McpScreenedToolResult,
} from '../mcp/broker.js';
import {
  GatewayErrors,
  type McpCancelParams,
  type McpCancelResult,
  type McpExecuteParams,
  type McpExecuteResult,
  type McpReleaseResult,
} from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';

const CANCELLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ActiveMcpRequest {
  readonly cancellationId: string;
  readonly controller: AbortController;
}

/** Connection-scoped cancellation registry for lazy MCP discovery and calls. */
export class GatewayMcpRequestCancellation {
  private readonly activeById = new Map<string, ActiveMcpRequest>();

  run<T>(
    rawCancellationId: unknown,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const cancellationId = normalizeCancellationId(rawCancellationId, false);
    if (!cancellationId) return Promise.resolve().then(() => operation(undefined));
    if (this.activeById.has(cancellationId)) {
      return Promise.reject(new Error(`MCP cancellationId "${cancellationId}" is already active`));
    }
    const active: ActiveMcpRequest = { cancellationId, controller: new AbortController() };
    this.activeById.set(cancellationId, active);
    let pending: Promise<T>;
    try {
      pending = operation(active.controller.signal);
    } catch (error) {
      this.release(active);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (kind: 'resolve' | 'reject', value: unknown): void => {
        if (settled) return;
        settled = true;
        active.controller.signal.removeEventListener('abort', onAbort);
        kind === 'resolve' ? resolve(value as T) : reject(value);
      };
      const onAbort = (): void => finish(
        'reject',
        active.controller.signal.reason ?? new Error('Gateway MCP request cancelled'),
      );
      active.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (active.controller.signal.aborted) onAbort();
      pending.then(
        result => finish('resolve', result),
        error => finish('reject', error),
      );
    }).finally(() => this.release(active));
  }

  cancel(rawCancellationId: unknown): boolean {
    const cancellationId = normalizeCancellationId(rawCancellationId, true)!;
    const active = this.activeById.get(cancellationId);
    if (!active) return false;
    this.release(active);
    active.controller.abort(new Error('Gateway MCP request cancelled by its owning connection'));
    return true;
  }

  abortAll(): number {
    const active = [...this.activeById.values()];
    this.activeById.clear();
    for (const request of active) {
      request.controller.abort(new Error('Gateway MCP request cancelled because its connection closed'));
    }
    return active.length;
  }

  private release(active: ActiveMcpRequest): void {
    if (this.activeById.get(active.cancellationId) === active) {
      this.activeById.delete(active.cancellationId);
    }
  }
}

function normalizeCancellationId(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined && !required) return undefined;
  if (typeof raw !== 'string' || !CANCELLATION_ID_PATTERN.test(raw)) {
    throw new Error('MCP cancellationId must be a canonical UUID');
  }
  return raw.toLowerCase();
}

function normalizePermit(raw: unknown): string {
  if (typeof raw !== 'string' || !CANCELLATION_ID_PATTERN.test(raw)) {
    throw new Error('mcp.execute permit must be a canonical UUID');
  }
  return raw.toLowerCase();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`mcp.execute ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseParams(raw: unknown): McpExecuteParams {
  if (!isRecord(raw)) throw new Error('mcp.execute params must be an object');
  const action = raw.action;
  if (!['catalog', 'search', 'inspect', 'call', 'release'].includes(String(action))) {
    throw new Error('mcp.execute action must be catalog, search, inspect, call, or release');
  }
  const common = ['action', 'cancellationId', 'permit'] as const;
  normalizeCancellationId(raw.cancellationId, false);
  const permit = normalizePermit(raw.permit);
  if (action === 'catalog') {
    assertNoUnknownKeys(raw, common, 'mcp.execute catalog params');
    return { action, permit, ...(raw.cancellationId ? { cancellationId: String(raw.cancellationId) } : {}) };
  }
  if (action === 'search') {
    assertNoUnknownKeys(raw, [...common, 'query', 'limit'], 'mcp.execute search params');
    if (typeof raw.query !== 'string') throw new Error('mcp.execute search query must be a string');
    if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1)) {
      throw new Error('mcp.execute search limit must be a positive integer');
    }
    return {
      action,
      query: raw.query.trim(),
      ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
      ...(raw.cancellationId ? { cancellationId: String(raw.cancellationId) } : {}),
      permit,
    };
  }
  if (action === 'inspect') {
    assertNoUnknownKeys(raw, [...common, 'serverId', 'toolName'], 'mcp.execute inspect params');
    return {
      action,
      serverId: requiredString(raw.serverId, 'serverId'),
      toolName: requiredString(raw.toolName, 'toolName'),
      ...(raw.cancellationId ? { cancellationId: String(raw.cancellationId) } : {}),
      permit,
    };
  }
  if (action === 'call') {
    assertNoUnknownKeys(
      raw,
      [...common, 'serverId', 'toolName', 'arguments'],
      'mcp.execute call params',
    );
    if (!isRecord(raw.arguments)) throw new Error('mcp.execute call arguments must be an object');
    return {
      action,
      serverId: requiredString(raw.serverId, 'serverId'),
      toolName: requiredString(raw.toolName, 'toolName'),
      arguments: raw.arguments,
      ...(raw.cancellationId ? { cancellationId: String(raw.cancellationId) } : {}),
      permit,
    };
  }
  assertNoUnknownKeys(raw, [...common, 'serverId'], 'mcp.execute release params');
  return {
    action: 'release',
    ...(raw.serverId === undefined ? {} : { serverId: requiredString(raw.serverId, 'serverId') }),
    ...(raw.cancellationId ? { cancellationId: String(raw.cancellationId) } : {}),
    permit,
  };
}

function requireCompanion(runtime: GatewayMethodRuntime): string {
  const companionId = runtime.authenticatedCompanionId()?.trim();
  if (!companionId) {
    throw new JSONRPCErrorException(
      'MCP requires an authenticated companion connection',
      GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
    );
  }
  return companionId;
}

function requireCapability(runtime: GatewayMethodRuntime, token: 'identity.read' | 'external.mcp'): void {
  let snapshot;
  try {
    snapshot = runtime.capabilityGrantSnapshotProvider?.();
  } catch {
    snapshot = undefined;
  }
  if (!snapshot?.grantedTokens.includes(token)) {
    throw new JSONRPCErrorException(
      `MCP action denied: authenticated companion lacks ${token}`,
      GatewayErrors.POLICY_DENIED,
      { missingCapability: token },
    );
  }
}

function requireBroker(runtime: GatewayMethodRuntime): McpGatewayBroker {
  if (!runtime.mcpBroker) {
    throw new JSONRPCErrorException('MCP is not enabled', GatewayErrors.POLICY_DENIED);
  }
  return runtime.mcpBroker;
}

function mapCallResult(result: McpScreenedToolResult): McpExecuteResult {
  return { action: 'call', ...result };
}

function isConfirmationRequired(error: unknown): boolean {
  return (error instanceof McpBrokerError && error.code === 'CONFIRMATION_REQUIRED')
    || (isRecord(error) && error.name === 'McpBrokerError' && error.code === 'CONFIRMATION_REQUIRED');
}

function mapMcpError(error: unknown): never {
  if (error instanceof JSONRPCErrorException) throw error;
  if (error instanceof McpBrokerError) {
    const policyCodes = new Set([
      'SERVER_NOT_FOUND',
      'SERVER_DISABLED',
      'COMPANION_NOT_ALLOWED',
      'TOOL_DENIED',
      'SENSITIVITY_DENIED',
      'INVOCATION_ARGUMENTS_INVALID',
      'STATIC_METADATA_WITHHELD',
      'DYNAMIC_OUTPUT_WITHHELD',
    ]);
    throw new JSONRPCErrorException(
      error.message,
      policyCodes.has(error.code) ? GatewayErrors.POLICY_DENIED : GatewayErrors.PROVIDER_ERROR,
      { mcpCode: error.code, retryable: error.retryable },
    );
  }
  throw new JSONRPCErrorException(
    'MCP operation failed at the external tooling boundary',
    GatewayErrors.PROVIDER_ERROR,
    { mcpCode: 'EXTERNAL_TOOL_FAILURE' },
  );
}

async function queueExactApproval(input: {
  params: McpExecuteParams;
  outboundSensitivity: 'public' | 'personal' | 'intimate' | 'confidential';
  companionId: string;
  broker: McpGatewayBroker;
  runtime: GatewayMethodRuntime;
}): Promise<never> {
  const exactParams = { ...input.params } as Record<string, unknown>;
  delete exactParams.cancellationId;
  delete exactParams.permit;
  const serverId = input.params.serverId!;
  const toolName = input.params.toolName!;
  const entry = await input.runtime.approvalBoundary.requestExplicitApproval({
    authenticatedCompanionId: input.companionId,
    request: {
      method: 'mcp.execute',
      action: 'call',
      scope: `${serverId}/${toolName}`,
      params: exactParams,
      companionReason: `MCP policy requires confirmation for ${serverId}/${toolName}`,
      sourceSystem: 'tool-access',
    },
    execute: async (approvedParams, approvalEntry, context) => {
      readConfirmedApprovalExecution(context, approvalEntry.id);
      if (!isDeepStrictEqual(approvedParams, exactParams)) {
        throw new Error('MCP approval is bound to the exact request; edited parameters require a new approval');
      }
      requireCapability(input.runtime, 'external.mcp');
      const result = await input.broker.invokeTool({
        companionId: input.companionId,
        serverId,
        toolName,
        arguments: input.params.arguments!,
        outboundSensitivity: input.outboundSensitivity,
        confirmed: true,
      });
      return mapCallResult(result);
    },
  });
  throw new JSONRPCErrorException(
    `MCP call is pending operator approval (id: ${entry.id})`,
    GatewayErrors.NEEDS_APPROVAL,
    { approvalId: entry.id, expiresAt: entry.expiresAt },
  );
}

async function executeMcp(
  raw: unknown,
  runtime: GatewayMethodRuntime,
  signal: AbortSignal | undefined,
): Promise<McpExecuteResult> {
  const params = parseParams(raw);
  const companionId = requireCompanion(runtime);
  const { cancellationId: _cancellationId, permit: _permit, ...authorizedParams } = params;
  const authority = runtime.mcpInvocationAuthority.consume({
    permit: params.permit!,
    companionId,
    params: authorizedParams,
  });
  if (!authority) {
    throw new JSONRPCErrorException(
      'MCP action denied: missing, expired, reused, or mismatched gateway authority',
      GatewayErrors.POLICY_DENIED,
    );
  }
  requireCapability(runtime, params.action === 'call' ? 'external.mcp' : 'identity.read');
  const broker = requireBroker(runtime);
  try {
    switch (params.action) {
      case 'catalog':
        return { action: 'catalog', servers: broker.getCatalog({ companionId }) };
      case 'search':
        return {
          action: 'search',
          query: params.query!,
          tools: await broker.searchTools({
            companionId,
            query: params.query!,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(signal ? { signal } : {}),
          }),
        };
      case 'inspect': {
        const inspected = await broker.inspectTool({
          companionId,
          serverId: params.serverId!,
          toolName: params.toolName!,
          ...(signal ? { signal } : {}),
        });
        return {
          action: 'inspect',
          serverId: inspected.serverId,
          serverDisplayName: inspected.serverDisplayName,
          tool: {
            name: inspected.tool.name,
            description: inspected.tool.description ?? '',
            inputSchema: inspected.tool.inputSchema,
          },
          policy: inspected.policy,
        };
      }
      case 'call':
        try {
          return mapCallResult(await broker.invokeTool({
            companionId,
            serverId: params.serverId!,
            toolName: params.toolName!,
            arguments: params.arguments!,
            outboundSensitivity: authority.outboundSensitivity,
            confirmed: false,
            ...(signal ? { signal } : {}),
          }));
        } catch (error) {
          if (isConfirmationRequired(error)) {
            return await queueExactApproval({
              params,
              companionId,
              broker,
              runtime,
              outboundSensitivity: authority.outboundSensitivity,
            });
          }
          throw error;
        }
      case 'release':
        if (params.serverId) {
          await broker.releaseServer({ companionId, serverId: params.serverId });
          return { action: 'release', serverId: params.serverId, released: true };
        }
        await broker.releaseCompanion(companionId);
        return { action: 'release', released: true };
    }
  } catch (error) {
    return mapMcpError(error);
  }
}

function summary(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const args = isRecord(raw.arguments) ? raw.arguments : undefined;
  return {
    action: typeof raw.action === 'string' ? raw.action : undefined,
    serverId: typeof raw.serverId === 'string' ? raw.serverId : undefined,
    toolName: typeof raw.toolName === 'string' ? raw.toolName : undefined,
    ...(args ? { argumentKeys: Object.keys(args).sort(), argumentCount: Object.keys(args).length } : {}),
  };
}

export function registerMcpMethods(runtime: GatewayMethodRuntime): void {
  runtime.target.addMethod('mcp.execute', (params: unknown) => {
    const cancellationId = isRecord(params) ? params.cancellationId : undefined;
    return runtime.mcpRequestCancellation.run(cancellationId, signal => {
      const audited = runtime.audited(
        'mcp.execute',
        (cleaned: unknown) => executeMcp(cleaned, runtime, signal),
        summary,
      );
      return audited(params);
    });
  });
  runtime.target.addMethod('mcp.cancel', runtime.audited(
    'mcp.cancel',
    async (raw: unknown): Promise<McpCancelResult> => {
      if (!isRecord(raw)) throw new Error('mcp.cancel params must be an object');
      assertNoUnknownKeys(raw, ['cancellationId'], 'mcp.cancel params');
      const params = raw as unknown as McpCancelParams;
      return { cancelled: runtime.mcpRequestCancellation.cancel(params.cancellationId) };
    },
    raw => isRecord(raw) && typeof raw.cancellationId === 'string'
      ? { cancellationId: raw.cancellationId }
      : {},
  ));
  runtime.target.addMethod('mcp.release', runtime.audited(
    'mcp.release',
    async (raw: unknown): Promise<McpReleaseResult> => {
      if (!isRecord(raw)) throw new Error('mcp.release params must be an object');
      assertNoUnknownKeys(raw, ['serverId'], 'mcp.release params');
      const companionId = requireCompanion(runtime);
      requireCapability(runtime, 'identity.read');
      const broker = requireBroker(runtime);
      if (raw.serverId === undefined) {
        await broker.releaseCompanion(companionId);
        return { released: true };
      }
      const serverId = requiredString(raw.serverId, 'serverId');
      await broker.releaseServer({ companionId, serverId });
      return { released: true, serverId };
    },
    raw => isRecord(raw) && typeof raw.serverId === 'string'
      ? { serverId: raw.serverId }
      : {},
  ));
}
