import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('allows notify.ntfy', () => {
    expect(evaluatePolicy({ method: 'notify.ntfy', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows web.fetch with valid HTTPS URL', () => {
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 'https://example.com' } }, policyConfig)).toBe('ALLOW');
  });

  it('allows web.fetch when no urlPolicy is configured', () => {
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 'http://example.com' } }, policyConfig)).toBe('ALLOW');
  });

  it('denies web.fetch for HTTP URL when urlPolicy disallows HTTP', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: { allowHttp: false },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'http://example.com' } },
      configWithUrlPolicy,
    )).toBe('DENY');
  });

  it('denies web.fetch for private IP', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'https://127.0.0.1/admin' } },
      configWithUrlPolicy,
    )).toBe('DENY');
  });

  it('denies web.fetch for localhost', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'https://localhost/admin' } },
      configWithUrlPolicy,
    )).toBe('DENY');
  });

  it('denies web.fetch for domain not in allowlist', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: { domainAllowlist: ['trusted.com'] },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'https://evil.com/payload' } },
      configWithUrlPolicy,
    )).toBe('DENY');
  });

  it('allows web.fetch for domain in allowlist', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: { domainAllowlist: ['trusted.com'] },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'https://trusted.com/page' } },
      configWithUrlPolicy,
    )).toBe('ALLOW');
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

  it('requires approval for module registry path by default', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/psfn/modules/repl-registry.json' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('allows module registry path when explicitly trusted', () => {
    const trustedConfig: PolicyConfig = {
      ...policyConfig,
      allowedReadPaths: [
        ...(policyConfig.allowedReadPaths ?? []),
        '/app/psfn/modules/repl-registry.json',
      ],
    };
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/psfn/modules/repl-registry.json' } },
      trustedConfig,
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

// ── Symlink traversal tests (uses real filesystem) ──

describe('evaluatePolicy symlink traversal', () => {
  const testDir = join(tmpdir(), `psfn-policy-test-${process.pid}`);
  const workspace = join(testDir, 'workspace');
  const outsideDir = join(testDir, 'outside');
  const outsideFile = join(outsideDir, 'secret.txt');
  const symlinkToOutside = join(workspace, 'escape-link');
  const symlinkDirToOutside = join(workspace, 'dir-link');
  const brokenSymlink = join(workspace, 'broken-link');
  const normalFile = join(workspace, 'normal.txt');

  const realPolicyConfig: PolicyConfig = {
    workspacePath: workspace,
  };

  beforeAll(() => {
    // Create test directory structure
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsideFile, 'secret data');
    writeFileSync(normalFile, 'normal data');

    // Symlink inside workspace pointing to file outside
    symlinkSync(outsideFile, symlinkToOutside);
    // Symlink inside workspace pointing to directory outside
    symlinkSync(outsideDir, symlinkDirToOutside);
    // Broken symlink (target doesn't exist)
    symlinkSync('/nonexistent/path/to/nowhere', brokenSymlink);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('denies fs.read on a symlink inside workspace pointing outside', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: symlinkToOutside } },
      realPolicyConfig,
    )).toBe('DENY');
  });

  it('denies fs.write on a symlink inside workspace pointing outside', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: symlinkToOutside } },
      realPolicyConfig,
    )).toBe('DENY');
  });

  it('denies fs.read via symlinked directory to outside workspace', () => {
    const pathViaSymlink = join(symlinkDirToOutside, 'secret.txt');
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: pathViaSymlink } },
      realPolicyConfig,
    )).toBe('DENY');
  });

  it('allows fs.read on a normal file inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: normalFile } },
      realPolicyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.write on a normal file inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: normalFile } },
      realPolicyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.write to a new file inside workspace (file does not exist yet)', () => {
    const newFile = join(workspace, 'new-file.txt');
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: newFile } },
      realPolicyConfig,
    )).toBe('ALLOW');
  });

  it('handles broken symlinks inside workspace (target does not exist)', () => {
    // Broken symlink: ENOENT from realpathSync → falls back to normalized path
    // Normalized path is inside workspace, so ALLOW (the actual read will fail at I/O time)
    const result = evaluatePolicy(
      { method: 'fs.read', params: { path: brokenSymlink } },
      realPolicyConfig,
    );
    expect(result).toBe('ALLOW');
  });
});
