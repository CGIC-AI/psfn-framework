// psfn-framework-h248l.7 — the content-free wire contract for companion-local
// welfare-grant verification.
//
// Welfare authority is dynamic runtime state that lives ONLY in a companion's
// own background-work store. In an isolated fleet the gateway holds no sibling
// schema grant, so it cannot read that store directly: it asks the authenticated
// companion agent instead, over the existing reverse-RPC channel, exactly as
// `icp.policy.*` asks each companion for its own local policy decision.
//
// The answer is one boolean plus the echoed companion id. No job payload, no
// session identity, no schema name, and no row ever crosses this boundary.

import { isRecord } from '../../shared/utils/types.js';

export const WELFARE_GRANT_VERIFY_METHOD = 'welfare.grant.verify';

export interface WelfareGrantVerifyParams {
  /** Opaque background-work job id the caller asserted a welfare grant for. */
  jobId: string;
  /** The gateway-authenticated companion the assertion was made by. */
  companionId: string;
}

export interface WelfareGrantVerifyResult {
  /** Echoed so the gateway can prove the answer came from the companion it asked. */
  companionId: string;
  /** True only for a `welfare_claimed`, `running` job in THIS companion's store. */
  granted: boolean;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function parseWelfareGrantVerifyParams(value: unknown): WelfareGrantVerifyParams {
  if (!isRecord(value)) throw new Error('welfare.grant.verify params must be an object');
  const unknownKeys = Object.keys(value).filter(key => key !== 'jobId' && key !== 'companionId');
  if (unknownKeys.length > 0) {
    throw new Error(`welfare.grant.verify params contain unknown fields: ${unknownKeys.join(', ')}`);
  }
  return {
    jobId: requireIdentifier(value.jobId, 'welfare.grant.verify params.jobId'),
    companionId: requireIdentifier(value.companionId, 'welfare.grant.verify params.companionId'),
  };
}

export function parseWelfareGrantVerifyResult(value: unknown): WelfareGrantVerifyResult {
  if (!isRecord(value)) throw new Error('welfare.grant.verify result must be an object');
  const unknownKeys = Object.keys(value).filter(key => key !== 'companionId' && key !== 'granted');
  if (unknownKeys.length > 0) {
    throw new Error(`welfare.grant.verify result contains unknown fields: ${unknownKeys.join(', ')}`);
  }
  if (typeof value.granted !== 'boolean') {
    throw new Error('welfare.grant.verify result.granted must be boolean');
  }
  return {
    companionId: requireIdentifier(value.companionId, 'welfare.grant.verify result.companionId'),
    granted: value.granted,
  };
}
