import type {
  IcpInitiationCausalityAuthority,
  IcpInitiationPolicyAuthorityInput,
} from './icp-initiation-policy-authority.js';

/**
 * Candidate adapters bind an independent source root to the deterministic
 * candidate id. A candidate derived only from an ICP turn must preserve the
 * inherited root instead, making the inequality a content-free recursion
 * proof at the trusted gateway boundary.
 */
export class RootBoundIcpInitiationCausalityAuthority implements IcpInitiationCausalityAuthority {
  async isIndependentRoot(input: IcpInitiationPolicyAuthorityInput): Promise<boolean> {
    return input.candidate.rootInitiationId === input.candidate.candidateId;
  }
}
