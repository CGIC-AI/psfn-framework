import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  deriveApiKeyPrincipalId,
  INSECURE_LOCAL_API_PRINCIPAL_ID,
} from '../http/auth.js';
import {
  appendVaryValue,
  clampHttpHeader,
  evaluateCorsPolicy,
  isLoopbackHost,
  normalizeCorsAllowedOrigins,
  resolveApiCorsAllowedOrigins,
  resolveApiRequestPrincipal,
} from './http-policy.js';

function requestWithHeaders(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('normalizeCorsAllowedOrigins', () => {
  it('normalizes exact origins and wildcard host patterns while ignoring allow-all/empty values', () => {
    const origins = normalizeCorsAllowedOrigins([
      '  https://console.example  ',
      'http://*.local:3201',
      '*',
      '',
      'https://admin.example',
    ]);
    expect(Array.from(origins.exactOrigins)).toEqual([
      'https://console.example',
      'https://admin.example',
    ]);
    expect(origins.wildcardHostPatterns).toEqual([
      {
        protocol: 'http:',
        hostnameSuffix: 'local',
        port: '3201',
      },
    ]);
  });
});

describe('resolveApiCorsAllowedOrigins', () => {
  it('derives admin host origin when explicit allowlist is empty', () => {
    const origins = resolveApiCorsAllowedOrigins({
      explicitAllowlist: [],
      adminHost: 'psfn.local',
      adminPort: 3001,
    });

    expect(origins).toEqual(['http://psfn.local:3001']);
  });

  it('merges explicit allowlist entries with derived admin origins', () => {
    const origins = resolveApiCorsAllowedOrigins({
      explicitAllowlist: [
        'https://console.example',
        'http://psfn.local:3001',
      ],
      adminHost: 'psfn.local',
      adminPort: 3001,
    });

    expect(origins).toEqual([
      'https://console.example',
      'http://psfn.local:3001',
    ]);
  });

  it('does not derive wildcard bind hosts and keeps explicit entries', () => {
    const origins = resolveApiCorsAllowedOrigins({
      explicitAllowlist: ['https://console.example', '*'],
      adminHost: '0.0.0.0',
      adminPort: 3001,
    });

    expect(origins).toEqual(['https://console.example']);
  });

  it('allows same-request-host admin origin fallback when admin host is wildcard-bound', () => {
    const corsAllowedOrigins = normalizeCorsAllowedOrigins(resolveApiCorsAllowedOrigins({
      explicitAllowlist: [],
      adminHost: '0.0.0.0',
      adminPort: 3201,
    }));
    const decision = evaluateCorsPolicy(
      requestWithHeaders({
        host: 'psfn.local.mesh:3200',
        origin: 'http://psfn.local.mesh:3201',
      }),
      corsAllowedOrigins,
      undefined,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      throw new Error('Expected same-request-host fallback CORS decision to be allowed');
    }
    expect(decision.headers?.['Access-Control-Allow-Origin']).toBe(
      'http://psfn.local.mesh:3201',
    );
  });
});

describe('isLoopbackHost', () => {
  it('accepts localhost, ::1, and 127.0.0.0/8', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.42')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });
});

describe('clampHttpHeader', () => {
  it('trims and clamps values', () => {
    expect(clampHttpHeader('   value   ', 16)).toBe('value');
    expect(clampHttpHeader('abcdef', 3)).toBe('abc');
    expect(clampHttpHeader('   ', 16)).toBeUndefined();
  });
});

describe('appendVaryValue', () => {
  it('deduplicates vary values', () => {
    expect(appendVaryValue('Accept-Encoding, Origin', 'Origin')).toBe('Accept-Encoding, Origin');
    expect(appendVaryValue(['Accept-Encoding'], 'Origin')).toBe('Accept-Encoding, Origin');
  });
});

describe('evaluateCorsPolicy', () => {
  it('allows requests without origin header', () => {
    const decision = evaluateCorsPolicy(
      requestWithHeaders({}),
      normalizeCorsAllowedOrigins(['https://console.example']),
      undefined,
    );
    expect(decision).toEqual({ ok: true });
  });

  it('denies disallowed origins', () => {
    const decision = evaluateCorsPolicy(
      requestWithHeaders({ origin: 'https://evil.example' }),
      normalizeCorsAllowedOrigins(['https://console.example']),
      undefined,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('Expected CORS decision to be denied');
    }
    expect(decision.error.status).toBe(403);
    expect(decision.error.type).toBe('cors_origin_not_allowed');
  });

  it('returns allow headers for allowlisted origins', () => {
    const decision = evaluateCorsPolicy(
      requestWithHeaders({ origin: 'https://console.example' }),
      normalizeCorsAllowedOrigins(['https://console.example']),
      'Accept-Encoding',
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      throw new Error('Expected CORS decision to be allowed');
    }
    expect(decision.headers).toBeDefined();
    expect(decision.headers?.Vary).toBe('Accept-Encoding, Origin');
    expect(decision.headers?.['Access-Control-Allow-Origin']).toBe('https://console.example');
    expect(decision.headers?.['Access-Control-Allow-Credentials']).toBe('true');
    expect(decision.headers?.['Access-Control-Allow-Methods']).toContain('POST');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-Title');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('HTTP-Referer');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-Session-ID');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-User-ID');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-User-Name');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-Channel-Privacy');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-Channel-ID');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-PSFN-Channel-Type');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-PSFN-Channel-ID');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-PSFN-Author-ID');
    expect(decision.headers?.['Access-Control-Allow-Headers']).toContain('X-PSFN-Author-Name');
  });

  it('allows wildcard LAN host preflight origins with exact scheme and port semantics', () => {
    const decision = evaluateCorsPolicy(
      requestWithHeaders({ origin: 'http://garden.local:3201' }),
      normalizeCorsAllowedOrigins(['http://*.local:3201']),
      undefined,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      throw new Error('Expected wildcard CORS decision to be allowed');
    }
    expect(decision.headers?.['Access-Control-Allow-Origin']).toBe('http://garden.local:3201');
  });

  it('denies wildcard LAN host preflight when port does not match allowlist', () => {
    const decision = evaluateCorsPolicy(
      requestWithHeaders({ origin: 'http://garden.local:3202' }),
      normalizeCorsAllowedOrigins(['http://*.local:3201']),
      undefined,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('Expected wildcard CORS decision to be denied');
    }
    expect(decision.error.type).toBe('cors_origin_not_allowed');
  });

  it('denies same-request-host fallback when origin host differs from request host', () => {
    const corsAllowedOrigins = normalizeCorsAllowedOrigins(resolveApiCorsAllowedOrigins({
      explicitAllowlist: [],
      adminHost: '0.0.0.0',
      adminPort: 3201,
    }));
    const decision = evaluateCorsPolicy(
      requestWithHeaders({
        host: 'psfn.local.mesh:3200',
        origin: 'http://evil.example:3201',
      }),
      corsAllowedOrigins,
      undefined,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('Expected mismatched same-request-host fallback CORS decision to be denied');
    }
    expect(decision.error.type).toBe('cors_origin_not_allowed');
  });
});

