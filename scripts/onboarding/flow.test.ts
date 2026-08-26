import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCharacterCard } from '../../src/core/identity/loader.js';
import { resolveConfiguredCompanionFleet } from '../companion-fleet-runtime.js';
import type { Prompter, PrompterChoiceOption } from './types.js';
import {
  buildEnvEntries,
  OnboardingCancelled,
  parseLocalPostgresAdminUrl,
  runOnboarding,
} from './flow.js';
import { CompanionImportError } from './companion-import.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');
const LOCAL_POSTGRES_ADMIN_URL = 'postgresql://postgres:admin@127.0.0.1:5432/psfn';

class ScriptedPrompter implements Prompter {
  readonly log: string[] = [];
  constructor(
    private readonly script: {
      choices?: string[];
      texts?: string[];
      secrets?: string[];
      confirms?: boolean[];
    },
  ) {}

  info(message: string): void {
    this.log.push(message);
  }

  async choice(question: string, options: readonly PrompterChoiceOption[]): Promise<string> {
    const answer = (this.script.choices ?? []).shift();
    if (answer === undefined) throw new Error(`Unscripted choice: ${question}`);
    if (!options.some((o) => o.value === answer)) {
      throw new Error(`Choice "${answer}" not among options for: ${question}`);
    }
    return answer;
  }

  async text(_question: string, opts: { default?: string; allowEmpty?: boolean } = {}): Promise<string> {
    const raw = (this.script.texts ?? []).shift() ?? '';
    if (raw === '') {
      if (opts.default !== undefined) return opts.default;
      if (opts.allowEmpty) return '';
      throw new Error(`Required text with no default: ${_question}`);
    }
    return raw;
  }

  async secret(): Promise<string> {
    return (this.script.secrets ?? []).shift() ?? '';
  }

  async confirm(_question: string, opts: { default?: boolean } = {}): Promise<boolean> {
    const answer = (this.script.confirms ?? []).shift();
    return answer ?? opts.default ?? false;
  }
}

const workspaces: string[] = [];
function workspace(): { root: string; envPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'onboard-flow-'));
  workspaces.push(root);
  return { root, envPath: join(root, '.env') };
}
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop() as string, { recursive: true, force: true });
});

describe('runOnboarding — local dev happy path', () => {
  it('generates owner files and writes the provider key only to .env', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const prompter = new ScriptedPrompter({
      choices: ['local', 'openrouter', 'fresh'],
      // id, apiBaseUrl, modelsApiUrl, apiKeyEnvName, primary, extraction, vision
      texts: ['', '', '', '', '', '', ''],
      secrets: ['sk-or-flow-secret', LOCAL_POSTGRES_ADMIN_URL],
      confirms: [false, false], // voice off, connectivity off
    });

    const outcome = await runOnboarding({
      prompter,
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { local: { systemDataDir: dataDir, companionDataDir: dataDir, shared: true } },
    });

    expect(outcome.writtenPaths.length).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, 'providers.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'models.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'companions.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'mcp-servers.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'companions', 'main', 'scheduler.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'companions', 'main', 'companion.json'))).toBe(true);

    const envText = readFileSync(envPath, 'utf-8');
    expect(envText).toContain('OPENROUTER_API_KEY=sk-or-flow-secret');
    expect(envText).toContain(`SYSTEM_DATA_DIR=${dataDir}`);
    expect(envText).toContain(`COMPANION_DATA_DIR=${join(dataDir, 'companions', 'main')}`);
    expect(envText).toContain(`PSFN_RUNTIME_ROOT=${root}`);
    expect(envText).toContain('POSTGRES_ADMIN_DATABASE_URL=postgresql://postgres:admin@127.0.0.1:5432/psfn');
    expect(envText).toMatch(/^COMPANION_MAIN_DATABASE_URL=postgresql:\/\/companion_main_runtime:[0-9a-f]{64}@127\.0\.0\.1:5432\/psfn$/mu);
    expect(envText).toMatch(/^SHARED_SCHEMA_MIGRATION_DATABASE_URL=postgresql:\/\/shared_schema_migration:[0-9a-f]{64}@127\.0\.0\.1:5432\/psfn$/mu);
    expect(envText).toContain('ADMIN_PORT=10053');
    expect(envText).toContain('API_PORT=10054');
    expect(prompter.log.join('\n')).toContain('npm run local:up');

    const fleet = resolveConfiguredCompanionFleet({
      PSFN_RUNTIME_ROOT: root,
      DATA_DIR: dataDir,
      CONFIG_DIR: SEED_DIR,
    });
    expect(fleet.companions).toEqual([
      expect.objectContaining({
        companionId: outcome.plan.companionId,
        companionDataDir: join(dataDir, 'companions', 'main'),
        characterCardPath: join(dataDir, 'companions', 'main', 'companion.json'),
        displayName: 'Companion',
      }),
    ]);

    // The secret must never appear in any generated owner file.
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
      expect(readFileSync(join(dataDir, file), 'utf-8')).not.toContain('sk-or-flow-secret');
    }
  });
});

