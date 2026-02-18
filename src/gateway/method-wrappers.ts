import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors, type PolicyDecision } from './protocol.js';

export interface AuditHooks {
  audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number;
  auditComplete(id: number, startTime: number, error?: string): void;
}

export interface AuditedHandlerOptions<P, R> {
  method: string;
  handler: (params: P) => Promise<R>;
  paramsSummary?: (params: P) => Record<string, unknown>;
}

export interface GatedHandlerOptions<P, R> extends AuditedHandlerOptions<P, R> {
  evaluateDecision: (method: string, params: P) => PolicyDecision;
  requestApproval: (action: string, scope: string, reason: string) => Promise<boolean>;
  approvalAction: string;
  approvalScope: (params: P) => string;
  approvalReason?: string;
}

export function createAuditedHandler<P, R>(
  hooks: AuditHooks,
  options: AuditedHandlerOptions<P, R>,
): (params: P) => Promise<R> {
  return async (params: P) => {
    const summary = options.paramsSummary ? options.paramsSummary(params) : undefined;
    const auditId = hooks.audit(options.method, 'ALLOW', summary);
    const startTime = Date.now();
    try {
      const result = await options.handler(params);
      hooks.auditComplete(auditId, startTime);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hooks.auditComplete(auditId, startTime, msg);
      throw err;
    }
  };
}

export function createGatedHandler<P, R>(
  hooks: AuditHooks,
  options: GatedHandlerOptions<P, R>,
): (params: P) => Promise<R> {
  return async (params: P) => {
    const decision = options.evaluateDecision(options.method, params);
    const summary = options.paramsSummary ? options.paramsSummary(params) : undefined;
    const auditId = hooks.audit(options.method, decision, summary);
    const startTime = Date.now();

    try {
      if (decision === 'DENY') {
        throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
      }
      if (decision === 'NEEDS_APPROVAL') {
        const approved = await options.requestApproval(
          options.approvalAction,
          options.approvalScope(params),
          options.approvalReason ?? 'Outside workspace',
        );
        if (!approved) {
          throw new JSONRPCErrorException('Approval denied', GatewayErrors.APPROVAL_DENIED);
        }
      }
      const result = await options.handler(params);
      hooks.auditComplete(auditId, startTime);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hooks.auditComplete(auditId, startTime, msg);
      throw err;
    }
  };
}
