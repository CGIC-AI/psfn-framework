import type { CompiledGardenRequestTarget } from '../fleet-auth/request-capability-target.js';
import {
  type GatewayRequestCapabilitySigner,
  type RequestCapabilityAuthorityVersions,
  type RequestCapabilityParentBinding,
  type RequestCapabilityVerifier,
  type RequestCapabilityVerifyInput,
  type VerifiedRequestCapability,
} from '../fleet-auth/request-capability.js';
import {
  compileRequestCapabilityReplayConsumption,
  type RequestCapabilityReplayPort,
} from '../fleet-auth/request-capability-replay.js';

export interface AuthenticatedOperatorControlIdentity {
  readonly kind: 'operator_process';
  readonly operatorId: `operator:${string}`;
  readonly companionId: string;
}

export interface ChildAssertionAuthorityInput {
  readonly operator: AuthenticatedOperatorControlIdentity;
  readonly parent: VerifiedRequestCapability;
  readonly parentTarget: CompiledGardenRequestTarget;
  readonly childTarget: CompiledGardenRequestTarget;
}

export type ChildAssertionAuthorityDecision =
  | {
      readonly decision: 'allow';
      readonly decisionId: string;
      readonly versions: RequestCapabilityAuthorityVersions;
    }
  | { readonly decision: 'deny' };

export interface GatewayChildAssertionAuthorityPort {
  reauthorize(input: ChildAssertionAuthorityInput): Promise<ChildAssertionAuthorityDecision>;
}

export interface GatewayChildAssertionExchangeInput {
  readonly operator: AuthenticatedOperatorControlIdentity;
  readonly parent: RequestCapabilityVerifyInput;
  readonly child: {
    readonly target: CompiledGardenRequestTarget;
    readonly requestId: string;
  };
}

export interface GatewayChildAssertionExchangeResult {
  readonly token: string;
  readonly target: CompiledGardenRequestTarget;
  readonly requestId: string;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly parent: RequestCapabilityParentBinding;
}

export class GatewayChildAssertionDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Gateway child assertion exchange was denied');
    this.name = 'GatewayChildAssertionDeniedError';
  }
}

/**
 * The authenticated operator control plane may exchange, but never forward,
 * an operator capability. The gateway verifies and consumes the parent,
 * reauthorizes exact current authority, then signs a linked agent-only child.
 */
export class GatewayFleetAuthChildAssertionBroker {
  constructor(private readonly options: {
    verifier: RequestCapabilityVerifier;
    signer: GatewayRequestCapabilitySigner;
    replay: RequestCapabilityReplayPort;
    authority: GatewayChildAssertionAuthorityPort;
  }) {}

  async exchange(
    input: GatewayChildAssertionExchangeInput,
  ): Promise<GatewayChildAssertionExchangeResult> {
    const expectedOperatorId = `operator:${input.operator.companionId}`;
    if (input.operator.operatorId !== expectedOperatorId
      || input.parent.target.companionId !== input.operator.companionId
      || input.child.target.companionId !== input.operator.companionId) {
      throw new GatewayChildAssertionDeniedError();
    }

    let verified: VerifiedRequestCapability;
    try {
      verified = this.options.verifier.verifyOperator(input.parent);
    } catch {
      throw new GatewayChildAssertionDeniedError();
    }
    if (verified.audience !== expectedOperatorId) {
      throw new GatewayChildAssertionDeniedError();
    }

    const replay = await this.options.replay.consume(
      compileRequestCapabilityReplayConsumption({
        token: input.parent.token,
        verified,
        target: input.parent.target,
      }),
    );
    if (replay.outcome === 'mismatch') throw new GatewayChildAssertionDeniedError();

    const authority = await this.options.authority.reauthorize({
      operator: input.operator,
      parent: verified,
      parentTarget: input.parent.target,
      childTarget: input.child.target,
    });
    if (authority.decision === 'deny') throw new GatewayChildAssertionDeniedError();

    const parent = Object.freeze({
      audience: verified.audience as `operator:${string}`,
      requestId: verified.requestId,
      decisionId: verified.decisionId,
      jti: verified.jti,
      targetDigest: verified.targetDigest,
    });
    const token = this.options.signer.signAgent({
      target: input.child.target,
      requestId: input.child.requestId,
      decisionId: authority.decisionId,
      versions: authority.versions,
      parent,
    });
    return Object.freeze({
      token,
      target: input.child.target,
      requestId: input.child.requestId,
      decisionId: authority.decisionId,
      versions: Object.freeze({ ...authority.versions }),
      parent,
    });
  }
}
