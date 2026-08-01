import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { McpExecuteParams } from '../protocol.js';

const PERMIT_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_PERMITS = 128;

type AuthorizedMcpParams = Omit<McpExecuteParams, 'permit' | 'cancellationId'>;

interface PermitRecord {
  companionId: string;
  expected: AuthorizedMcpParams;
  outboundSensitivity: SensitivityLevel;
  expiresAt: number;
}

export interface McpInvocationAuthorityResult {
  outboundSensitivity: SensitivityLevel;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeModelMcpInput(raw: unknown): AuthorizedMcpParams | undefined {
  if (!isRecord(raw)) return undefined;
  try {
    switch (raw.action) {
      case 'catalog':
        assertNoUnknownKeys(raw, ['action'], 'model MCP catalog input');
        return { action: 'catalog' };
      case 'search': {
        assertNoUnknownKeys(raw, ['action', 'query', 'limit'], 'model MCP search input');
        const query = requiredString(raw.query);
        if (!query || (raw.limit !== undefined && (
          !Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 20
        ))) return undefined;
        return {
          action: 'search',
          query,
          limit: raw.limit === undefined ? 8 : raw.limit as number,
        };
      }
      case 'inspect': {
        assertNoUnknownKeys(raw, ['action', 'server_id', 'tool_name'], 'model MCP inspect input');
        const serverId = requiredString(raw.server_id);
        const toolName = requiredString(raw.tool_name);
        return serverId && toolName
          ? { action: 'inspect', serverId, toolName }
          : undefined;
      }
      case 'call': {
        assertNoUnknownKeys(raw, ['action', 'server_id', 'tool_name', 'arguments'], 'model MCP call input');
        const serverId = requiredString(raw.server_id);
        const toolName = requiredString(raw.tool_name);
        return serverId && toolName && isRecord(raw.arguments)
          ? { action: 'call', serverId, toolName, arguments: raw.arguments }
          : undefined;
      }
      case 'release': {
        assertNoUnknownKeys(raw, ['action', 'server_id'], 'model MCP release input');
        const serverId = raw.server_id === undefined ? undefined : requiredString(raw.server_id);
        if (raw.server_id !== undefined && !serverId) return undefined;
        return { action: 'release', ...(serverId ? { serverId } : {}) };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Connection-scoped, gateway-minted authority for one exact model-emitted MCP
 * action. The agent receives only an opaque, single-use permit; it cannot pick
 * sensitivity, channel lineage, destination, or different MCP arguments later.
 */
export class GatewayMcpInvocationAuthority {
  private readonly records = new Map<string, PermitRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(input: {
    companionId: string;
    modelInput: unknown;
  }): string | undefined {
    const expected = normalizeModelMcpInput(input.modelInput);
    if (!expected) return undefined;
    this.prune();
    while (this.records.size >= MAX_PENDING_PERMITS) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    const permit = randomUUID();
    this.records.set(permit, {
      companionId: input.companionId,
      expected,
      // The gateway cannot reclassify the agent's complete generation lineage.
      // Confidential is therefore the only safe server-owned default.
      outboundSensitivity: 'confidential',
      expiresAt: this.now() + PERMIT_TTL_MS,
    });
    return permit;
  }

  consume(input: {
    permit: string;
    companionId: string;
    params: AuthorizedMcpParams;
  }): McpInvocationAuthorityResult | undefined {
    this.prune();
    const record = this.records.get(input.permit);
    this.records.delete(input.permit);
    if (!record
      || record.companionId !== input.companionId
      || !isDeepStrictEqual(record.expected, input.params)) return undefined;
    return { outboundSensitivity: record.outboundSensitivity };
  }

  clear(): void {
    this.records.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [permit, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(permit);
    }
  }
}
