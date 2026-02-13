import { describe, it, expect } from 'vitest';
import { evaluatePolicy, type PolicyConfig } from './server.js';

const policyConfig: PolicyConfig = {
  workspacePath: '/app/workspace',
  allowedReadPaths: ['/app/identity'],
};

describe('evaluatePolicy', () => {
  // ── Auto-allow methods ──

  it('allows llm.chat', () => {
    expect(evaluatePolicy({ method: 'llm.chat', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows llm.complete', () => {
    expect(evaluatePolicy({ method: 'llm.complete', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows llm.embed', () => {
    expect(evaluatePolicy({ method: 'llm.embed', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows discord.send', () => {
    expect(evaluatePolicy({ method: 'discord.send', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows web.fetch', () => {
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 'https://example.com' } }, policyConfig)).toBe('ALLOW');
  });

  // ── Filesystem: workspace paths ──

  it('allows fs.read inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/workspace/modules/test.ts' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.write inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/workspace/notes.txt' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.read of workspace root', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/workspace' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  // ── Filesystem: outside workspace ──

  it('requires approval for fs.read outside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/etc/passwd' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('requires approval for fs.write outside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/tmp/evil.sh' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('blocks path traversal attempts', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/workspace/../../../etc/passwd' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  // ── Allowed read paths ──

  it('allows fs.read on explicitly allowed paths', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/identity/character.json' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('does not allow fs.write on allowed read paths', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/identity/character.json' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  // ── Unknown methods ──

  it('denies unknown methods', () => {
    expect(evaluatePolicy(
      { method: 'exec.shell', params: { cmd: 'rm -rf /' } },
      policyConfig,
    )).toBe('DENY');
  });
});
