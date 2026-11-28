import { createHash } from 'node:crypto';
import type { CompiledGardenRequestTarget } from '../fleet-auth/request-capability-target.js';
import {
  TESTING_HARNESS_REQUEST_CAPABILITY_AUDIENCE,
  type GatewayRequestCapabilitySigner,
  type RequestCapabilityAuthorityVersions,
  type RequestCapabilityParentAudience,
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

interface ReplayScope {
  readonly domain: string;
  readonly jtiPrefix: string;
}

// The gateway already consumed the parent while minting/proxying it. A scope
// gives one specific use of that parent its own durable single-use fence
// while preserving the exact signed consumption material and parent expiry.
const TESTING_HARNESS_CHILD_REPLAY_SCOPE: ReplayScope = Object.freeze({
  domain: 'testing-harness-child-assertion-exchange-v1',
  jtiPrefix: 'testing-harness-child-',
});
const GATEWAY_EFFECT_REPLAY_SCOPE: ReplayScope = Object.freeze({
  domain: 'gateway-operator-effect-v1',
  jtiPrefix: 'gateway-effect-',
});

function scopeReplayConsumption(
  consumption: ReturnType<typeof compileRequestCapabilityReplayConsumption>,
  scope: ReplayScope,
): ReturnType<typeof compileRequestCapabilityReplayConsumption> {
  const jti = createHash('sha256')
    .update(`${scope.domain}\0`)
    .update(consumption.issuer)
    .update('\0')
    .update(consumption.jti)
    .digest('hex');
  return Object.freeze({
    ...consumption,
    jti: `${scope.jtiPrefix}${jti}`,
  });
}

export class GatewayChildAssertionDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Gateway child assertion exchange was denied');
    this.name = 'GatewayChildAssertionDeniedError';
  }
}

export interface GatewayOperatorEffectInput {
  readonly operator: AuthenticatedChildAssertionControlIdentity;
  readonly parent: RequestCapabilityVerifyInput;
}

interface AuthorizedGatewayOperatorEffect {
  readonly verified: VerifiedRequestCapability;
  /** The verified parent audience, narrowed to the parent (never agent) form. */
  readonly parentAudience: RequestCapabilityParentAudience;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
}

/**
 * The authenticated operator control plane may exchange, but never forward,
 * an operator capability. The gateway verifies and consumes the parent,
 * reauthorizes exact current SSO authority, then either signs a linked
 * agent-only child or authorizes one gateway-executed effect for the parent's
 * exact target. A short-lived admin-token parent is already bound to the
 * boot-frozen shared credential at the canonical gateway admission seam, so it
 * carries its signed decision and versions forward without a nonexistent SSO
 * session.
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
    const { verified, parentAudience, decisionId, versions } = await this.authorizeParent({
      operator: input.operator,
      parent: input.parent,
      effectiveTarget: input.child.target,
      replayScope: input.operator.kind === 'testing_harness_provider'
        ? TESTING_HARNESS_CHILD_REPLAY_SCOPE
        : undefined,
    });
    const parent = Object.freeze({
      audience: parentAudience,
      requestId: verified.requestId,
      decisionId: verified.decisionId,
      jti: verified.jti,
      targetDigest: verified.targetDigest,
    });
    const token = this.options.signer.signAgent({
      target: input.child.target,
      requestId: input.child.requestId,
      decisionId,
      authContext: verified.authContext,
      versions,
      parent,
    });
    return Object.freeze({
      token,
      target: input.child.target,
      requestId: input.child.requestId,
      decisionId,
      versions: Object.freeze({ ...versions }),
      parent,
    });
  }

  /**
   * Authorizes the gateway itself to perform the parent's exact target, for
   * gateway-owned state an agent child cannot reach (for example the
   * gateway approval queue). Each parent authorizes at most one such effect.
   */
  async authorizeGatewayEffect(
    input: GatewayOperatorEffectInput,
  ): Promise<AuthorizedGatewayOperatorEffect> {
    return await this.authorizeParent({
      operator: input.operator,
      parent: input.parent,
      effectiveTarget: input.parent.target,
      replayScope: GATEWAY_EFFECT_REPLAY_SCOPE,
    });
  }

  private async authorizeParent(input: {
    readonly operator: AuthenticatedChildAssertionControlIdentity;
    readonly parent: RequestCapabilityVerifyInput;
    readonly effectiveTarget: CompiledGardenRequestTarget;
    /** Present: this use is single-use under its own fence. */
    readonly replayScope: ReplayScope | undefined;
  }): Promise<AuthorizedGatewayOperatorEffect> {
    const expectedOperatorId: `operator:${string}` = `operator:${input.operator.companionId}`;
    if (input.parent.target.companionId !== input.operator.companionId
      || input.effectiveTarget.companionId !== input.operator.companionId) {
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
    const expectedParentAudience: RequestCapabilityParentAudience =
      input.operator.kind === 'testing_harness_provider'
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
        || !testingHarness.allowedActions.includes(input.effectiveTarget.action)
        || input.effectiveTarget.action !== verified.action)) {
      throw new GatewayChildAssertionDeniedError();
    }

    const replayConsumption = compileRequestCapabilityReplayConsumption({
      token: input.parent.token,
      verified,
      target: input.parent.target,
    });
    const replay = await this.options.replay.consume(
      input.replayScope
        ? scopeReplayConsumption(replayConsumption, input.replayScope)
        : replayConsumption,
    );
    if (replay.outcome === 'mismatch'
      || (input.replayScope && replay.outcome !== 'consumed')) {
      throw new GatewayChildAssertionDeniedError();
    }

    const authority = verified.authContext.provider === 'admin_token'
      ? {
          decision: 'allow' as const,
          decisionId: verified.decisionId,
          versions: verified.versions,
        }
      : input.operator.kind === 'operator_process'
      ? await this.options.authority.reauthorize({
          operator: input.operator,
          parent: verified,
          parentTarget: input.parent.target,
          childTarget: input.effectiveTarget,
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
      // subject into a child or effect would make revocation races
      // authorization wins.
      throw new GatewayChildAssertionDeniedError();
    }
    return Object.freeze({
      verified,
      parentAudience: expectedParentAudience,
      decisionId: authority.decisionId,
      versions: authority.versions,
    });
  }
}
