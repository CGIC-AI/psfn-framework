import { describe, expect, it } from 'vitest';
import {
  CANARY_CARRIER_PARAM_KEY,
  SessionCanaryRegistry,
  generateCanaryToken,
  getActiveCanaryToken,
  hashCanaryToken,
  renderCanaryPromptMarker,
  runWithCanaryContext,
} from './canary-token.js';

describe('canary token generation', () => {
  it('mints a distinctive, unguessable, unique token each call', () => {
    const a = generateCanaryToken();
    const b = generateCanaryToken();
    expect(a).toMatch(/^cnry_[A-Z2-7]{16}$/u);
    expect(b).toMatch(/^cnry_[A-Z2-7]{16}$/u);
    expect(a).not.toBe(b);
  });

  it('hashes a token as a sha256 digest and never leaks the raw token', () => {
    const token = generateCanaryToken();
    const hash = hashCanaryToken(token);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(hash).not.toContain(token);
    // Deterministic.
    expect(hashCanaryToken(token)).toBe(hash);
  });

  it('renders an inert marker that carries the token but instructs nothing', () => {
    const token = 'cnry_ABCDEFGHIJKLMNOP';
    const marker = renderCanaryPromptMarker(token);
    expect(marker).toContain(token);
    expect(marker.toLowerCase()).toContain('internal marker');
    // Single line — never introduces newlines into the prompt plan block.
    expect(marker).not.toContain('\n');
  });
});

describe('SessionCanaryRegistry', () => {
  it('mints one stable token per session and returns it on repeat', () => {
    const registry = new SessionCanaryRegistry();
    const first = registry.ensure('session-a');
    const again = registry.ensure('session-a');
    expect(again).toBe(first);
    expect(registry.get('session-a')).toBe(first);
  });

  it('isolates tokens across sessions (token A never equals token B)', () => {
    const registry = new SessionCanaryRegistry();
    const a = registry.ensure('session-a');
    const b = registry.ensure('session-b');
    expect(a).not.toBe(b);
  });

  it('rotates on reset so a leaked token has no replay value', () => {
    const registry = new SessionCanaryRegistry();
    const before = registry.ensure('session-a');
    registry.reset('session-a');
    const after = registry.ensure('session-a');
    expect(after).not.toBe(before);
  });
});

describe('canary async context', () => {
  it('exposes the active token only inside the run scope', async () => {
    expect(getActiveCanaryToken()).toBeUndefined();
    const token = generateCanaryToken();
    const seen = await runWithCanaryContext(token, async () => getActiveCanaryToken());
    expect(seen).toBe(token);
    expect(getActiveCanaryToken()).toBeUndefined();
  });
});

describe('carrier key', () => {
  it('is a reserved, non-colliding param key', () => {
    expect(CANARY_CARRIER_PARAM_KEY).toBe('__cogsecCanary');
  });
});
