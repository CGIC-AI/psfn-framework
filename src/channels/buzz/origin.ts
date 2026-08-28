function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** Normalize one Buzz community relay boundary and reject ambiguous URL forms. */
export function normalizeBuzzRelayUrl(value: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be an absolute ws:// or wss:// URL`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`${fieldName} must use ws:// or wss://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} must not include credentials`);
  }
  if (parsed.pathname !== '/') {
    throw new Error(`${fieldName} must not include a path`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${fieldName} must not include a query or fragment`);
  }
  if (parsed.protocol === 'ws:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${fieldName} must use wss:// unless it is loopback`);
  }
  return parsed.origin;
}
