import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { describeStartupOwnerFileChecks } from '../../src/system/config/startup-owner-files.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const seedScript = join(repoRoot, 'scripts/ops/psfn-compose-smoke-seed.sh');
const composeFile = join(repoRoot, 'docker/docker-compose.smoke.yml');
const supportedComposeFile = join(repoRoot, 'docker/compose.yml');
const supportedComposeBootstrap = join(repoRoot, 'scripts/ops/psfn-compose-bootstrap.mjs');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-compose-bootstrap-test-'));
  temporaryRoots.push(root);
  return root;
}

function writeSeed(configDir: string, owner: string): void {
  writeFileSync(join(configDir, `${owner}.seed.json`), '{}\n', 'utf8');
}

describe('Compose smoke bootstrap', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wires a healthy internal-only operator alert sink before Gateway startup', () => {
    const compose = parseYaml(readFileSync(composeFile, 'utf8')) as {
      services?: Record<string, {
        depends_on?: Record<string, { condition?: string }>;
        environment?: Record<string, string>;
        healthcheck?: unknown;
        networks?: string[];
        ports?: unknown;
      }>;
    };
    const alertSink = compose.services?.['operator-alert-sink'];
    const gateway = compose.services?.gateway;
    const agent = compose.services?.agent;

    expect(alertSink).toMatchObject({
      networks: ['psfn-smoke-internal'],
    });
    expect(alertSink?.healthcheck).toBeDefined();
    expect(alertSink?.ports).toBeUndefined();
    expect(compose.services?.['model-prefetch']?.environment).toMatchObject({
      PSFN_SMOKE_INJECTION_MODEL_DIR: '/app/models/prompt-injection-v2',
      PSFN_SMOKE_INJECTION_PROVISION_SCRIPT: '/app/dist/provision-injection-model.js',
    });
    expect(gateway?.depends_on?.['operator-alert-sink']).toEqual({
      condition: 'service_healthy',
    });
    expect(gateway?.environment).toMatchObject({
      NTFY_BASE_URL: 'http://operator-alert-sink:3000',
      NTFY_TOPIC: 'smoke-operator-alerts',
    });
    expect(agent?.environment).toMatchObject({
      NTFY_BASE_URL: 'http://operator-alert-sink:3000',
      NTFY_TOPIC: 'smoke-operator-alerts',
    });
  });

  it('fails with the missing required owner name when automata-policy is absent', () => {
    const root = temporaryRoot();
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    for (const owner of [
      'settings',
      'models',
      'providers',
      'trust-policy',
      'intake-policy',
      'backup',
      'partner-affect-shadow',
      'places',
      'runtime-prompt-layers',
      'scheduler',
      'capability-tier',
      'charge-policy',
      'skills',
    ]) {
      writeSeed(configDir, owner);
    }

    const result = spawnSync('sh', [seedScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SYSTEM_DATA_DIR: join(root, 'system-data'),
        COMPANION_DATA_DIR: join(root, 'companion-data'),
        WORKSPACE_PATH: join(root, 'workspace'),
        GATEWAY_SOCKET: join(root, 'run/gateway.sock'),
        PSFN_SMOKE_AGENT_AUTH_DIR: join(root, 'agent-auth'),
        PSFN_SMOKE_MODEL_CACHE_ROOT: join(root, 'model-cache'),
        PSFN_SEED_CONFIG_DIR: configDir,
        PSFN_RUNTIME_UID: String(process.getuid?.() ?? 999),
        PSFN_RUNTIME_GID: String(process.getgid?.() ?? 999),
        COMPANION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        GATEWAY_SESSION_HMAC_KEY: '',
        POSTGRES_DATABASE_URL: 'postgresql://fixture.invalid/psfn',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `[smoke-seed] missing seed template: ${join(configDir, 'automata-policy.seed.json')}`,
    );
  });

  it('fails before network access when offline mode has no model-cache input', () => {
    const root = temporaryRoot();
    const cacheDir = join(root, 'cache');
    const inputDir = join(root, 'input');
    mkdirSync(cacheDir);
    mkdirSync(inputDir);

    const result = spawnSync('node', [
      join(repoRoot, 'scripts/ops/psfn-compose-smoke-prefetch.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: '1',
        PSFN_SMOKE_MODEL_CACHE_DIR: cacheDir,
        PSFN_SMOKE_MODEL_CACHE_INPUT_DIR: inputDir,
        PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: '1111111111111111111111111111111111111111',
        PSFN_SMOKE_EMBEDDING_MODEL_REVISION: '2222222222222222222222222222222222222222',
      },
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('[model-prefetch] offline cache input is empty');
    expect(result.stderr).toContain('PSFN_SMOKE_MODEL_CACHE_SOURCE');
  });

  it('reports how to repair a missing offline cache-input path', () => {
    const root = temporaryRoot();
    const result = spawnSync('node', [
      join(repoRoot, 'scripts/ops/psfn-compose-smoke-prefetch.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: '1',
        PSFN_SMOKE_MODEL_CACHE_DIR: join(root, 'cache'),
        PSFN_SMOKE_MODEL_CACHE_INPUT_DIR: join(root, 'missing-input'),
        PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: '1111111111111111111111111111111111111111',
        PSFN_SMOKE_EMBEDDING_MODEL_REVISION: '2222222222222222222222222222222222222222',
      },
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('configured cache input does not exist or is not a directory');
    expect(result.stderr).toContain('PSFN_SMOKE_MODEL_CACHE_SOURCE');
  });

  it('rejects an unknown offline-mode value instead of enabling network access', () => {
    const root = temporaryRoot();
    const result = spawnSync('node', [
      join(repoRoot, 'scripts/ops/psfn-compose-smoke-prefetch.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: 'sometimes',
        PSFN_SMOKE_MODEL_CACHE_DIR: join(root, 'cache'),
        PSFN_SMOKE_MODEL_CACHE_INPUT_DIR: join(root, 'input'),
        PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: '1111111111111111111111111111111111111111',
        PSFN_SMOKE_EMBEDDING_MODEL_REVISION: '2222222222222222222222222222222222222222',
      },
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'PSFN_SMOKE_MODEL_PREFETCH_OFFLINE must be 0 or 1; received "sometimes"',
    );
  });

  it('fails actionably when a pinned model revision is missing', () => {
    const root = temporaryRoot();
    const result = spawnSync('node', [
      join(repoRoot, 'scripts/ops/psfn-compose-smoke-prefetch.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: '1',
        PSFN_SMOKE_MODEL_CACHE_DIR: join(root, 'cache'),
        PSFN_SMOKE_MODEL_CACHE_INPUT_DIR: join(root, 'input'),
        PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: '',
        PSFN_SMOKE_EMBEDDING_MODEL_REVISION: '2222222222222222222222222222222222222222',
      },
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION must be an exact 40-character lowercase commit SHA',
    );
  });

  it('replaces stale cache contents with the supplied offline input before model loading', () => {
    const root = temporaryRoot();
    const cacheDir = join(root, 'cache');
    const inputDir = join(root, 'input');
    mkdirSync(cacheDir);
    mkdirSync(inputDir);
    const emotionRevision = '1111111111111111111111111111111111111111';
    const embeddingRevision = '2222222222222222222222222222222222222222';
    const staleModelDir = join(cacheDir, 'SamLowe/roberta-base-go_emotions-onnx');
    const emotionInput = join(
      inputDir,
      'SamLowe/roberta-base-go_emotions-onnx',
      emotionRevision,
    );
    const embeddingInput = join(inputDir, 'Xenova/all-MiniLM-L6-v2', embeddingRevision);
    mkdirSync(staleModelDir, { recursive: true });
    mkdirSync(emotionInput, { recursive: true });
    mkdirSync(embeddingInput, { recursive: true });
    writeFileSync(join(staleModelDir, 'stale-artifact'), 'stale', 'utf8');
    writeFileSync(join(cacheDir, 'unrelated-owner-file'), 'preserve', 'utf8');
    writeFileSync(join(emotionInput, 'config.json'), '{}', 'utf8');
    writeFileSync(join(embeddingInput, 'config.json'), '{}', 'utf8');

    const result = spawnSync('node', [
      join(repoRoot, 'scripts/ops/psfn-compose-smoke-prefetch.mjs'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: '1',
        PSFN_SMOKE_MODEL_CACHE_DIR: cacheDir,
        PSFN_SMOKE_MODEL_CACHE_INPUT_DIR: inputDir,
        PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: emotionRevision,
        PSFN_SMOKE_EMBEDDING_MODEL_REVISION: embeddingRevision,
      },
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(existsSync(join(staleModelDir, 'stale-artifact'))).toBe(false);
    expect(existsSync(join(cacheDir, 'unrelated-owner-file'))).toBe(true);
    expect(existsSync(join(staleModelDir, emotionRevision, 'config.json'))).toBe(true);
    expect(existsSync(join(staleModelDir, 'config.json'))).toBe(true);
    expect(existsSync(join(
      cacheDir,
      'Xenova/all-MiniLM-L6-v2',
      embeddingRevision,
      'config.json',
    ))).toBe(true);
  });

  it('seeds the current required system owners into a clean Compose root', () => {
    const root = temporaryRoot();
    const systemDataDir = join(root, 'system-data');
    const result = spawnSync('sh', [seedScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SYSTEM_DATA_DIR: systemDataDir,
        COMPANION_DATA_DIR: join(root, 'companion-data'),
        WORKSPACE_PATH: join(root, 'workspace'),
        GATEWAY_SOCKET: join(root, 'run/gateway.sock'),
        PSFN_SMOKE_AGENT_AUTH_DIR: join(root, 'agent-auth'),
        PSFN_SMOKE_MODEL_CACHE_ROOT: join(root, 'model-cache'),
        PSFN_SEED_CONFIG_DIR: join(repoRoot, 'config'),
        PSFN_RUNTIME_UID: String(process.getuid?.() ?? 999),
        PSFN_RUNTIME_GID: String(process.getgid?.() ?? 999),
        COMPANION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        GATEWAY_SESSION_HMAC_KEY: '',
        POSTGRES_DATABASE_URL: 'postgresql://fixture.invalid/psfn',
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(join(systemDataDir, 'automata-policy.json'))).toBe(true);
    expect(existsSync(join(systemDataDir, 'partner-affect-shadow.json'))).toBe(false);
    expect(JSON.parse(
      readFileSync(join(root, 'companion-data/capability-tier.json'), 'utf8'),
    )).toMatchObject({ tier: 'autonomous' });
    for (const owner of describeStartupOwnerFileChecks()) {
      if (owner.optionalWhenMissing) continue;
      const ownerRoot = owner.scope === 'system'
        ? systemDataDir
        : join(root, 'companion-data');
      expect(existsSync(join(ownerRoot, owner.ownerFileName)), owner.label).toBe(true);
    }
  });
});

describe('Supported persistent Compose topology', () => {
  it('deploys the complete product and keeps the isolated agent free of gateway secrets', () => {
    const compose = parseYaml(readFileSync(supportedComposeFile, 'utf8')) as {
      services: Record<string, {
        command?: string[];
        environment?: Record<string, string>;
        ports?: string[];
        networks?: string[];
        volumes?: string[];
        restart?: string;
      }>;
      volumes?: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining([
      'postgres',
      'bootstrap',
      'model-prefetch',
      'gateway',
      'agent',
      'garden',
    ]));
    expect(compose.services.gateway?.ports).toContain('127.0.0.1:${PSFN_API_PORT:-10054}:3000');
    expect(compose.services.garden?.ports).toContain('127.0.0.1:${PSFN_GARDEN_PORT:-10053}:3001');
    expect(compose.services.garden?.command).toEqual(['node', 'dist/operator-main.js']);
    expect(compose.services.garden?.networks).toEqual(['internal', 'host-access']);
    expect(compose.services.agent?.networks).toEqual(['internal']);
    expect(compose.services.agent?.environment).not.toHaveProperty('API_KEY');
    expect(compose.services.agent?.environment).not.toHaveProperty('ADMIN_TOKEN');
    expect(compose.services.agent?.environment).not.toHaveProperty('PSFN_PROVIDER_API_KEY');
    expect(compose.services.gateway?.environment).not.toHaveProperty('PSFN_POSTGRES_SUPERUSER_PASSWORD');
    expect(compose.services.gateway?.restart).toBe('unless-stopped');
    expect(compose.services.agent?.restart).toBe('unless-stopped');
    expect(compose.services.garden?.restart).toBe('unless-stopped');
    expect(compose.volumes).toHaveProperty('postgres-data');
  });

  it('provisions enough finite database connections for a full agent startup', () => {
    const compose = parseYaml(readFileSync(supportedComposeFile, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const bootstrapSource = readFileSync(supportedComposeBootstrap, 'utf8');

    expect(compose.services.bootstrap?.environment).toMatchObject({
      PSFN_COMPANION_DATABASE_CONNECTION_LIMIT: '80',
    });
    expect(bootstrapSource).toMatch(
      /parseNumericId\(\s*'PSFN_COMPANION_DATABASE_CONNECTION_LIMIT',?\s*\)/u,
    );
    expect(bootstrapSource).not.toContain('CONNECTION LIMIT 20');
  });
});
