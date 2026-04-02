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

  it('logs a CRITICAL warning when outbound access is reachable', () => {
    const reachableBlock = /if \(!probeResult\.reachable\) \{[\s\S]*?\n  \}/m.exec(source)?.[0] ?? source;
    expect(reachableBlock).toContain('return;');
    expect(source).toContain("log.error(`CRITICAL:");
    expect(source).toContain('requireNetworkIsolation: true');
    expect(source).toContain('requireNetworkIsolationEnv: process.env.REQUIRE_NETWORK_ISOLATION');
  });

  it('fails closed by default and only allows explicit outbound override', () => {
    expect(source).toContain('process.env.REQUIRE_NETWORK_ISOLATION');
    expect(source).toContain('ALLOW_AGENT_OUTBOUND_NETWORK');
    expect(source).toContain('REQUIRE_NETWORK_ISOLATION=false is ignored; network-isolation now fails closed by default.');
    expect(source).toContain('throw error;');
  });
});
