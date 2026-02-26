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
    expect(source).toContain('requireNetworkIsolation: requireIsolation');
  });

  it('supports optional hard fail via REQUIRE_NETWORK_ISOLATION', () => {
    expect(source).toContain('process.env.REQUIRE_NETWORK_ISOLATION');
    expect(source).toContain('if (requireIsolation) {');
    expect(source).toContain('throw error;');
  });
});
