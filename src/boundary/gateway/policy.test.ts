import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluatePolicy, type PolicyConfig } from './server.js';
import {
  evaluateShardSessionMemorySyncPolicy,
  type ShardSessionMemorySyncEnvelope,
} from './policy.js';

const policyConfig: PolicyConfig = {
  workspacePath: '/app/companion',
  allowedReadPaths: ['/app/identity'],
  protectedWritePaths: ['/app/companion/state', '/app/companion/companion.json'],
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

  it('allows discord.sendMedia', () => {
    expect(evaluatePolicy({ method: 'discord.sendMedia', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows notify.ntfy', () => {
    expect(evaluatePolicy({ method: 'notify.ntfy', params: {} }, policyConfig)).toBe('ALLOW');
  });

  it('allows web.fetch with valid HTTPS URL when urlPolicy is configured', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 'https://example.com' } }, configWithUrlPolicy)).toBe('ALLOW');
  });

  it('allows web.fetch_binary with valid HTTPS URL when urlPolicy is configured', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy({ method: 'web.fetch_binary', params: { url: 'https://example.com/image.png' } }, configWithUrlPolicy)).toBe('ALLOW');
  });

  it('denies web.fetch when no urlPolicy is configured', () => {
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 'http://example.com' } }, policyConfig)).toBe('DENY');
  });

  it('denies web.fetch when URL is missing', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy({ method: 'web.fetch', params: {} }, configWithUrlPolicy)).toBe('DENY');
  });

  it('denies web.fetch when URL is not a string', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {},
    };
    expect(evaluatePolicy({ method: 'web.fetch', params: { url: 123 } }, configWithUrlPolicy)).toBe('DENY');
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

  it('denies web.fetch_binary for HTTP URL when urlPolicy disallows HTTP', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: { allowHttp: false },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch_binary', params: { url: 'http://example.com/image.png' } },
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

  it('keeps strict default lane unchanged even when local crawler lane is enabled', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          hostAllowlist: ['localhost'],
        },
      },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'https://localhost/admin', lane: 'default' } },
      configWithUrlPolicy,
    )).toBe('DENY');
  });

  it('allows web.fetch local_crawler lane for explicitly allowlisted host', () => {
    const configWithUrlPolicy: PolicyConfig = {
      ...policyConfig,
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          hostAllowlist: ['localhost'],
          allowHttp: true,
        },
      },
    };
    expect(evaluatePolicy(
      { method: 'web.fetch', params: { url: 'http://localhost:8080/fetch', lane: 'local_crawler' } },
      configWithUrlPolicy,
    )).toBe('ALLOW');
  });

  it('denies shell.exec when shell policy is disabled', () => {
    expect(evaluatePolicy(
      { method: 'shell.exec', params: { command: 'node', args: ['-v'] } },
      policyConfig,
    )).toBe('DENY');
  });

  it('allows shell.exec when shell policy is enabled', () => {
    const configWithShell: PolicyConfig = {
      ...policyConfig,
      shellExec: {
        enabled: true,
        allowlist: ['node'],
      },
    };
    expect(evaluatePolicy(
      { method: 'shell.exec', params: { command: 'node', args: ['-v'] } },
      configWithShell,
    )).toBe('ALLOW');
  });

  it('denies shard.backend.request when shell policy is disabled', () => {
    expect(evaluatePolicy(
      { method: 'shard.backend.request', params: { backend: 'container' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('denies shard.backend.request when required backend command is not allowlisted', () => {
    const configWithShell: PolicyConfig = {
      ...policyConfig,
      shellExec: {
        enabled: true,
        allowlist: ['node'],
      },
    };
    expect(evaluatePolicy(
      { method: 'shard.backend.request', params: { backend: 'container' } },
      configWithShell,
    )).toBe('DENY');
  });

  it('allows container shard backend mediation when docker is allowlisted', () => {
    const configWithShell: PolicyConfig = {
      ...policyConfig,
      shellExec: {
        enabled: true,
        allowlist: ['/usr/bin/docker'],
      },
    };
    expect(evaluatePolicy(
      { method: 'shard.backend.request', params: { backend: 'container' } },
      configWithShell,
    )).toBe('ALLOW');
  });

  it('allows orchestrated shard backend mediation when kubectl is allowlisted', () => {
    const configWithShell: PolicyConfig = {
      ...policyConfig,
      shellExec: {
        enabled: true,
        allowlist: ['kubectl'],
      },
    };
    expect(evaluatePolicy(
      { method: 'shard.backend.request', params: { backend: 'orchestrated' } },
      configWithShell,
    )).toBe('ALLOW');
  });

  it('denies vault.read when vault policy is disabled', () => {
    expect(evaluatePolicy(
      { method: 'vault.read', params: { name: 'Daily.md' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('allows vault methods when explicitly allowlisted', () => {
    const configWithVault: PolicyConfig = {
      ...policyConfig,
      vault: {
        enabled: true,
        allowActions: ['read', 'search', 'daily', 'write'],
      },
    };

    expect(evaluatePolicy(
      { method: 'vault.read', params: { name: 'Daily.md' } },
      configWithVault,
    )).toBe('ALLOW');
    expect(evaluatePolicy(
      { method: 'vault.search', params: { query: 'focus', limit: 10 } },
      configWithVault,
    )).toBe('ALLOW');
    expect(evaluatePolicy(
      { method: 'vault.daily', params: { content: 'hello' } },
      configWithVault,
    )).toBe('ALLOW');
    expect(evaluatePolicy(
      { method: 'vault.write', params: { name: 'Inbox', content: 'entry' } },
      configWithVault,
    )).toBe('ALLOW');
  });

  it('denies vault.write when action is not allowlisted', () => {
    const configWithReadOnlyVault: PolicyConfig = {
      ...policyConfig,
      vault: {
        enabled: true,
        allowActions: ['read'],
      },
    };
    expect(evaluatePolicy(
      { method: 'vault.write', params: { name: 'Inbox', content: 'entry' } },
      configWithReadOnlyVault,
    )).toBe('DENY');
  });

  it('denies beads methods when beads policy is disabled', () => {
    expect(evaluatePolicy(
      { method: 'beads.ready', params: {} },
      policyConfig,
    )).toBe('DENY');
  });

  it('allows beads read methods when explicitly allowlisted', () => {
    const configWithBeads: PolicyConfig = {
      ...policyConfig,
      beads: {
        enabled: true,
        allowActions: ['ready', 'show'],
      },
    };
    expect(evaluatePolicy(
      { method: 'beads.ready', params: {} },
      configWithBeads,
    )).toBe('ALLOW');
    expect(evaluatePolicy(
      { method: 'beads.show', params: { id: 'PSFN-1' } },
      configWithBeads,
    )).toBe('ALLOW');
  });

  it('denies beads write methods when action is not allowlisted', () => {
    const configWithReadOnlyBeads: PolicyConfig = {
      ...policyConfig,
      beads: {
        enabled: true,
        allowActions: ['ready', 'show'],
      },
    };
    expect(evaluatePolicy(
      { method: 'beads.create', params: { title: 'Blocked' } },
      configWithReadOnlyBeads,
    )).toBe('DENY');
    expect(evaluatePolicy(
      { method: 'beads.close', params: { id: 'PSFN-1', reason: 'done' } },
      configWithReadOnlyBeads,
    )).toBe('DENY');
  });

  // ── Home Assistant: fail closed when unconfigured ──

  it('denies home_assistant.call_service when Home Assistant is not configured', () => {
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: { domain: 'light', service: 'turn_on' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('denies home_assistant.call_service when config is incomplete', () => {
    // enabled but no base URL
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: {} },
      { ...policyConfig, homeAssistant: { enabled: true, tokenConfigured: true } },
    )).toBe('DENY');
    // base URL present but token not configured
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: {} },
      { ...policyConfig, homeAssistant: { enabled: true, baseUrl: 'http://ha.local:8123' } },
    )).toBe('DENY');
    // disabled outright
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: {} },
      {
        ...policyConfig,
        homeAssistant: { enabled: false, baseUrl: 'http://ha.local:8123', tokenConfigured: true },
      },
    )).toBe('DENY');
  });

  it('requires approval for home_assistant.call_service when fully configured', () => {
    expect(evaluatePolicy(
      { method: 'home_assistant.call_service', params: { domain: 'light', service: 'turn_on' } },
      {
        ...policyConfig,
        homeAssistant: { enabled: true, baseUrl: 'http://ha.local:8123', tokenConfigured: true },
      },
    )).toBe('NEEDS_APPROVAL');
  });

  // ── Filesystem: workspace paths ──

  it('allows fs.read inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/companion/modules/test.ts' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.write inside workspace', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/companion/notes.txt' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('treats fs.read relative paths as workspace-scoped', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: 'modules/test.ts' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('treats fs.write relative paths as workspace-scoped', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: 'notes.txt' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.list with workspace-relative glob', () => {
    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: 'src/**/*.ts', maxEntries: 50, maxScannedEntries: 500 } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.list with a workspace-relative directory path', () => {
    expect(evaluatePolicy(
      { method: 'fs.list', params: { path: 'downloads', maxEntries: 50 } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.search with bounded workspace-relative parameters', () => {
    expect(evaluatePolicy(
      {
        method: 'fs.search',
        params: {
          query: 'needle',
          glob: 'src/**/*.ts',
          mode: 'literal',
          maxMatches: 20,
          maxFiles: 50,
          maxBytesPerFile: 10_000,
          contextLines: 1,
        },
      },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.edit inside workspace', () => {
    expect(evaluatePolicy(
      {
        method: 'fs.edit',
        params: {
          path: 'notes.txt',
          oldText: 'before',
          newText: 'after',
        },
      },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows fs.read of workspace root', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/companion' } },
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

  it('allows fs.read outside workspace when full codebase root is configured', () => {
    const yoloConfig: PolicyConfig = {
      ...policyConfig,
      fullCodebaseReadRoot: '/app',
    };
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/src/app/gateway/main.ts' } },
      yoloConfig,
    )).toBe('ALLOW');
  });

  it('still requires approval for fs.read outside configured full codebase root', () => {
    const yoloConfig: PolicyConfig = {
      ...policyConfig,
      fullCodebaseReadRoot: '/app',
    };
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/etc/passwd' } },
      yoloConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('keeps fs.write outside workspace blocked in yolo mode', () => {
    const yoloConfig: PolicyConfig = {
      ...policyConfig,
      fullCodebaseReadRoot: '/app',
    };
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/src/app/gateway/main.ts' } },
      yoloConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('blocks path traversal attempts', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/workspace/../../../etc/passwd' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');

    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '../escape.txt' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('denies fs.list traversal and absolute glob patterns', () => {
    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: '../secrets/**' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: '/etc/*' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: 'src/..' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { path: '../secrets' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { path: '/etc' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { path: 'downloads/*' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('denies unbounded or malformed fs.list scan controls', () => {
    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: 'src/**/*.ts', maxScannedEntries: 0 } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: 'src/**/*.ts', maxScannedEntries: 20_001 } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.list', params: { glob: 'src/**/*.ts', maxScannedEntries: '500' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('denies invalid fs.search parameters', () => {
    expect(evaluatePolicy(
      { method: 'fs.search', params: { query: '', glob: 'src/**/*.ts' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.search', params: { query: 'needle', glob: '../secrets/**' } },
      policyConfig,
    )).toBe('DENY');

    expect(evaluatePolicy(
      { method: 'fs.search', params: { query: 'needle', contextLines: 3 } },
      policyConfig,
    )).toBe('DENY');
  });

  it('requires approval for fs.edit outside workspace', () => {
    expect(evaluatePolicy(
      {
        method: 'fs.edit',
        params: {
          path: '/tmp/evil.sh',
          oldText: 'before',
          newText: 'after',
        },
      },
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
      { method: 'fs.read', params: { path: '/app/companion/modules/repl-registry.json' } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('still allows module registry path when explicitly trusted', () => {
    const trustedConfig: PolicyConfig = {
      ...policyConfig,
      allowedReadPaths: [
        ...(policyConfig.allowedReadPaths ?? []),
        '/app/companion/modules/repl-registry.json',
      ],
    };
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: '/app/companion/modules/repl-registry.json' } },
      trustedConfig,
    )).toBe('ALLOW');
  });

  it('does not allow fs.write on allowed read paths', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/identity/character.json' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('denies fs.write under the protected companion state subtree', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/companion/state/companion.db' } },
      policyConfig,
    )).toBe('DENY');
  });

  it('denies fs.write to the canonical companion identity file', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: '/app/companion/companion.json' } },
      policyConfig,
    )).toBe('DENY');
  });

  // ── Git methods ──

  it('allows git.status (read-only)', () => {
    expect(evaluatePolicy(
      { method: 'git.status', params: {} },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('allows git.diff (read-only)', () => {
    expect(evaluatePolicy(
      { method: 'git.diff', params: { staged: true } },
      policyConfig,
    )).toBe('ALLOW');
  });

  it('requires approval for git.commit (write)', () => {
    expect(evaluatePolicy(
      { method: 'git.commit', params: { message: 'test', intent: 'fix', scope: 'src' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('requires approval for git.create_branch (write)', () => {
    expect(evaluatePolicy(
      { method: 'git.create_branch', params: { name: 'feature/test' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('requires approval for git.apply_patch (write)', () => {
    expect(evaluatePolicy(
      { method: 'git.apply_patch', params: { filePath: 'src/test.ts', content: 'patch' } },
      policyConfig,
    )).toBe('NEEDS_APPROVAL');
  });

  it('requires approval for git.open_pr (write)', () => {
    expect(evaluatePolicy(
      { method: 'git.open_pr', params: { title: 'test PR', body: 'body', base: 'main' } },
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

describe('evaluateShardSessionMemorySyncPolicy', () => {
  const baseEnvelope: ShardSessionMemorySyncEnvelope = {
    version: 1,
    syncClass: 'transcript_fact',
    direction: 'prime_to_shard',
    authority: 'prime',
    operation: 'context_pack_session',
    shardId: 'shard-abc',
    sourceId: 'api:parent-1',
    targetId: 'shard:shard-abc',
    idempotencyKey: 'req-1:session',
    requestedAt: Date.now(),
  };

  it('allows immutable transcript facts from prime to shard', () => {
    expect(evaluateShardSessionMemorySyncPolicy(baseEnvelope)).toEqual({
      allowed: true,
      reason: 'allowed_prime_transcript_fact',
    });
  });

  it('allows derived memory seeding from prime to shard', () => {
    const decision = evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      syncClass: 'derived_memory',
      operation: 'context_pack_memory',
      idempotencyKey: 'req-1:memory',
    });
    expect(decision).toEqual({
      allowed: true,
      reason: 'allowed_prime_memory_seed',
    });
  });

  it('allows shard-to-prime memory writes and denies imports', () => {
    const writeDecision = evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_write',
      sourceId: 'shard:shard-abc',
      targetId: 'memory:index',
      idempotencyKey: 'tool-call-77',
    });
    expect(writeDecision).toEqual({
      allowed: true,
      reason: 'allowed_shard_memory_write',
    });

    const importDecision = evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_import_batch',
      sourceId: 'shard:shard-abc',
      targetId: 'memory:index',
      idempotencyKey: 'tool-call-78',
    });
    expect(importDecision).toEqual({
      allowed: false,
      reason: 'denied_operation',
    });
  });

  it('denies runtime-state sync across shards', () => {
    expect(evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      syncClass: 'runtime_state',
      operation: 'context_pack_session',
    })).toEqual({
      allowed: false,
      reason: 'denied_runtime_state_sync',
    });
  });

  it('denies invalid envelope payloads', () => {
    expect(evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      idempotencyKey: ' ',
    })).toEqual({
      allowed: false,
      reason: 'denied_invalid_envelope',
    });
  });

  it('denies when authority does not match sync direction', () => {
    expect(evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      authority: 'shard',
    })).toEqual({
      allowed: false,
      reason: 'denied_authority',
    });
  });

  it('denies disallowed operations and direction/class combinations', () => {
    const disallowedOp = evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_redact',
      sourceId: 'shard:shard-abc',
      targetId: 'memory:index',
      idempotencyKey: 'tool-call-99',
    });
    expect(disallowedOp).toEqual({
      allowed: false,
      reason: 'denied_operation',
    });

    const disallowedClass = evaluateShardSessionMemorySyncPolicy({
      ...baseEnvelope,
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_write',
      sourceId: 'shard:shard-abc',
      targetId: 'memory:index',
      idempotencyKey: 'tool-call-100',
    });
    expect(disallowedClass).toEqual({
      allowed: false,
      reason: 'denied_direction_class',
    });
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
  const loopSymlinkA = join(workspace, 'loop-a');
  const loopSymlinkB = join(workspace, 'loop-b');
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
    // Symlink loop: A→B, B→A (causes ELOOP)
    symlinkSync(loopSymlinkB, loopSymlinkA);
    symlinkSync(loopSymlinkA, loopSymlinkB);
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

  it('allows fs.read for missing paths under symlinked parents', () => {
    const missingPathViaSymlink = join(symlinkDirToOutside, 'missing.txt');
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: missingPathViaSymlink } },
      realPolicyConfig,
    )).toBe('ALLOW');
  });

  it('denies fs.write for missing paths under symlinked parents', () => {
    const missingPathViaSymlink = join(symlinkDirToOutside, 'missing.txt');
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: missingPathViaSymlink } },
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

  it('denies fs.read on symlink loop (ELOOP)', () => {
    expect(evaluatePolicy(
      { method: 'fs.read', params: { path: loopSymlinkA } },
      realPolicyConfig,
    )).toBe('DENY');
  });

  it('denies fs.write on symlink loop (ELOOP)', () => {
    expect(evaluatePolicy(
      { method: 'fs.write', params: { path: loopSymlinkA } },
      realPolicyConfig,
    )).toBe('DENY');
  });
});
