import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function render(overrides: Record<string, unknown> = {}) {
  return spawnSync('helm', ['template', 'garden-security', 'deploy/helm/psfn', '--values', '-'], {
    encoding: 'utf8', input: JSON.stringify(overrides),
  });
}

const proxy = { publicOrigin: 'https://garden.example.test', trustedProxyAddresses: ['192.0.2.0/24'] };

describe('standalone Garden chart browser transport', () => {
  it('refuses the standalone non-loopback deployment without an explicit HTTPS proxy contract', () => {
    const result = render();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gardenBrowser');
  });

  it('renders explicit external TLS proxy wiring without changing fleet mTLS settings', () => {
    const result = render({ gardenBrowser: proxy });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('name: ADMIN_PUBLIC_ORIGIN');
    expect(result.stdout).toContain('value: "https://garden.example.test"');
    expect(result.stdout).toContain('name: ADMIN_TRUSTED_PROXY_ADDRESSES');
    expect(result.stdout).toContain('value: "192.0.2.0/24"');
    expect(result.stdout).toContain('ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI');
  });

  it.each([0, 2])('refuses %i standalone replicas because browser authority is process-local', replicaCount => {
    const result = render({ gardenBrowser: proxy, workloads: { garden: { replicaCount } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('standalone Garden requires workloads.garden.replicaCount=1');
    expect(result.stderr).toContain('process-local');
  });

  it('preserves the fleet single-replica guard independently of standalone browser policy', () => {
    const result = render({
      fleet: { enabled: true }, fleetAuth: { enabled: true },
      bootstrap: { seedOwnerFiles: false }, workloads: { garden: { replicaCount: 2 } },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fleet.enabled=true requires workloads.garden.replicaCount=1');
  });

  it('requires actual ingress TLS and an exact public host match', () => {
    const missing = render({ gardenBrowser: proxy, ingress: { enabled: true, garden: { enabled: true } } });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('ingress.garden.tls');
    const mismatch = render({ gardenBrowser: proxy, ingress: { enabled: true, garden: {
      enabled: true, host: 'sibling.example.test', tls: { enabled: true, secretName: 'example-garden-tls' },
    } } });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('exactly match');
    const valid = render({ gardenBrowser: proxy, ingress: { enabled: true, garden: {
      enabled: true, host: 'garden.example.test', tls: { enabled: true, secretName: 'example-garden-tls' },
    } } });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toContain('secretName: "example-garden-tls"');
  });

  it.each(['0.0.0.0/0', '::/0', '*', 'proxy.example.test'])('rejects unbounded or non-IP proxy source %s', source => {
    const result = render({ gardenBrowser: { ...proxy, trustedProxyAddresses: [source] } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gardenBrowser');
  });
});
