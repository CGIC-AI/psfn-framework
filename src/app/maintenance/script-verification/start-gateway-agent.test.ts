import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const runtimeEnvPath = join(repoRoot, 'scripts/system/runtime-env.sh');

describe('start-gateway-agent launcher supervision', () => {
  it('starts children in dedicated sessions and kills process groups on shutdown', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/start-gateway-agent.sh'), 'utf8');
    expect(launcher).toContain('setsid "$@" &');
    expect(launcher).toContain('kill -TERM -- "-${pgid}"');
    expect(launcher).toContain('kill -KILL -- "-${pgid}"');
  });

  it('keeps the live user unit pointed at the launcher instead of npm', () => {
    const unit = readFileSync(join(repoRoot, 'scripts/system/user/purrsephone.service'), 'utf8');
    expect(unit).toContain('ExecStart=/bin/bash /mnt/samesung/ai/psfn-live/scripts/start-gateway-agent.sh --yolo');
    expect(unit).not.toContain('ExecStart=%h/.nvm/versions/node/v22.21.1/bin/npm run yolo');
  });
});

describe('psfn_source_dotenv_preserving_existing_env', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps explicit env values while still loading missing dotenv values', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'psfn-launcher-env-'));
    tempDirs.push(workDir);

    const dotenvPath = join(workDir, '.env');
    writeFileSync(
      dotenvPath,
      [
        'DATA_DIR=./dotenv-data',
        'DATABASE_PATH=./dotenv.db',
        'WORKSPACE_PATH=./dotenv-workspace',
        'CHARACTER_CARD_PATH=./dotenv-card.json',
        'NEW_DOTENV_ONLY=loaded',
      ].join('\n'),
      'utf8',
    );

    const output = execFileSync(
      'bash',
      [
        '-lc',
        [
          `source ${JSON.stringify(runtimeEnvPath)}`,
          `export DATA_DIR=/explicit/data`,
          `export DATABASE_PATH=/explicit/db.sqlite`,
          `export WORKSPACE_PATH=/explicit/workspace`,
          `export CHARACTER_CARD_PATH=/explicit/card.json`,
          `psfn_source_dotenv_preserving_existing_env ${JSON.stringify(dotenvPath)}`,
          'printf "%s\\n" "$DATA_DIR" "$DATABASE_PATH" "$WORKSPACE_PATH" "$CHARACTER_CARD_PATH" "$NEW_DOTENV_ONLY"',
        ].join('; '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim().split('\n');

    expect(output).toEqual([
      '/explicit/data',
      '/explicit/db.sqlite',
      '/explicit/workspace',
      '/explicit/card.json',
      'loaded',
    ]);
  });
});
