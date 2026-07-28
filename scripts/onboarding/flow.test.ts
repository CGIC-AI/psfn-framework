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
import type { Prompter, PrompterChoiceOption } from './types.js';
import { OnboardingCancelled, runOnboarding } from './flow.js';
import { CompanionImportError } from './companion-import.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');

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
      // id, apiBaseUrl, modelsApiUrl, apiKeyEnvName, primary slug, extraction slug
      texts: ['', '', '', '', '', ''],
      secrets: ['sk-or-flow-secret'],
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

    const envText = readFileSync(envPath, 'utf-8');
    expect(envText).toContain('OPENROUTER_API_KEY=sk-or-flow-secret');
    expect(envText).toContain('DATA_DIR=');

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
        texts: ['', '', '', '', '', ''],
        secrets: ['sk-first'],
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
        texts: ['', '', '', '', '', ''],
        secrets: ['sk-bad'],
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
  it('generates and validates owner files without capturing a host secret or .env', async () => {
    const { root, envPath } = workspace();
    const systemDataDir = join(root, 'system-data');
    const companionDataDir = join(root, 'companion-data');

    const outcome = await runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['kubernetes', 'openrouter', 'fresh'],
        texts: ['', '', '', '', '', ''],
        confirms: [false], // voice off (no connectivity prompt in k8s mode)
      }),
      seedDir: SEED_DIR,
      envPath,
      rootsOverride: { kubernetes: { systemDataDir, companionDataDir, shared: false } },
    });

    expect(outcome.envWritten).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(existsSync(join(systemDataDir, 'providers.json'))).toBe(true);
    expect(existsSync(join(companionDataDir, 'scheduler.json'))).toBe(true);
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
        texts: ['', '', '', '', '', ''],
        secrets: ['sk-merge'],
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

  // The single-companion runtime reads the card at {companionDataDir}/companion.json.
  function cardPath(dataDir: string): string {
    return join(dataDir, 'companion.json');
  }

  function runImport(input: {
    dataDir: string;
    envPath: string;
    source: 'ccv3' | 'soulmd' | 'markdown';
    sourcePath: string;
    lumpName?: string;
  }) {
    const texts = ['', '', '', '', '', '', input.sourcePath];
    if (input.source === 'markdown') texts.push(input.lumpName ?? '');
    return runOnboarding({
      prompter: new ScriptedPrompter({
        choices: ['local', 'openrouter', input.source],
        texts,
        secrets: ['sk-import'],
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
        texts: ['', '', '', '', '', '', 'Willow'],
        secrets: ['sk-fresh'],
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
