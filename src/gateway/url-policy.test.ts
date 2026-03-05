import { describe, it, expect } from 'vitest';
import { evaluateUrlPolicy, isPrivateIP, isAlwaysBlockedIP, checkResolvedIP, type DnsResolver } from './url-policy.js';

describe('isPrivateIP', () => {
  it('detects IPv4 loopback', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects RFC1918 Class A (10.x)', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects RFC1918 Class B (172.16-31.x)', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
  });

  it('does not flag 172.15.x or 172.32.x', () => {
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects RFC1918 Class C (192.168.x)', () => {
    expect(isPrivateIP('192.168.1.1')).toBe(true);
    expect(isPrivateIP('192.168.0.0')).toBe(true);
  });

  it('detects link-local / cloud metadata (169.254.x)', () => {
    expect(isPrivateIP('169.254.169.254')).toBe(true);
  });

  it('detects "this" network (0.x)', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('detects IPv6 loopback', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('detects IPv6 link-local', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('detects IPv6 unique local', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456::1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 (::ffff:127.0.0.1)', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
  });

  it('blocks hex-form IPv4-mapped IPv6 (::ffff:7f00:1) conservatively', () => {
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIP('::FFFF:a9fe:a9fe')).toBe(true); // 169.254.169.254 in hex
  });

  it('allows public IPv4-mapped IPv6', () => {
    expect(isPrivateIP('::ffff:93.184.216.34')).toBe(false);
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
    expect(isPrivateIP('2606:4700::1')).toBe(false);
  });
});

