/** Decodes untrusted JSON-RPC params into one method's exact parameter contract. */
export type RpcParamsDecoder<P> = (params: unknown) => P;
