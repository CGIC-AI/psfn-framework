import { isIP } from 'node:net';
import { Agent } from 'undici';

/** Bind transport DNS to a policy-approved address without changing Host/SNI. */
export function createPinnedAddressAgent(options: {
  address: string;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  /** Encoded response-body limit on the wire, before fetch content decoding. */
  maxResponseBytes: number;
  maxOrigins: number;
  connections?: number;
  tlsCa?: string;
}): Agent {
  const { address } = options;
  const family = isIP(address);
  if (!family) throw new Error('Pinned transport requires a literal IP address');
  return new Agent({
    connectTimeout: options.connectTimeoutMs,
    headersTimeout: options.requestTimeoutMs,
    bodyTimeout: options.requestTimeoutMs,
    maxResponseSize: options.maxResponseBytes,
    maxOrigins: options.maxOrigins,
    ...(options.connections === undefined ? {} : { connections: options.connections }),
    connect: {
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      },
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(options.tlsCa ? { ca: options.tlsCa } : {}),
    },
  });
}