describe('runOnboarding — idempotency and abort', () => {
  it('aborts when an existing config is present and the operator declines update', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const roots = { local: { systemDataDir: dataDir, companionDataDir: dataDir, shared: true } } as const;

    // First run seeds a config.
    await runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter', 'fresh'],
        texts: ['', '', '', '', '', '', ''],
        secrets: ['sk-first', LOCAL_POSTGRES_ADMIN_URL],
        confirms: [false, false],
      }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: roots,
    });

    // Second run: existing config detected -> choose abort.
    await expect(runOnboarding({
      prompter: new ScriptedPrompter({ choices: ['local', 'abort'] }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: roots,
    })).rejects.toBeInstanceOf(OnboardingCancelled);
  });

  it('cancels without writing when a connectivity check fails and the operator declines', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');

    await expect(runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter'],
        texts: ['', '', '', '', '', '', ''],
        secrets: ['sk-bad', LOCAL_POSTGRES_ADMIN_URL],
        confirms: [false, true, false], // voice off, run check = true, proceed-anyway = false
      }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { local: { systemDataDir: dataDir, companionDataDir: dataDir, shared: true } },
      connectivity: async () => ({ ok: false, message: 'bad key' }),
    })).rejects.toBeInstanceOf(OnboardingCancelled);

    expect(existsSync(join(dataDir, 'providers.json'))).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe('runOnboarding — kubernetes mode', () => {
  it('writes native local target wiring without capturing a provider secret', async () => {
    const { root, envPath } = workspace();
    const systemDataDir = join(root, 'system-data');
    const companionDataDir = join(root, 'companion-data');
    const prompter = new ScriptedPrompter({
      choices: ['kubernetes', 'local-k3d', 'openrouter', 'fresh'],
      // Garden port, cluster, provider id/base/models URL/key env, three model slugs, companion name.
      texts: ['', '', '', '', '', '', '', '', ''],
      confirms: [true, false], // Tailscale publication on, voice off.
    });

    const outcome = await runOnboarding({
      prompter,
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { kubernetes: { systemDataDir, companionDataDir, shared: false } },
      discoverTailnet: () => ({
        cli: '/opt/tailscale',
        dnsName: 'demo-node.example.ts.net',
        windowsHost: false,
      }),
    });

    expect(outcome.envWritten).toBe(true);
    const envText = readFileSync(envPath, 'utf8');
    expect(envText).toContain('PSFN_KUBE_CONTEXT=k3d-psfn-local');
    expect(envText).toContain('PSFN_K3D_CLUSTER=psfn-local');
    expect(envText).toContain('PSFN_K3D_NATIVE_GARDEN=1');
    expect(envText).toContain('PSFN_GARDEN_PORT=10053');
    expect(envText).toContain('PSFN_TAILSCALE_SERVE=1');
    expect(envText).toContain('PSFN_TAILNET_HOST=demo-node.example.ts.net');
    expect(envText).not.toContain('OPENROUTER_API_KEY');
    expect(existsSync(join(systemDataDir, 'providers.json'))).toBe(true);
    expect(existsSync(join(systemDataDir, 'mcp-servers.json'))).toBe(true);
    expect(existsSync(join(companionDataDir, 'main', 'scheduler.json'))).toBe(true);
    expect(prompter.log.join('\n')).toContain('npm run helm:up');
    expect(prompter.log.join('\n')).toContain('local k3d target wiring was written to .env');
    expect(prompter.log.join('\n')).toContain('provisions the chart-managed PostgreSQL roles and URLs');
    expect(prompter.log.join('\n')).not.toContain('private deployment configuration');
  });

  it('records an exact existing context without enabling native or Tailscale mutation', async () => {
    const { root, envPath } = workspace();
    writeFileSync(envPath, [
      'PSFN_KUBE_CONTEXT=k3d-stale-local',
      'PSFN_K3D_CLUSTER=stale-local',
      'PSFN_K3D_NATIVE_GARDEN=1',
      'PSFN_TAILSCALE_SERVE=1',
      'PSFN_TAILNET_HOST=stale-node.example.ts.net',
      '',
    ].join('\n'));
    const prompter = new ScriptedPrompter({
      choices: ['kubernetes', 'existing-context', 'openrouter', 'fresh'],
      // Garden port, exact context, provider id/base/models URL/key env, model slugs, companion name.
      texts: ['', 'example-context', '', '', '', '', '', '', ''],
      confirms: [false],
    });

    const outcome = await runOnboarding({
      prompter,
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: {
        kubernetes: {
          systemDataDir: join(root, 'system-data'),
          companionDataDir: join(root, 'companion-data'),
          shared: false,
        },
      },
      discoverTailnet: () => {
        throw new Error('existing-context onboarding must not inspect Tailscale');
      },
    });

    expect(outcome.envWritten).toBe(true);
    const envText = readFileSync(envPath, 'utf8');
    expect(envText).toContain('PSFN_KUBE_CONTEXT=example-context');
    expect(envText).toContain('PSFN_K3D_NATIVE_GARDEN=0');
    expect(envText).toContain('PSFN_TAILSCALE_SERVE=0');
    expect(envText).not.toContain('PSFN_K3D_CLUSTER');
    expect(envText).not.toContain('PSFN_TAILNET_HOST');
  });
});