describe('isAlwaysBlockedIP', () => {
  it('blocks cloud metadata IP (169.254.x)', () => {
    expect(isAlwaysBlockedIP('169.254.169.254')).toBe(true);
    expect(isAlwaysBlockedIP('169.254.0.1')).toBe(true);
  });

  it('blocks "this" network (0.x)', () => {
    expect(isAlwaysBlockedIP('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 link-local', () => {
    expect(isAlwaysBlockedIP('fe80::1')).toBe(true);
  });

  it('blocks IPv4-mapped cloud metadata', () => {
    expect(isAlwaysBlockedIP('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows RFC1918 ranges (these are permitted for internal network)', () => {
    expect(isAlwaysBlockedIP('10.0.0.1')).toBe(false);
    expect(isAlwaysBlockedIP('172.16.0.1')).toBe(false);
    expect(isAlwaysBlockedIP('192.168.1.1')).toBe(false);
    expect(isAlwaysBlockedIP('127.0.0.1')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isAlwaysBlockedIP('8.8.8.8')).toBe(false);
    expect(isAlwaysBlockedIP('93.184.216.34')).toBe(false);
  });
});

describe('evaluateUrlPolicy', () => {
  // ── Blocked: private IPs ──

  it('blocks localhost by name', () => {
    const result = evaluateUrlPolicy('https://localhost/path');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('localhost');
  });

  it('blocks localhost.localdomain', () => {
    const result = evaluateUrlPolicy('https://localhost.localdomain/path');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('localhost');
  });

  it('blocks subdomain.localhost', () => {
    const result = evaluateUrlPolicy('https://foo.localhost/path');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('localhost');
  });

  it('blocks 127.0.0.1', () => {
    const result = evaluateUrlPolicy('https://127.0.0.1/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  it('blocks ::1 (IPv6 loopback)', () => {
    const result = evaluateUrlPolicy('https://[::1]/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  it('blocks 10.0.0.1 (RFC1918)', () => {
    const result = evaluateUrlPolicy('https://10.0.0.1/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  it('blocks 172.16.0.1 (RFC1918)', () => {
    const result = evaluateUrlPolicy('https://172.16.0.1/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  it('blocks 192.168.1.1 (RFC1918)', () => {
    const result = evaluateUrlPolicy('https://192.168.1.1/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  it('blocks 169.254.169.254 (cloud metadata)', () => {
    const result = evaluateUrlPolicy('https://169.254.169.254/latest/meta-data/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Private IP');
  });

  // ── Blocked: protocol ──

  it('blocks HTTP by default', () => {
    const result = evaluateUrlPolicy('http://example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('HTTP not allowed');
  });

  it('allows HTTP when config permits', () => {
    const result = evaluateUrlPolicy('http://example.com', { allowHttp: true });
    expect(result.allowed).toBe(true);
  });

  it('blocks file:// protocol', () => {
    const result = evaluateUrlPolicy('file:///etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Protocol file:');
  });

  it('blocks ftp:// protocol', () => {
    const result = evaluateUrlPolicy('ftp://example.com/data');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Protocol ftp:');
  });

  it('blocks javascript: protocol', () => {
    // URL constructor parses javascript: as a valid protocol
    const result = evaluateUrlPolicy('javascript:alert(1)');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  // ── Blocked: invalid ──

  it('blocks invalid URL', () => {
    const result = evaluateUrlPolicy('not-a-url');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Invalid URL');
  });

  it('blocks empty string', () => {
    const result = evaluateUrlPolicy('');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Invalid URL');
  });

  // ── Allowed ──

  it('allows https://example.com', () => {
    const result = evaluateUrlPolicy('https://example.com');
    expect(result.allowed).toBe(true);
  });

  it('allows https with path', () => {
    const result = evaluateUrlPolicy('https://docs.github.com/en/rest/overview');
    expect(result.allowed).toBe(true);
  });

  it('allows public IP over HTTPS', () => {
    const result = evaluateUrlPolicy('https://8.8.8.8/');
    expect(result.allowed).toBe(true);
  });

  // ── Domain allowlist ──

  it('restricts to allowlisted domains', () => {
    const config = { domainAllowlist: ['example.com', 'docs.github.com'] };

    expect(evaluateUrlPolicy('https://example.com/page', config).allowed).toBe(true);
    expect(evaluateUrlPolicy('https://docs.github.com/en', config).allowed).toBe(true);
    expect(evaluateUrlPolicy('https://evil.com/page', config).allowed).toBe(false);
  });

  it('allows subdomains of allowlisted domains', () => {
    const config = { domainAllowlist: ['github.com'] };
    expect(evaluateUrlPolicy('https://api.github.com/repos', config).allowed).toBe(true);
  });

  it('rejects partial domain matches', () => {
    const config = { domainAllowlist: ['hub.com'] };
    // "github.com" ends with "hub.com" but not ".hub.com" — should not match
    expect(evaluateUrlPolicy('https://github.com/', config).allowed).toBe(false);
  });

  it('allowlist is case-insensitive', () => {
    const config = { domainAllowlist: ['Example.COM'] };
    expect(evaluateUrlPolicy('https://example.com/', config).allowed).toBe(true);
  });

  // ── allowInternalNetwork ──

  describe('allowInternalNetwork', () => {
    const internalConfig = { allowInternalNetwork: true, allowHttp: true };

    it('allows RFC1918 Class A (10.x) when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://10.0.0.1/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows RFC1918 Class B (172.16.x) when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://172.16.0.1/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows RFC1918 Class C (192.168.x) when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://192.168.1.1/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows loopback (127.0.0.1) when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://127.0.0.1/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows localhost by name when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://localhost:8443/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows localhost.localdomain when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://localhost.localdomain/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows internal domain names when internal network enabled', () => {
      const result = evaluateUrlPolicy('https://ollama.local.example.com:11434/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('allows HTTP to internal hosts when both flags set', () => {
      const result = evaluateUrlPolicy('http://192.168.1.100:8080/', internalConfig);
      expect(result.allowed).toBe(true);
    });

    it('still blocks HTTP when allowHttp is false', () => {
      const result = evaluateUrlPolicy('http://192.168.1.1/', { allowInternalNetwork: true });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('HTTP not allowed');
    });

    it('still blocks cloud metadata IP (169.254.x) even with internal network', () => {
      const result = evaluateUrlPolicy('https://169.254.169.254/latest/meta-data/', internalConfig);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cloud metadata');
    });

    it('still blocks 0.0.0.0 even with internal network', () => {
      const result = evaluateUrlPolicy('https://0.0.0.0/', internalConfig);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cloud metadata');
    });

    it('still blocks link-local IPv6 (fe80::) even with internal network', () => {
      const result = evaluateUrlPolicy('https://[fe80::1]/', internalConfig);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cloud metadata');
    });

    it('respects domain allowlist when internal network enabled', () => {
      const config = {
        allowInternalNetwork: true,
        allowHttp: true,
        domainAllowlist: ['local.example.com'],
      };
      // Allowlisted domain on internal network should work
      expect(evaluateUrlPolicy('http://ollama.local.example.com:11434/', config).allowed).toBe(true);
      // Non-allowlisted domain should be blocked
      expect(evaluateUrlPolicy('http://evil.com/', config).allowed).toBe(false);
    });

    it('allows public IPs alongside internal when enabled', () => {
      const result = evaluateUrlPolicy('https://8.8.8.8/', internalConfig);
      expect(result.allowed).toBe(true);
    });
  });

  describe('local crawler lane', () => {
    it('is disabled by default', () => {
      const result = evaluateUrlPolicy(
        'https://localhost:8443/fetch',
        {},
        'local_crawler',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not enabled');
    });

    it('requires host/domain allowlist when enabled', () => {
      const result = evaluateUrlPolicy(
        'https://localhost:8443/fetch',
        {
          localCrawlerLane: {
            enabled: true,
          },
        },
        'local_crawler',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('requires host or domain allowlist');
    });

    it('allows localhost and private IP when explicitly allowlisted', () => {
      const localhostResult = evaluateUrlPolicy(
        'https://localhost:8443/fetch',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['localhost', '127.0.0.1'],
          },
        },
        'local_crawler',
      );
      expect(localhostResult.allowed).toBe(true);

      const privateIpResult = evaluateUrlPolicy(
        'https://127.0.0.1:8443/fetch',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['localhost', '127.0.0.1'],
          },
        },
        'local_crawler',
      );
      expect(privateIpResult.allowed).toBe(true);
    });

    it('still blocks always-blocked metadata IP when explicitly allowlisted', () => {
      const result = evaluateUrlPolicy(
        'https://169.254.169.254/latest/meta-data/',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['169.254.169.254'],
          },
        },
        'local_crawler',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cloud metadata');
    });

    it('denies local crawler host outside allowlist', () => {
      const result = evaluateUrlPolicy(
        'https://crawler.internal/fetch',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['localhost'],
          },
        },
        'local_crawler',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not allowlisted');
    });

    it('respects per-lane HTTP toggle', () => {
      const denied = evaluateUrlPolicy(
        'http://localhost:8080/fetch',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['localhost'],
            allowHttp: false,
          },
        },
        'local_crawler',
      );
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain('HTTP not allowed');

      const allowed = evaluateUrlPolicy(
        'http://localhost:8080/fetch',
        {
          localCrawlerLane: {
            enabled: true,
            hostAllowlist: ['localhost'],
            allowHttp: true,
          },
        },
        'local_crawler',
      );
      expect(allowed.allowed).toBe(true);
    });
  });
});

describe('checkResolvedIP', () => {
  // Helper: create a fake DNS resolver that returns a specific IP
  const fakeResolver = (address: string): DnsResolver =>
    async () => ({ address, family: address.includes(':') ? 6 : 4 });

  // Helper: create a fake DNS resolver that rejects
  const failingResolver: DnsResolver =
    async () => { throw new Error('ENOTFOUND'); };

  it('allows raw public IPs', async () => {
    const result = await checkResolvedIP('8.8.8.8');
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('8.8.8.8');
  });

  it('allows raw bracketed public IPv6 IPs', async () => {
    const result = await checkResolvedIP('[2606:4700::1]');
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('2606:4700::1');
  });

  it('blocks raw always-blocked metadata IP even when private resolution is allowed', async () => {
    const result = await checkResolvedIP('169.254.169.254', fakeResolver('93.184.216.34'), {
      allowPrivateResolvedIp: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });

  it('blocks hostname resolving to private IP', async () => {
    const result = await checkResolvedIP('evil.example.com', fakeResolver('127.0.0.1'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private IP');
    expect(result.reason).toContain('127.0.0.1');
  });

  it('blocks hostname resolving to cloud metadata IP', async () => {
    const result = await checkResolvedIP('metadata.evil.com', fakeResolver('169.254.169.254'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });

  it('blocks hostname resolving to RFC1918 IP', async () => {
    const result = await checkResolvedIP('internal.evil.com', fakeResolver('10.0.0.1'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private IP');
  });

  it('allows hostname resolving to public IP', async () => {
    const result = await checkResolvedIP('example.com', fakeResolver('93.184.216.34'));
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('93.184.216.34');
  });

  it('blocks on DNS resolution failure', async () => {
    const result = await checkResolvedIP('nonexistent.invalid', failingResolver);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DNS resolution failed');
  });

  it('blocks hostname resolving to IPv4-mapped IPv6', async () => {
    const result = await checkResolvedIP('evil.com', fakeResolver('::ffff:127.0.0.1'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private IP');
  });

  it('blocks hostname resolving to IPv4-mapped metadata IP', async () => {
    const result = await checkResolvedIP('meta.evil.com', fakeResolver('::ffff:169.254.169.254'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });

  it('blocks hostname resolving to hex-form IPv4-mapped metadata IP', async () => {
    const result = await checkResolvedIP('metahex.evil.com', fakeResolver('::ffff:a9fe:a9fe'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });

  it('allows private DNS resolution when explicitly requested', async () => {
    const result = await checkResolvedIP(
      'crawler.local',
      fakeResolver('127.0.0.1'),
      { allowPrivateResolvedIp: true },
    );
    expect(result.allowed).toBe(true);
  });

  it('still blocks metadata DNS resolution when private resolution is enabled', async () => {
    const result = await checkResolvedIP(
      'metadata.internal',
      fakeResolver('169.254.169.254'),
      { allowPrivateResolvedIp: true },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });
});
