import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('agent startup network isolation enforcement', () => {
  const source = readSource('agent-main.ts');

  it('probes outbound network access on startup', () => {
    expect(source).toContain("const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace'");
    expect(source).toContain('fetch(NETWORK_ISOLATION_PROBE_URL');
    expect(source).toContain("method: 'HEAD'");
    expect(source).toContain('await enforceNetworkIsolationOnStartup();');
  });

  it('fails closed when outbound access is reachable', () => {
    expect(source).toContain("log.error(`CRITICAL:");
    expect(source).toContain('throw error;');
    expect(source).not.toContain('if (requireIsolation) {');
  });

  it('supports only the explicit temporary override', () => {
    expect(source).toContain('ALLOW_AGENT_OUTBOUND_NETWORK=true set; startup network-isolation guard is bypassed by explicit operator override.');
    expect(source).toContain('allowOutboundNetwork');
  });
});
