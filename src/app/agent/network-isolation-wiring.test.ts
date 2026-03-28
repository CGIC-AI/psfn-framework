import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('agent startup network isolation enforcement', () => {
  const mainSource = readSource('main.ts');
  const helperSource = readSource('startup-guards.ts');

  it('probes outbound network access on startup', () => {
    expect(helperSource).toContain("const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace'");
    expect(helperSource).toContain('fetch(NETWORK_ISOLATION_PROBE_URL');
    expect(helperSource).toContain("method: 'HEAD'");
    expect(mainSource).toContain('await enforceNetworkIsolationOnStartup();');
  });

  it('fails closed when outbound access is reachable', () => {
    expect(helperSource).toContain("log.error(`CRITICAL:");
    expect(helperSource).toContain('throw error;');
    expect(helperSource).not.toContain('if (requireIsolation) {');
  });

  it('supports only the explicit temporary override', () => {
    expect(helperSource).toContain('ALLOW_AGENT_OUTBOUND_NETWORK=true set; startup network-isolation guard is bypassed by explicit operator override.');
    expect(helperSource).toContain('allowOutboundNetwork');
  });
});
