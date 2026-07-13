import type { IcpInitiationCandidateSharedMetadata } from '../../core/icp/initiation-candidate.js';
import type { IcpInitiationPolicySnapshot } from './icp-autonomy-contract.js';

export interface IcpInitiationPolicyAuthorityInput {
  senderCompanionId: string;
  candidate: IcpInitiationCandidateSharedMetadata;
  channelId: string;
  nowMs: number;
}

/** Trusted gateway-owned resolver for every deterministic pre-LLM policy fact. */
export interface GatewayIcpInitiationPolicyAuthority {
  resolve(input: IcpInitiationPolicyAuthorityInput): Promise<IcpInitiationPolicySnapshot>;
  close(): Promise<void>;
}

export interface IcpInitiationCapacityPolicyDecision {
  socialPressureAllows: boolean;
  chargeAllows: boolean;
  fatigueAllows: boolean;
  costAllows: boolean;
}

/**
 * Capacity policy is deliberately separate from identity/provenance. Until the
 * later ICP charge/fatigue/cost owners exist, production leaves this absent and
 * the gateway authority fails those gates closed.
 */
export interface IcpInitiationCapacityPolicyAuthority {
  resolve(input: IcpInitiationPolicyAuthorityInput): Promise<IcpInitiationCapacityPolicyDecision>;
}

/** Independent-root proof supplied by the canonical provenance/causality owner. */
export interface IcpInitiationCausalityAuthority {
  isIndependentRoot(input: IcpInitiationPolicyAuthorityInput): Promise<boolean>;
}
