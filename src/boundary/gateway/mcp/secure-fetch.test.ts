import { describe, expect, it, vi } from 'vitest';
import type { DnsResolver } from '../url-policy.js';
import { createMcpSecureFetchController } from './secure-fetch.js';

function resolver(address: string, family = 4): DnsResolver {
  return vi.fn(async () => ({ address, family }));
}

describe('MCP secure fetch', () => {
  it('pins an allowlisted HTTPS target, disables redirects, and attaches a bounded dispatcher', async () => {
    const networkFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const controller = createMcpSecureFetchController({
      targets: [{ url: 'https://mcp.example.com/mcp', allowInternalNetwork: false }],
      dnsResolver: resolver('93.184.216.34'),
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      networkFetch,
    });

    await expect(controller.fetch('https://mcp.example.com/mcp', { method: 'POST' }))
      .resolves.toMatchObject({ status: 200 });
    expect(networkFetch).toHaveBeenCalledWith(
      'https://mcp.example.com/mcp',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        dispatcher: expect.anything(),
      }),
    );
    await controller.close();
  });

  it('rejects URLs outside the exact configured endpoint and always-blocked DNS answers', async () => {
    const networkFetch = vi.fn(async () => new Response('{}'));
    const controller = createMcpSecureFetchController({
      targets: [{ url: 'https://mcp.example.com/mcp', allowInternalNetwork: false }],
      dnsResolver: resolver('169.254.169.254'),
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      networkFetch,
    });

    await expect(controller.fetch('https://evil.example/mcp')).rejects.toThrow(/not allowlisted/);
    await expect(controller.fetch('https://mcp.example.com/mcp')).rejects.toThrow(/blocked IP/);
    expect(networkFetch).not.toHaveBeenCalled();
    await controller.close();
  });

  it('allows configured loopback TLS while still rejecting link-local metadata targets', async () => {
    const networkFetch = vi.fn(async () => new Response('{}'));
    const controller = createMcpSecureFetchController({
      targets: [
        { url: 'https://localhost:8443/mcp', allowInternalNetwork: true },
        { url: 'https://metadata.local/token', allowInternalNetwork: true },
      ],
      dnsResolver: async (hostname) => hostname === 'localhost'
        ? { address: '127.0.0.1', family: 4 }
        : { address: '169.254.169.254', family: 4 },
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      networkFetch,
    });

    await expect(controller.fetch('https://localhost:8443/mcp')).resolves.toBeInstanceOf(Response);
    await expect(controller.fetch('https://metadata.local/token')).rejects.toThrow(/blocked IP/);
    await controller.close();
  });

  it('refuses use after close', async () => {
    const controller = createMcpSecureFetchController({
      targets: [{ url: 'https://mcp.example.com/mcp', allowInternalNetwork: false }],
      dnsResolver: resolver('93.184.216.34'),
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      networkFetch: vi.fn(async () => new Response('{}')),
    });
    await controller.close();

    await expect(controller.fetch('https://mcp.example.com/mcp')).rejects.toThrow(/closed/);
  });
});