describe('runOnboarding — persistent Compose mode', () => {
  it('writes generated infrastructure credentials without exposing them in owner files or logs', async () => {
    const { root, envPath } = workspace();
    const systemDataDir = join(root, 'data', 'system-data');
    const companionDataDir = join(root, 'data', 'companion-data');
    const prompter = new ScriptedPrompter({
      choices: ['compose', 'generic_openai', 'fresh'],
      texts: [
        '',
        'https://api.z.ai/api/coding/paas/v4',
        'glm-4.7',
        'glm-4.7-flash',
        'glm-4.6v',
        '',
      ],
      secrets: ['test-provider-secret'],
      confirms: [false, false],
    });

    const outcome = await runOnboarding({
      prompter,
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { compose: { systemDataDir, companionDataDir, shared: false } },
    });

    const envText = readFileSync(envPath, 'utf8');
    for (const envName of [
      'PSFN_POSTGRES_SUPERUSER_PASSWORD',
      'PSFN_COMPANION_DATABASE_PASSWORD',
      'PSFN_SHARED_MIGRATION_DATABASE_PASSWORD',
      'API_KEY',
      'ADMIN_TOKEN',
      'GATEWAY_SESSION_HMAC_KEY',
      'PSFN_BACKUP_ENCRYPTION_KEY',
    ]) {
      expect(envText).toMatch(new RegExp(`^${envName}=[0-9a-f]{64}$`, 'mu'));
    }
    expect(envText).toContain('PSFN_PROVIDER_API_KEY=test-provider-secret');
    expect(envText).toContain(`COMPANION_ID=${outcome.plan.companionId}`);
    expect(envText).toContain('PSFN_GARDEN_PORT=10053');
    expect(envText).toContain('PSFN_API_PORT=10054');
    expect(prompter.log.join('\n')).toContain('npm run compose:up');
    expect(prompter.log.join('\n')).not.toContain('test-provider-secret');

    for (const file of readdirSync(systemDataDir).filter((name) => name.endsWith('.json'))) {
      const contents = readFileSync(join(systemDataDir, file), 'utf8');
      expect(contents).not.toContain('test-provider-secret');
      expect(contents).not.toMatch(/[0-9a-f]{64}/u);
    }
  });
});

