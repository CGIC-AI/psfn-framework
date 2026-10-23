import { JSONRPCClient, type JSONRPCID, type JSONRPCRequest, type JSONRPCResponse } from 'json-rpc-2.0';
import { GATEWAY_RPC_OUTBOUND_FRAMES } from '../transport-flow-limits.js';

/** Tracks live reverse requests so only their responses use reserved capacity. */
export class GatewayRpcClient extends JSONRPCClient {
  private readonly pendingResponses = new Set<JSONRPCID>();

  expectsResponse(message: Record<string, unknown>): boolean {
    return !Object.hasOwn(message, 'method') && this.pendingResponses.has(message.id as JSONRPCID);
  }

  override requestAdvanced(request: JSONRPCRequest, params: void): Promise<JSONRPCResponse>;
  override requestAdvanced(request: JSONRPCRequest[], params: void): Promise<JSONRPCResponse[]>;
  override requestAdvanced(request: JSONRPCRequest | JSONRPCRequest[], params: void): Promise<JSONRPCResponse | JSONRPCResponse[]> {
    const ids = (Array.isArray(request) ? request : [request])
      .map(frame => frame.id).filter(id => id !== undefined && id !== null);
    if (ids.some(id => this.pendingResponses.has(id))
      || ids.length > GATEWAY_RPC_OUTBOUND_FRAMES - this.pendingResponses.size) {
      return Promise.reject(new Error('Gateway RPC pending reverse request limit exceeded'));
    }
    for (const id of ids) this.pendingResponses.add(id);
    const result = Array.isArray(request)
      ? super.requestAdvanced(request, params)
      : super.requestAdvanced(request, params);
    return Promise.resolve<JSONRPCResponse | JSONRPCResponse[]>(result).finally(() => {
      for (const id of ids) this.pendingResponses.delete(id);
    });
  }
}
