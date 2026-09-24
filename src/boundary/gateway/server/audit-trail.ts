// Gateway audit trail: DENY/ALLOW audit rows with correlation logging, the
// audited() RPC handler wrapper (canary egress tripwire + method health), and
// the reverse-RPC reply canary scan applied before replies reach channels.
import { stripCanaryCarrier } from '../../../core/cogsec/canary/egress-scan.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { GatewayPolicyDecision } from '../protocol.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');

export class GatewayAuditTrail {
  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      'options' | 'canaryEgressGuard' | 'runtimeHealthTracker'
    >,
  ) {}

  // Wrap a handler with audit timing — logs call, records duration/error on completion
  audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R> {
    return async (params: P) => {
      // htm9.18 egress tripwire: hold the action if the session canary leaked
      // into an outbound method, and strip the carrier before it reaches the
      // handler or any audit summary.
      let cleaned: P;
      try {
        cleaned = (this.ports.canaryEgressGuard
          ? this.ports.canaryEgressGuard.inspect(method, params)
          : params) as P;
      } catch (err) {
        this.ports.runtimeHealthTracker.recordMethodFailure(method, err);
        const heldAuditId = await this.audit(method, 'DENY', { canaryEgressHeld: true });
        await this.auditComplete(heldAuditId, Date.now(), toErrorMessage(err));
        throw err;
      }
      const summary = paramsSummary ? paramsSummary(cleaned) : undefined;
      const auditId = await this.audit(method, 'ALLOW', summary);
      const startTime = Date.now();
      try {
        const result = await handler(cleaned);
        this.ports.runtimeHealthTracker.recordMethodSuccess(method);
        await this.auditComplete(auditId, startTime);
        return result;
      } catch (err) {
        this.ports.runtimeHealthTracker.recordMethodFailure(method, err);
        const msg = toErrorMessage(err);
        await this.auditComplete(auditId, startTime, msg);
        throw err;
      }
    };
  }

  /**
   * d269: scan a reverse-RPC reply result at the gateway seam before it can
   * reach any channel adapter. Strips the reserved canary carrier in every
   * mode; when the CogSec guard is active, a reply carrying its own session
   * canary is HELD in enforce mode (recorded + audited) and observed in
   * shadow. This adds no RPC round-trips — one substring scan on the already
   * in-hand result.
   */
  async inspectAgentReply<T>(method: string, result: T): Promise<T> {
    if (!this.ports.canaryEgressGuard) {
      return stripCanaryCarrier(result) as T;
    }
    try {
      return this.ports.canaryEgressGuard.inspectReply(method, result) as T;
    } catch (error) {
      const auditId = await this.audit(method, 'DENY', { canaryReplyHeld: true });
      await this.auditComplete(auditId, Date.now(), toErrorMessage(error));
      throw error;
    }
  }

  async audit(method: string, decision: GatewayPolicyDecision, params?: Record<string, unknown>): Promise<number> {
    const correlation = extractGatewayCorrelation(params);
    if (decision !== 'ALLOW') {
      log.info(`${method} → ${decision}`, {
        ...(Object.keys(correlation).length > 0 ? correlation : {}),
      });
    }
    if (this.ports.options.auditStore) {
      return await this.ports.options.auditStore.append({ method, decision, params });
    }
    return 0;
  }

  async auditComplete(id: number, startTime: number, error?: string): Promise<void> {
    if (this.ports.options.auditStore && id > 0) {
      await this.ports.options.auditStore.complete(id, Date.now() - startTime, error);
    }
  }
}

function extractGatewayCorrelation(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params) return {};
  const correlation: Record<string, string> = {};
  for (const key of [
    'companionId',
    'turnId',
    'requestId',
    'channelId',
    'callType',
    'originType',
    'originStage',
    'toolName',
    'toolCallId',
    'purpose',
  ]) {
    const value = params[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    correlation[key] = trimmed;
  }
  return correlation;
}
