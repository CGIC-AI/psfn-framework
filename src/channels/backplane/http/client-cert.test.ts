import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CLIENT_CERT_HEADER_NAMES,
  deriveClientCertIdentity,
  formatPeerCertificateSubject,
  parseTrustedProxyClientCertToken,
  stripClientCertHeaders,
  TRUSTED_PROXY_TOKEN_HEADER,
} from './client-cert.js';

const FINGERPRINT_COLONED = 'A1:'.repeat(31) + 'A1';
const FINGERPRINT_HEX = 'a1'.repeat(32);
const PUBKEY = Buffer.from('fake-der-spki-bytes');
const PUBKEY_SHA256 = createHash('sha256').update(PUBKEY).digest('hex');
const PROXY_TOKEN = 'proxy-shared-secret-of-32-chars!';

function fakeTlsSocket(options: {
  authorized?: boolean;
  peer?: Record<string, unknown> | null;
}) {
  return {
    encrypted: true,
    authorized: options.authorized ?? false,
    getPeerCertificate: () => options.peer ?? {},
  };
}

describe('deriveClientCertIdentity (Sprint-10 C1)', () => {
  it('derives identity from the real TLS peer certificate', () => {
    const identity = deriveClientCertIdentity({
      headers: {},
      socket: fakeTlsSocket({
        authorized: true,
        peer: {
          fingerprint256: FINGERPRINT_COLONED,
          pubkey: PUBKEY,
          subject: { CN: 'pi-voice', O: 'PSFN' },
          subjectaltname: 'DNS:pi-voice.local',
        },
      }),
    });

    expect(identity).toEqual({
      source: 'tls_peer',
      fingerprintSha256: FINGERPRINT_HEX,
      spkiSha256: PUBKEY_SHA256,
      subject: 'CN=pi-voice, O=PSFN',
      san: 'DNS:pi-voice.local',
    });
  });

  it('withholds subject/SAN when the peer chain is NOT authorized (self-signed spoof defense)', () => {
    const identity = deriveClientCertIdentity({
      headers: {},
      socket: fakeTlsSocket({
        authorized: false,
        peer: {
          fingerprint256: FINGERPRINT_COLONED,
          pubkey: PUBKEY,
          subject: { CN: 'anyone-can-self-sign-this' },
          subjectaltname: 'DNS:forged.example',
        },
      }),
    });

    expect(identity).toEqual({
      source: 'tls_peer',
      fingerprintSha256: FINGERPRINT_HEX,
      spkiSha256: PUBKEY_SHA256,
    });
  });

  it('returns undefined on a TLS socket without a peer certificate', () => {
    const identity = deriveClientCertIdentity({
      headers: { [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_HEX },
      socket: fakeTlsSocket({ peer: {} }),
    });
    expect(identity).toBeUndefined();
  });

  it('NEVER derives identity from cert headers without a configured trusted proxy', () => {
    const identity = deriveClientCertIdentity({
      headers: {
        [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_HEX,
        [CLIENT_CERT_HEADER_NAMES.subject]: 'CN=pi-voice',
        [CLIENT_CERT_HEADER_NAMES.san]: 'DNS:pi-voice.local',
      },
      socket: {},
    });
    expect(identity).toBeUndefined();
  });

  it('NEVER derives identity from cert headers when the proxy token is missing or wrong', () => {
    expect(deriveClientCertIdentity({
      headers: { [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_HEX },
      socket: {},
    }, { trustedProxyToken: PROXY_TOKEN })).toBeUndefined();

    expect(deriveClientCertIdentity({
      headers: {
        [TRUSTED_PROXY_TOKEN_HEADER]: 'wrong-token-wrong-token-wrong-tok',
        [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_HEX,
      },
      socket: {},
    }, { trustedProxyToken: PROXY_TOKEN })).toBeUndefined();
  });

  it('derives identity from cert headers only with the correct trusted-proxy token', () => {
    const identity = deriveClientCertIdentity({
      headers: {
        [TRUSTED_PROXY_TOKEN_HEADER]: PROXY_TOKEN,
        [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_COLONED,
        [CLIENT_CERT_HEADER_NAMES.subject]: 'CN=pi-voice, O=PSFN',
      },
      socket: {},
    }, { trustedProxyToken: PROXY_TOKEN });

    expect(identity).toEqual({
      source: 'trusted_proxy',
      fingerprintSha256: FINGERPRINT_HEX,
      subject: 'CN=pi-voice, O=PSFN',
    });
  });

  it('drops malformed proxy-asserted digests instead of trusting them', () => {
    const identity = deriveClientCertIdentity({
      headers: {
        [TRUSTED_PROXY_TOKEN_HEADER]: PROXY_TOKEN,
        [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: 'not-a-hex-digest',
        [CLIENT_CERT_HEADER_NAMES.subject]: 'CN=pi-voice',
      },
      socket: {},
    }, { trustedProxyToken: PROXY_TOKEN });

    expect(identity).toEqual({ source: 'trusted_proxy', subject: 'CN=pi-voice' });
  });

  it('prefers the real TLS peer certificate over proxy headers', () => {
    const identity = deriveClientCertIdentity({
      headers: {
        [TRUSTED_PROXY_TOKEN_HEADER]: PROXY_TOKEN,
        [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: 'c3'.repeat(32),
      },
      socket: fakeTlsSocket({ peer: { fingerprint256: FINGERPRINT_COLONED } }),
    }, { trustedProxyToken: PROXY_TOKEN });

    expect(identity?.source).toBe('tls_peer');
    expect(identity?.fingerprintSha256).toBe(FINGERPRINT_HEX);
  });
});

describe('stripClientCertHeaders', () => {
  it('removes all client-cert headers and the trusted-proxy token, preserving everything else', () => {
    const headers: Record<string, string | string[] | undefined> = {
      authorization: 'Bearer key',
      'x-psfn-satellite-id': 'pi-voice',
      [CLIENT_CERT_HEADER_NAMES.fingerprintSha256]: FINGERPRINT_HEX,
      [CLIENT_CERT_HEADER_NAMES.spkiSha256]: 'b2'.repeat(32),
      [CLIENT_CERT_HEADER_NAMES.subject]: 'CN=pi-voice',
      [CLIENT_CERT_HEADER_NAMES.san]: 'DNS:pi-voice.local',
      [TRUSTED_PROXY_TOKEN_HEADER]: PROXY_TOKEN,
      'X-PSFN-Client-Cert-Subject': 'CN=case-variant',
    };
    stripClientCertHeaders(headers);
    expect(headers).toEqual({
      authorization: 'Bearer key',
      'x-psfn-satellite-id': 'pi-voice',
    });
  });
});

describe('formatPeerCertificateSubject', () => {
  it('renders multi-valued attributes deterministically', () => {
    expect(formatPeerCertificateSubject({ CN: 'pi', OU: ['a', 'b'] })).toBe('CN=pi, OU=a, OU=b');
    expect(formatPeerCertificateSubject(undefined)).toBeUndefined();
    expect(formatPeerCertificateSubject({})).toBeUndefined();
  });
});

describe('parseTrustedProxyClientCertToken', () => {
  it('accepts a strong token and rejects weak ones (fail closed)', () => {
    expect(parseTrustedProxyClientCertToken(undefined)).toBeUndefined();
    expect(parseTrustedProxyClientCertToken('   ')).toBeUndefined();
    expect(parseTrustedProxyClientCertToken(PROXY_TOKEN)).toBe(PROXY_TOKEN);
    expect(() => parseTrustedProxyClientCertToken('short-token')).toThrow('at least 32');
  });
});
