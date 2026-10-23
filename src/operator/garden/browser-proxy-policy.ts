import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

function proxyRange(value: string): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  const [address, prefix] = value.split('/');
  if (!address || !isIP(address) || value.split('/').length > 2
    || (prefix !== undefined && !/^\d+$/.test(prefix))) {
    throw new Error('Garden proxy sources must be literal IP addresses or CIDR networks');
  }
  const parsed = ipaddr.process(address);
  const bits = parsed.kind() === 'ipv4' ? 32 : 128;
  const length = prefix === undefined ? bits : Number(prefix);
  if (length <= 0 || length > bits || parsed.range() === 'unspecified') {
    throw new Error('Garden proxy sources must not include wildcard or all-network addresses');
  }
  return [parsed, length];
}

export function validateGardenProxySources(sources: readonly string[]): void {
  for (const source of sources) proxyRange(source);
}

export function matchesGardenProxyPeer(peer: string, sources: readonly string[]): boolean {
  const address = ipaddr.process(peer);
  return sources.some(source => {
    const [network, length] = proxyRange(source);
    return address.kind() === network.kind() && address.match(network, length);
  });
}