// Guard: an unrelated pre-existing .env is preserved/merged, not clobbered.
describe('runOnboarding — .env merge safety', () => {
  it('preserves unrelated existing .env entries', async () => {
    const { root, envPath } = workspace();
    writeFileSync(envPath, 'PRE_EXISTING=keepme\n');
    const dataDir = join(root, 'data');

    await runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter', 'fresh'],
        texts: ['', '', '', '', '', '', ''],
        secrets: ['sk-merge', LOCAL_POSTGRES_ADMIN_URL],
        confirms: [false, false],
      }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { local: { systemDataDir: dataDir, companionDataDir: dataDir, shared: true } },
    });

    const envText = readFileSync(envPath, 'utf-8');
    expect(envText).toContain('PRE_EXISTING=keepme');
    expect(envText).toContain('OPENROUTER_API_KEY=sk-merge');
  });
});

// wckv.1.3: companion import lands a bootable card where startup reads it, and
// malformed input is rejected before anything is written.
describe('runOnboarding — companion import (wckv.1.3)', () => {
  const CCV3_CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Nova',
      description: 'A curious deep-space guide.',
      personality: 'Warm, inquisitive, precise.',
      scenario: 'Aboard a survey vessel.',
      first_mes: 'Hi, I am Nova.',
      mes_example: '',
      system_prompt: 'Stay grounded and specific.',
      post_history_instructions: '',
      tags: ['space'],
      creator: 'tester',
    },
  };

  // The fleet runtime reads the card from the generated companion subdirectory.
  function cardPath(dataDir: string): string {
    return join(dataDir, 'companions', 'main', 'companion.json');
  }

  function runImport(input: {
    dataDir: string;
    envPath: string;
    source: 'ccv3' | 'soulmd' | 'markdown';
    sourcePath: string;
    lumpName?: string;
  }) {
    const texts = ['', '', '', '', '', '', '', input.sourcePath];
    if (input.source === 'markdown') texts.push(input.lumpName ?? '');
    return runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter', input.source],
        texts,
        secrets: ['sk-import', LOCAL_POSTGRES_ADMIN_URL],
        confirms: [false, false, true], // voice off, connectivity off, import confirm
      }),
      seedDir: SEED_DIR,
      envPath: input.envPath,
      rootsOverride: { local: { systemDataDir: input.dataDir, companionDataDir: input.dataDir, shared: true } },
    });
  }

  it('imports a CCv3 card to the runtime card path and passes the guard', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const sourcePath = join(root, 'nova.json');
    writeFileSync(sourcePath, JSON.stringify(CCV3_CARD), 'utf-8');

    const outcome = await runImport({ dataDir, envPath, source: 'ccv3', sourcePath });

    const written = loadCharacterCard(cardPath(dataDir)); // throws if missing/invalid
    expect(written.data.name).toBe('Nova');
    expect(written.data.personality).toContain('inquisitive');
    expect(outcome.writtenPaths).toContain(cardPath(dataDir));
    const manifest = JSON.parse(readFileSync(join(dataDir, 'companions.json'), 'utf-8')) as {
      companions: Array<{ displayName?: string }>;
    };
    expect(manifest.companions[0]?.displayName).toBe('Nova');
    // COMPANION_ID was written so the newcomer need not hand-copy it.
    expect(readFileSync(envPath, 'utf-8')).toContain('COMPANION_ID=');
  });

  it('imports a SoulMD document into the persona fields', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const sourcePath = join(root, 'sable.md');
    writeFileSync(
      sourcePath,
      '---\nname: Sable\n---\n\n## Personality\nDry wit, fiercely loyal.\n\n## Scenario\nA rain-soaked city.\n',
      'utf-8',
    );

    await runImport({ dataDir, envPath, source: 'soulmd', sourcePath });

    const written = loadCharacterCard(cardPath(dataDir));
    expect(written.data.name).toBe('Sable');
    expect(written.data.personality).toContain('Dry wit');
    expect(written.data.scenario).toContain('rain-soaked');
  });

  it('imports plain persona markdown as a single lump (no field sorting)', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const sourcePath = join(root, 'rune.md');
    writeFileSync(sourcePath, '# Rune\n\nYou are Rune, a hearth-keeper who keeps promises.\n', 'utf-8');

    await runImport({ dataDir, envPath, source: 'markdown', sourcePath, lumpName: 'Rune' });

    const written = loadCharacterCard(cardPath(dataDir));
    expect(written.data.name).toBe('Rune');
    expect(written.data.personality).toContain('hearth-keeper');
    // Not split into structured fields.
    expect(written.data.scenario).toBe('');
  });

  it('rejects malformed companion input before writing anything', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');
    const sourcePath = join(root, 'broken.json');
    writeFileSync(sourcePath, '{"totally":"not a card"}', 'utf-8');

    await expect(runImport({ dataDir, envPath, source: 'ccv3', sourcePath }))
      .rejects.toBeInstanceOf(CompanionImportError);

    // Pre-write rejection: neither the card nor the owner files landed.
    expect(existsSync(cardPath(dataDir))).toBe(false);
    expect(existsSync(join(dataDir, 'providers.json'))).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });

  it('fresh-start scaffolds a bootable blank companion card', async () => {
    const { root, envPath } = workspace();
    const dataDir = join(root, 'data');

    await runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter', 'fresh'],
        texts: ['', '', '', '', '', '', '', 'Willow'],
        secrets: ['sk-fresh', LOCAL_POSTGRES_ADMIN_URL],
        confirms: [false, false],
      }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { local: { systemDataDir: dataDir, companionDataDir: dataDir, shared: true } },
    });

    const written = loadCharacterCard(cardPath(dataDir));
    expect(written.data.name).toBe('Willow');
    expect(written.data.tags).toContain('bootstrap');
  });
});

