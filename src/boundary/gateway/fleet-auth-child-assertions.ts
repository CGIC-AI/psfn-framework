import { createHash } from 'node:crypto';
import type { CompiledGardenRequestTarget } from '../fleet-auth/request-capability-target.js';
import {
  TESTING_HARNESS_REQUEST_CAPABILITY_AUDIENCE,
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
import type {
  TestingHarnessGardenAdminConfig,
} from '../../channels/backplane/testing-harness-garden-config.js';

export interface AuthenticatedOperatorControlIdentity {
  readonly kind: 'operator_process';
  readonly operatorId: `operator:${string}`;
  readonly companionId: string;
}

export interface AuthenticatedTestingHarnessControlIdentity {
  readonly kind: 'testing_harness_provider';
  readonly provider: 'testing_harness';
  readonly audience: string;
  readonly companionId: string;
}

export type AuthenticatedChildAssertionControlIdentity =
  | AuthenticatedOperatorControlIdentity
  | AuthenticatedTestingHarnessControlIdentity;

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
  readonly operator: AuthenticatedChildAssertionControlIdentity;
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

function authorityVersionsMatch(
  left: RequestCapabilityAuthorityVersions,
  right: RequestCapabilityAuthorityVersions,
): boolean {
  return left.authorityGeneration === right.authorityGeneration
    && left.globalAuthEpoch === right.globalAuthEpoch
    && left.sessionAuthnVersion === right.sessionAuthnVersion
    && left.sessionAuthzVersion === right.sessionAuthzVersion
    && left.bindingVersion === right.bindingVersion
    && left.grantVersion === right.grantVersion
    && left.policyVersion === right.policyVersion;
}

function scopeTestingHarnessChildExchangeReplay(
  consumption: ReturnType<typeof compileRequestCapabilityReplayConsumption>,
): ReturnType<typeof compileRequestCapabilityReplayConsumption> {
  // The gateway already consumed the parent while minting/proxying it. Give the
  // harness child exchange its own durable single-use fence while preserving
  // the exact signed consumption material and parent expiry.
  const jti = createHash('sha256')
    .update('testing-harness-child-assertion-exchange-v1\0')
    .update(consumption.issuer)
    .update('\0')
    .update(consumption.jti)
    .digest('hex');
  return Object.freeze({
    ...consumption,
    jti: `testing-harness-child-${jti}`,
  });
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
    testingHarness?: TestingHarnessGardenAdminConfig;
  }) {}

  async exchange(
    input: GatewayChildAssertionExchangeInput,
  ): Promise<GatewayChildAssertionExchangeResult> {
    const expectedOperatorId: `operator:${string}` = `operator:${input.operator.companionId}`;
    if (input.parent.target.companionId !== input.operator.companionId
      || input.child.target.companionId !== input.operator.companionId) {
      throw new GatewayChildAssertionDeniedError();
    }

    const testingHarness = input.operator.kind === 'testing_harness_provider'
      ? this.options.testingHarness
      : undefined;
    if (input.operator.kind === 'operator_process') {
      if (input.operator.operatorId !== expectedOperatorId) {
        throw new GatewayChildAssertionDeniedError();
      }
    } else if (!testingHarness?.enabled
      || input.operator.audience !== testingHarness.principalId) {
      throw new GatewayChildAssertionDeniedError();
    }

    let verified: VerifiedRequestCapability;
    try {
      verified = input.operator.kind === 'testing_harness_provider'
        ? this.options.verifier.verifyTestingHarness(input.parent)
        : this.options.verifier.verifyOperator(input.parent);
    } catch {
      throw new GatewayChildAssertionDeniedError();
    }
    const expectedParentAudience = input.operator.kind === 'testing_harness_provider'
      ? TESTING_HARNESS_REQUEST_CAPABILITY_AUDIENCE
      : expectedOperatorId;
    if (verified.audience !== expectedParentAudience) {
      throw new GatewayChildAssertionDeniedError();
    }
    if (input.operator.kind === 'testing_harness_provider'
      && (!testingHarness
        || verified.authContext.provider !== 'testing_harness'
        || verified.authContext.principalId !== input.operator.audience
        || verified.authContext.providerSubjectId !== input.operator.audience
        || verified.authContext.operatorGrantId !== testingHarness.operatorGrantId
        || verified.authContext.role !== testingHarness.role
        || !testingHarness.allowedActions.includes(verified.action)
        || !testingHarness.allowedActions.includes(input.child.target.action)
        || input.child.target.action !== verified.action)) {
      throw new GatewayChildAssertionDeniedError();
    }

    const replayConsumption = compileRequestCapabilityReplayConsumption({
      token: input.parent.token,
      verified,
      target: input.parent.target,
    });
    const replay = await this.options.replay.consume(
      input.operator.kind === 'testing_harness_provider'
        ? scopeTestingHarnessChildExchangeReplay(replayConsumption)
        : replayConsumption,
    );
    if (replay.outcome === 'mismatch'
      || (input.operator.kind === 'testing_harness_provider'
        && replay.outcome !== 'consumed')) {
      throw new GatewayChildAssertionDeniedError();
    }

    const authority = input.operator.kind === 'operator_process'
      ? await this.options.authority.reauthorize({
          operator: input.operator,
          parent: verified,
          parentTarget: input.parent.target,
          childTarget: input.child.target,
        })
      : {
          decision: 'allow' as const,
          decisionId: verified.decisionId,
          versions: verified.versions,
        };
    if (authority.decision === 'deny') throw new GatewayChildAssertionDeniedError();
    if (!authorityVersionsMatch(authority.versions, verified.versions)) {
      // Reauthorization observed a fence/version transition. The gateway must
      // issue a fresh operator decision and actor snapshot; carrying the old
      // subject into a child would make revocation races authorization wins.
      throw new GatewayChildAssertionDeniedError();
    }

    const parent = Object.freeze({
      audience: verified.audience,
      requestId: verified.requestId,
      decisionId: verified.decisionId,
      jti: verified.jti,
      targetDigest: verified.targetDigest,
    });
    const token = this.options.signer.signAgent({
      target: input.child.target,
      requestId: input.child.requestId,
      decisionId: authority.decisionId,
      authContext: verified.authContext,
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
