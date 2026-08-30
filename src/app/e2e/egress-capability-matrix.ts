import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import {
  createMcpTool,
  type McpToolGatewayPort,
} from '../../boundary/integrations/mcp/tools.js';
import type { McpExecuteResult } from '../../boundary/gateway/protocol.js';
import {
  createNotifyTool,
  type NotifyDispatcher,
  type NotifyDispatchResult,
  type NotifyRequest,
} from '../../core/tools/ntfy.js';
import { gateToolWithCapabilities } from '../../system/capabilities/gate.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { isRecord } from '../../shared/utils/types.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

export const EGRESS_CAPABILITY_MATRIX_TIERS = [
  'nursery',
  'apprentice',
  'autonomous',
] as const satisfies readonly CapabilityTier[];

type EgressCapabilityMatrixTier = typeof EGRESS_CAPABILITY_MATRIX_TIERS[number];
type ExternalCapabilityToken = Extract<CapabilityToken, `external.${string}`>;

interface EgressCapabilityMatrixCase {
  readonly id: string;
  readonly capability: ExternalCapabilityToken;
  readonly toolName: 'notify' | 'mcp';
  readonly safeTarget: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly allowedTiers: readonly EgressCapabilityMatrixTier[];
}

/**
 * Topology-free counterpart of the retired private shakedown capability catalog.
 * Every row invokes a real model-facing tool, but its transport is an in-memory
 * recording adapter: this catalog can never send Discord, email, web, companion,
 * or MCP traffic.
 */
export const EGRESS_CAPABILITY_MATRIX_CASES = Object.freeze([
  {
    id: 'external_discord_notify_send',
    capability: 'external.discord',
    toolName: 'notify',
    safeTarget: 'matrix:discord:local-sink',
    params: {
      action: 'send',
      target_kind: 'external',
      delivery_channel: 'discord',
      delivery_target: 'matrix:discord:local-sink',
      message: 'Capability-matrix Discord probe; local recording adapter only.',
    },
    allowedTiers: ['apprentice', 'autonomous'],
  },
  {
    id: 'external_email_notify_send',
    capability: 'external.email',
    toolName: 'notify',
    safeTarget: 'matrix@example.invalid',
    params: {
      action: 'send',
      target_kind: 'external',
      delivery_channel: 'email',
      delivery_target: 'matrix@example.invalid',
      message: 'Capability-matrix email probe; local recording adapter only.',
    },
    allowedTiers: ['apprentice', 'autonomous'],
  },
  {
    id: 'external_web_notify_brief',
    capability: 'external.web',
    toolName: 'notify',
    safeTarget: 'matrix:operator-brief:local-sink',
    params: {
      action: 'brief',
      message: 'Capability-matrix operator brief; local recording adapter only.',
      title: 'Local capability matrix',
      topic: 'matrix-local-sink',
    },
    allowedTiers: ['apprentice', 'autonomous'],
  },
  {
    id: 'external_companion_notify_consider',
    capability: 'external.companion',
    toolName: 'notify',
    safeTarget: 'matrix-contact-local-only',
    params: {
      action: 'consider',
      target_kind: 'companion',
      contact_id: 'matrix-contact-local-only',
      reason_summary: 'Capability-matrix companion candidate; no permit or delivery.',
    },
    allowedTiers: ['autonomous'],
  },
  {
    id: 'external_mcp_local_call',
    capability: 'external.mcp',
    toolName: 'mcp',
    safeTarget: 'matrix-local-server/matrix_noop',
    params: {
      action: 'call',
      server_id: 'matrix-local-server',
      tool_name: 'matrix_noop',
      arguments: {},
    },
    allowedTiers: ['apprentice', 'autonomous'],
  },
] as const satisfies readonly EgressCapabilityMatrixCase[]);

interface EgressCapabilityMatrixDenial {
  readonly capabilityDenied: true;
  readonly tier: string;
  readonly missingTokens: readonly string[];
}

interface EgressCapabilityMatrixRow {
  readonly caseId: string;
  readonly tier: EgressCapabilityMatrixTier;
  readonly capability: ExternalCapabilityToken;
  readonly expected: 'allow' | 'deny';
  readonly handlerInvocationCount: number;
  readonly denial: EgressCapabilityMatrixDenial | null;
  readonly resultText: string;
}

interface EgressCapabilityMatrixReport {
  readonly status: 'passed';
  readonly rows: readonly EgressCapabilityMatrixRow[];
}

interface SafeProbe {
  invoke(): Promise<AgentToolResult<unknown>>;
  handlerInvocationCount(): number;
}

function buildSafeNotifyResult(request: NotifyRequest): NotifyDispatchResult {
  if (request.action === 'brief') {
    return {
      action: 'brief',
      status: 'sent',
      delivery: 'ntfy',
      target: 'matrix:operator-brief:local-sink',
    };
  }
  if (request.action === 'send') {
    if (request.deliveryChannel !== 'discord' && request.deliveryChannel !== 'email') {
      throw new Error('Capability matrix notify send requires a concrete local channel');
    }
    return {
      action: 'send',
      status: 'sent',
      delivery: request.deliveryChannel,
      target: request.deliveryTarget,
    };
  }
  throw new Error(`Capability matrix does not dispatch notify action "${request.action}"`);
}