describe('repository-native PostgreSQL URL validation', () => {
  it('accepts only a credentialed postgres authority, retaining connection options', () => {
    expect(parseLocalPostgresAdminUrl(`${LOCAL_POSTGRES_ADMIN_URL}?sslmode=disable#ignored`))
      .toBe(`${LOCAL_POSTGRES_ADMIN_URL}?sslmode=disable`);
    expect(() => parseLocalPostgresAdminUrl('postgresql://other:admin@127.0.0.1/psfn'))
      .toThrow(/authenticate as postgres/u);
    expect(() => parseLocalPostgresAdminUrl('not-a-url')).toThrow(/valid URL/u);
  });

  it('keeps retained role passwords synchronized with regenerated database URLs', () => {
    const entries = buildEnvEntries({
      mode: 'local',
      roots: {
        systemDataDir: '/tmp/psfn-test/system-data',
        companionDataDir: '/tmp/psfn-test/companion-data',
        shared: false,
      },
      provider: {
        id: 'provider',
        type: 'generic_openai',
        label: 'Provider',
        apiBaseUrl: 'https://example.invalid/v1',
        apiKeyEnvName: 'PROVIDER_API_KEY',
        apiKeyValue: 'provider-key',
      },
      voice: { enabled: false, secrets: [] },
      companionId: '11111111-1111-4111-8111-111111111111',
      capturesHostSecret: true,
      localPostgresAdminUrl: LOCAL_POSTGRES_ADMIN_URL,
      existingEnv: {
        PSFN_COMPANION_DATABASE_PASSWORD: 'retained-companion-password',
        PSFN_SHARED_MIGRATION_DATABASE_PASSWORD: 'retained-shared-password',
      },
    });
    const values = Object.fromEntries(entries.map(entry => [entry.envName, entry.value]));
    expect(values.COMPANION_MAIN_DATABASE_URL).toContain('retained-companion-password');
    expect(values.SHARED_SCHEMA_MIGRATION_DATABASE_URL).toContain('retained-shared-password');
    expect(entries.find(entry => entry.envName === 'COMPANION_MAIN_DATABASE_URL')?.preserveExisting)
      .toBe(false);
  });
});
