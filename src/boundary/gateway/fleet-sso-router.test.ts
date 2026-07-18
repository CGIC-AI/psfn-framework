import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { resolveFleetSsoBrowserOrigin } from './fleet-sso-router.js';
import { resolveFleetSsoGardenUpstreams } from '../fleet-auth/fleet-sso-transport.js';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';

function request(headers: IncomingMessage['headers'], encrypted = false): Pick<IncomingMessage, 'headers' | 'socket'> {
  return {
    headers,
    socket: { encrypted } as IncomingMessage['socket'],
  };
}

describe('unified Fleet SSO origin provenance', () => {
  const canonicalOrigin = 'https://fleet.example.test';

  it('accepts only the exact direct TLS Host without forwarded metadata', () => {
    expect(resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toBe(canonicalOrigin);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'fleet.example.test', 'x-forwarded-proto': 'https' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/Forwarded origin metadata is forbidden/u);
    expect(() => resolveFleetSsoBrowserOrigin(
      request({ host: 'attacker.example.test' }, true),
      { canonicalOrigin, trustProxy: false },
    )).toThrow(/provenance is invalid/u);
  });

  it('accepts one explicit HTTPS proxy shape and rejects spoofed/mixed variants', () => {
    const exactHeaders = {
      host: 'fleet.example.test',
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    expect(resolveFleetSsoBrowserOrigin(
      request(exactHeaders),
      { canonicalOrigin, trustProxy: true },
    )).toBe(canonicalOrigin);
    for (const headers of [
      { ...exactHeaders, 'x-forwarded-host': 'attacker.example.test' },
      { ...exactHeaders, 'x-forwarded-proto': 'http' },
      { ...exactHeaders, 'x-forwarded-for': '198.51.100.9, 203.0.113.8' },
      { ...exactHeaders, forwarded: 'host=attacker.example.test;proto=https' },
    ]) {
      expect(() => resolveFleetSsoBrowserOrigin(
        request(headers),
        { canonicalOrigin, trustProxy: true },
      )).toThrow();
    }
  });

  it('derives one exact loopback Garden for a single-companion deployment', () => {
    expect(resolveFleetSsoGardenUpstreams({
      companionId: '11111111-1111-4111-8111-111111111111',
      fleetGardenPort: 3001,
      env: {},
    })).toMatchObject([{
      companionId: '11111111-1111-4111-8111-111111111111',
      origin: new URL('http://127.0.0.1:3001'),
    }]);
    expect(() => resolveFleetSsoGardenUpstreams({
      companionId: 'not-a-companion-id',
      fleetGardenPort: 3001,
      env: {},
    })).toThrow(/RFC4122 UUID/u);
  });

  it('maps every fleet companion to the one fleet Garden listener', () => {
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const fleet = {
      companions: [{ companionId: companionA }, { companionId: companionB }],
    } as unknown as ResolvedCompanionsFleetConfig;

    expect(resolveFleetSsoGardenUpstreams({
      fleet,
      fleetGardenPort: 3001,
      env: {},
    })).toMatchObject([
      { companionId: companionA, origin: new URL('http://127.0.0.1:3001') },
      { companionId: companionB, origin: new URL('http://127.0.0.1:3001') },
    ]);
    expect(() => resolveFleetSsoGardenUpstreams({ fleet, env: {} }))
      .toThrow(/requires the fleet Garden listener port/u);
  });
});