function createSafeProbe(
  entry: EgressCapabilityMatrixCase,
  tier: EgressCapabilityMatrixTier,
): SafeProbe {
  const grantedTokens = new Set(resolveTierCapabilityTokens(tier));
  const access = () => ({
    getTier: () => tier,
    getGrantedTokens: () => grantedTokens,
    has: (token: CapabilityToken) => grantedTokens.has(token),
  });
  let handlerInvocationCount = 0;

  if (entry.capability === 'external.mcp') {
    const gateway: McpToolGatewayPort = {
      mcpExecute: async (params): Promise<McpExecuteResult> => {
        handlerInvocationCount += 1;
        if (params.action !== 'call') {
          throw new Error('Capability matrix MCP probe only permits the local call action');
        }
        if (!params.serverId || !params.toolName) {
          throw new Error('Capability matrix MCP probe requires its local server and tool target');
        }
        return {
          action: 'call',
          serverId: params.serverId,
          toolName: params.toolName,
          isError: false,
          effectiveText: '[local capability-matrix MCP response]',
          withheld: false,
        };
      },
    };
    const gated = gateToolWithCapabilities(createMcpTool({ gateway }), access);
    return {
      invoke: () => gated.execute(`matrix-${tier}-${entry.id}`, entry.params),
      handlerInvocationCount: () => handlerInvocationCount,
    };
  }

  const dispatcher: NotifyDispatcher = {
    dispatch: async (request) => {
      handlerInvocationCount += 1;
      return buildSafeNotifyResult(request);
    },
  };
  const notify = createNotifyTool(dispatcher, {
    companionCandidateEnabled: true,
    isCompanionCandidateAuthorized: () => {
      handlerInvocationCount += 1;
      return true;
    },
  });
  const gated = gateToolWithCapabilities(notify, access);
  return {
    invoke: () => runWithRequestContext({
      callType: 'chat',
      channelId: 'api:testing-harness',
      purpose: 'agent.turn.prompt',
      requesterProvenance: 'human',
      requestAudience: 'external',
    }, () => gated.execute(`matrix-${tier}-${entry.id}`, entry.params)),
    handlerInvocationCount: () => handlerInvocationCount,
  };
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function parseDenial(result: AgentToolResult<unknown>): EgressCapabilityMatrixDenial | null {
  if (!isRecord(result.details) || result.details.capabilityDenied !== true) return null;
  const missingTokens = Array.isArray(result.details.missingTokens)
    ? result.details.missingTokens.filter(token => typeof token === 'string')
    : [];
  return {
    capabilityDenied: true,
    tier: typeof result.details.tier === 'string' ? result.details.tier : '',
    missingTokens,
  };
}

function assertRow(
  entry: EgressCapabilityMatrixCase,
  tier: EgressCapabilityMatrixTier,
  expected: 'allow' | 'deny',
  handlerInvocationCount: number,
  denial: EgressCapabilityMatrixDenial | null,
  text: string,
  result: AgentToolResult<unknown>,
): void {
  const productionGrantsCapability = resolveTierCapabilityTokens(tier).includes(entry.capability);
  if (productionGrantsCapability !== (expected === 'allow')) {
    throw new Error(
      `Egress capability catalog drift for ${tier}/${entry.capability}: expected ${expected}`,
    );
  }
  if (expected === 'allow') {
    if (handlerInvocationCount !== 1 || denial || (isRecord(result.details) && result.details.isError === true)) {
      throw new Error(
        `Egress capability allow certification failed for ${tier}/${entry.capability}: `
        + `handlerInvocations=${handlerInvocationCount}`,
      );
    }
    return;
  }
  if (handlerInvocationCount !== 0) {
    throw new Error(
      `Egress capability deny leaked a side effect for ${tier}/${entry.capability}: `
      + `handlerInvocations=${handlerInvocationCount}`,
    );
  }
  if (
    !denial
    || denial.tier !== tier
    || denial.missingTokens.length !== 1
    || denial.missingTokens[0] !== entry.capability
    || !text.includes(entry.capability)
  ) {
    throw new Error(`Egress capability refusal shape failed for ${tier}/${entry.capability}`);
  }
}

export async function runEgressCapabilityMatrixCertification(): Promise<EgressCapabilityMatrixReport> {
  const rows: EgressCapabilityMatrixRow[] = [];
  for (const tier of EGRESS_CAPABILITY_MATRIX_TIERS) {
    for (const entry of EGRESS_CAPABILITY_MATRIX_CASES) {
      const allowedTiers: readonly EgressCapabilityMatrixTier[] = entry.allowedTiers;
      const expected = allowedTiers.includes(tier) ? 'allow' : 'deny';
      const probe = createSafeProbe(entry, tier);
      const result = await probe.invoke();
      const invocations = probe.handlerInvocationCount();
      const denial = parseDenial(result);
      const text = resultText(result);
      assertRow(entry, tier, expected, invocations, denial, text, result);
      rows.push({
        caseId: entry.id,
        tier,
        capability: entry.capability,
        expected,
        handlerInvocationCount: invocations,
        denial,
        resultText: text,
      });
    }
  }
  return { status: 'passed', rows };
}
