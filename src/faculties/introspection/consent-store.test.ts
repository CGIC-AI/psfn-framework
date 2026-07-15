import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntrospectionConsentStore } from './consent-store.js';

describe('IntrospectionConsentStore', () => {
  let root: string;
  let path: string;
  let store: IntrospectionConsentStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'introspection-consent-'));
    path = join(root, 'state', 'introspection-consent.jsonl');
    store = new IntrospectionConsentStore(path);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts unconfigured and denied', () => {
    expect(store.load()).toEqual({
      status: 'unconfigured',
      enabled: false,
      allowedPublicChannelIds: [],
    });
  });

  it('appends companion-authored, hash-chained revisions', () => {
    const first = store.append({
      enabled: true,
      allowedPublicChannelIds: ['discord:public:one'],
      actor: { kind: 'companion', turnId: 'turn-1', requestId: 'request-1' },
      reason: 'I want bounded public-channel reflection.',
      createdAt: '2026-07-13T10:00:00.000Z',
    });
    const second = store.append({
      enabled: false,
      allowedPublicChannelIds: [],
      actor: { kind: 'companion', turnId: 'turn-2', requestId: 'request-2' },
      reason: 'I revoke consent.',
      createdAt: '2026-07-13T11:00:00.000Z',
    });

    expect(first.revision).toBe(1);
    expect(first.previousHash).toBeNull();
    expect(second.revision).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    expect(store.load()).toEqual(second);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('rejects operator-authored or ambiguous policy changes', () => {
    expect(() => store.append({
      enabled: true,
      allowedPublicChannelIds: ['public'],
      actor: { kind: 'operator' } as never,
      reason: 'operator enabled',
      createdAt: '2026-07-13T10:00:00.000Z',
    })).toThrow(/actor/);

    expect(() => store.append({
      enabled: true,
      allowedPublicChannelIds: ['public'],
      actor: { kind: 'companion', turnId: '', requestId: 'request-1' },
      reason: 'missing turn provenance',
      createdAt: '2026-07-13T10:00:00.000Z',
    })).toThrow(/turnId/);
  });

  it('requires exact channel allowlists when enabled', () => {
    expect(() => store.append({
      enabled: true,
      allowedPublicChannelIds: [],
      actor: { kind: 'companion', turnId: 'turn-1', requestId: 'request-1' },
      reason: 'too broad',
      createdAt: '2026-07-13T10:00:00.000Z',
    })).toThrow(/at least one/);

    expect(() => store.append({
      enabled: true,
      allowedPublicChannelIds: ['*'],
      actor: { kind: 'companion', turnId: 'turn-1', requestId: 'request-1' },
      reason: 'wildcard',
      createdAt: '2026-07-13T10:00:00.000Z',
    })).toThrow(/wildcard/);
  });

  it('fails closed when the ledger is malformed, truncated, or tampered', () => {
    const revision = store.append({
      enabled: true,
      allowedPublicChannelIds: ['public'],
      actor: { kind: 'companion', turnId: 'turn-1', requestId: 'request-1' },
      reason: 'valid',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    writeFileSync(path, `${JSON.stringify({ ...revision, enabled: false })}\n`, 'utf8');
    expect(() => store.load()).toThrow(/hash/);

    writeFileSync(path, JSON.stringify(revision), 'utf8');
    expect(() => store.load()).toThrow(/newline/);

    writeFileSync(path, '{bad json}\n', 'utf8');
    expect(() => store.load()).toThrow(/line 1/);
  });
});