describe('resolveApiRequestPrincipal', () => {
  it('requires bearer auth when apiKey is configured', () => {
    const result = resolveApiRequestPrincipal(requestWithHeaders({}), {
      apiKey: 'test-secret-key',
      allowInsecureWithoutAuth: false,
      isTelemetryIngest: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected auth to fail');
    }
    expect(result.error.status).toBe(401);
    expect(result.error.type).toBe('invalid_api_key');
  });

  it('returns principal when bearer token matches configured api key', () => {
    const result = resolveApiRequestPrincipal(
      requestWithHeaders({ authorization: 'Bearer test-secret-key' }),
      {
        apiKey: 'test-secret-key',
        allowInsecureWithoutAuth: false,
        isTelemetryIngest: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected auth to pass');
    }
    expect(result.principal.mode).toBe('api_key');
    expect(result.principal.id).toBe(deriveApiKeyPrincipalId('test-secret-key'));
  });

  it('accepts alternate admin token when api key auth is configured', () => {
    const result = resolveApiRequestPrincipal(
      requestWithHeaders({ authorization: 'Bearer test-admin-token' }),
      {
        apiKey: 'test-secret-key',
        alternateApiToken: 'test-admin-token',
        allowInsecureWithoutAuth: false,
        isTelemetryIngest: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected alternate auth token to pass');
    }
    expect(result.principal.mode).toBe('api_key');
    expect(result.principal.id).toBe(deriveApiKeyPrincipalId('test-admin-token'));
  });

  it('accepts alternate admin token from auth cookie when configured', () => {
    const result = resolveApiRequestPrincipal(
      requestWithHeaders({ cookie: 'psfn_token=test-admin-token' }),
      {
        apiKey: 'test-secret-key',
        alternateApiToken: 'test-admin-token',
        alternateCookieTokenNames: ['psfn_token'],
        allowInsecureWithoutAuth: false,
        isTelemetryIngest: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected alternate auth cookie token to pass');
    }
    expect(result.principal.mode).toBe('api_key');
    expect(result.principal.id).toBe(deriveApiKeyPrincipalId('test-admin-token'));
  });

  it('denies telemetry ingestion when api auth is not configured', () => {
    const result = resolveApiRequestPrincipal(requestWithHeaders({}), {
      allowInsecureWithoutAuth: true,
      isTelemetryIngest: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected telemetry auth to fail');
    }
    expect(result.error.status).toBe(503);
    expect(result.error.type).toBe('telemetry_auth_unconfigured');
  });

  it('returns insecure local principal when explicitly enabled', () => {
    const result = resolveApiRequestPrincipal(requestWithHeaders({}), {
      allowInsecureWithoutAuth: true,
      isTelemetryIngest: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected insecure principal');
    }
    expect(result.principal.id).toBe(INSECURE_LOCAL_API_PRINCIPAL_ID);
    expect(result.principal.mode).toBe('insecure_local');
  });
});
