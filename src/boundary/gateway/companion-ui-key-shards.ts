import type { CompiledCompanionUiAction } from '../fleet-auth/companion-ui-action.js';
import type { ApiAuthPrincipal } from '../../channels/backplane/http/auth.js';
import type {
  ApiCompanionUiKeyShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
} from '../../channels/api/types.js';

export interface CompanionUiKeyShardRuntimePort {
  handleCompanionUiKeyShardAction(
    companionId: string,
    input: Omit<ApiCompanionUiKeyShardActionRpcParams, 'requestId'>,
  ): Promise<ApiCompanionUiShardActionRpcResult>;
}

/**
 * Key-path shard frames (psfn-framework-m1is8). An ADMIN_TOKEN / API_KEY
 * session is the human authority, exactly as on the REST API, so `shards.*`
 * frames go to the agent's key-authenticated shard route with the key
 * principal and the exact raw frame. The agent re-applies the key ceiling and
 * its own parent/shard binding; any failure is surfaced as a denial.
 */
export async function dispatchCompanionUiKeyShard(input: {
  compiled: CompiledCompanionUiAction;
  rawBody: Uint8Array;
  principal: ApiAuthPrincipal;
  runtime: CompanionUiKeyShardRuntimePort;
}): Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>> {
  if (!input.compiled.frame.resource.startsWith('shards.')) {
    return Object.freeze({ handled: false });
  }
  if (input.principal.mode !== 'api_key') {
    throw new Error('Companion UI key shard action requires an api_key principal');
  }
  const result = await input.runtime.handleCompanionUiKeyShardAction(
    input.compiled.target.companionId,
    {
      principal: input.principal,
      rawBodyBase64Url: Buffer.from(input.rawBody).toString('base64url'),
    },
  );
  if (!result.ok) throw new Error(result.error.type);
  return Object.freeze({ handled: true, result: result.response });
}
