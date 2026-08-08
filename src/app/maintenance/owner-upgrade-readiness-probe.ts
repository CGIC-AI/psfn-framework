#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import {
  loadChargePolicyConfig,
} from '../../system/config/charge-policy-config.js';
import {
  loadSkillsConfig,
} from '../../system/config/skills-config.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

type Mode = 'seed-legacy' | 'legacy-server' | 'companion';

interface CliOptions {
  mode: Mode;
  values: Map<string, string[]>;
}

function parseArgs(argv: string[]): CliOptions {
  let mode: Mode | undefined;
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      name === undefined
      || value === undefined
      || !name.startsWith('--')
      || value.startsWith('--')
    ) {
      throw new Error('Arguments must use exact --name value pairs');
    }
    if (name === '--mode') {
      if (!['seed-legacy', 'legacy-server', 'companion'].includes(value)) {
        throw new Error(`Unsupported probe mode: ${value}`);
      }
      mode = value as Mode;
      continue;
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  if (!mode) throw new Error('--mode is required');
  return { mode, values };
}

function one(options: CliOptions, name: string): string {
  const values = options.values.get(name);
  if (values?.length !== 1 || !values[0]) throw new Error(`${name} is required exactly once`);
  return values[0];
}

function many(options: CliOptions, name: string): string[] {
  const values = options.values.get(name) ?? [];
  if (values.length === 0) throw new Error(`${name} is required at least once`);
  return values;
}

function integer(options: CliOptions, name: string): number {
  const raw = one(options, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function copyExact(source: string, target: string): void {
  if (existsSync(target)) {
    if (!readFileSync(source).equals(readFileSync(target))) {
      throw new Error(`Refusing to overwrite existing legacy fixture path: ${target}`);
    }
    return;
  }
  copyFileSync(source, target);
}

function seedLegacy(options: CliOptions): void {
  const fixtureDir = one(options, '--fixture-dir');
  const configDir = one(options, '--config-dir');
  const systemDataDir = one(options, '--system-data-dir');
  const companionDataDirs = many(options, '--companion-data-dir');
  mkdirSync(systemDataDir, { recursive: true });
  for (const companionDataDir of companionDataDirs) mkdirSync(companionDataDir, { recursive: true });
  copyExact(join(fixtureDir, 'companions.json'), join(systemDataDir, 'companions.json'));
  for (const owner of [
    'settings',
    'models',
    'providers',
    'trust-policy',
    'backup',
    'intake-policy',
  ]) {
    copyExact(join(configDir, `${owner}.seed.json`), join(systemDataDir, `${owner}.json`));
  }
  for (const owner of ['charge-policy', 'skills']) {
    copyExact(join(fixtureDir, `${owner}.json`), join(systemDataDir, `${owner}.json`));
  }
  companionDataDirs.forEach((companionDataDir, index) => {
    copyExact(join(configDir, 'scheduler.seed.json'), join(companionDataDir, 'scheduler.json'));
    copyExact(
      join(configDir, 'capability-tier.seed.json'),
      join(companionDataDir, 'capability-tier.json'),
    );
    const identityPath = join(companionDataDir, 'companion.json');
    const identity = `${JSON.stringify({ fixtureIdentity: `companion-${index + 1}` })}\n`;
    if (existsSync(identityPath) && readFileSync(identityPath, 'utf8') !== identity) {
      throw new Error(`Refusing to overwrite existing companion identity: ${identityPath}`);
    }
    if (!existsSync(identityPath)) writeFileSync(identityPath, identity, { mode: 0o600 });
  });
  console.log(JSON.stringify({ status: 'seeded-legacy', systemDataDir, companionDataDirs }));
}

function assertOwnerValues(
  dataDir: string,
  expectedCharge: number,
  expectedSkills: number,
): void {
  const charge = loadChargePolicyConfig(dataDir, { seedDir: '/owner-seeding-is-disabled' });
  const skills = loadSkillsConfig(dataDir, { seedDir: '/owner-seeding-is-disabled' });
  if (charge.runChargeQuotaByLane.interactive !== expectedCharge) {
    throw new Error(
      `Unexpected interactive charge quota in ${dataDir}: ${charge.runChargeQuotaByLane.interactive}`,
    );
  }
  if (skills.maxLoadedSkills !== expectedSkills) {
    throw new Error(`Unexpected maxLoadedSkills in ${dataDir}: ${skills.maxLoadedSkills}`);
  }
}

async function legacyServer(options: CliOptions): Promise<void> {
  const systemDataDir = one(options, '--system-data-dir');
  const companionDataDirs = many(options, '--companion-data-dir');
  assertOwnerValues(
    systemDataDir,
    integer(options, '--expected-charge'),
    integer(options, '--expected-skills'),
  );
  for (const companionDataDir of companionDataDirs) {
    for (const ownerFile of ['charge-policy.json', 'skills.json']) {
      if (existsSync(join(companionDataDir, ownerFile))) {
        throw new Error(`Legacy release unexpectedly found companion owner: ${companionDataDir}/${ownerFile}`);
      }
    }
  }
  const port = integer(options, '--listen-port');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ready\n');
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolvePromise);
  });
  console.log(JSON.stringify({ status: 'legacy-ready', port }));
}

async function companionProbe(options: CliOptions): Promise<void> {
  const companionDataDir = one(options, '--companion-data-dir');
  const companionId = one(options, '--companion-id');
  const participants = one(options, '--participants').split(',').filter(Boolean);
  if (!participants.includes(companionId) || new Set(participants).size !== participants.length) {
    throw new Error('--participants must contain unique IDs including --companion-id');
  }
  const initialCharge = integer(options, '--expected-initial-charge');
  const initialSkills = integer(options, '--expected-initial-skills');
  const expectedIdentitySha256 = one(options, '--expected-identity-sha256');
  if (!/^[a-f0-9]{64}$/u.test(expectedIdentitySha256)) {
    throw new Error('--expected-identity-sha256 must be an exact lowercase SHA-256');
  }
  const barrierDir = one(options, '--barrier-dir');
  const timeoutMs = integer(options, '--timeout-seconds') * 1_000;
  assertOwnerValues(companionDataDir, initialCharge, initialSkills);
  const observedIdentitySha256 = createHash('sha256')
    .update(readFileSync(join(companionDataDir, 'companion.json')))
    .digest('hex');
  if (observedIdentitySha256 !== expectedIdentitySha256) {
    throw new Error(`Companion root identity digest mismatch for ${companionId}`);
  }
  const ownerIdentity = (ownerFile: string) => {
    const path = join(companionDataDir, ownerFile);
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) {
      throw new Error(`Owner probe requires a regular file: ${path}`);
    }
    return {
      path,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      links: stats.nlink.toString(),
    };
  };
  const observation = {
    companionId,
    companionDataDir,
    expectedIdentitySha256,
    charge: ownerIdentity('charge-policy.json'),
    skills: ownerIdentity('skills.json'),
  };
  mkdirSync(barrierDir, { recursive: true });
  writeFileSync(
    join(barrierDir, `${basename(companionId)}.ready`),
    `${JSON.stringify(observation)}\n`,
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  const deadline = Date.now() + timeoutMs;
  while (participants.some(participant => !existsSync(join(barrierDir, `${basename(participant)}.ready`)))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for all companion probes');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  const observations = participants.map(participant => JSON.parse(readFileSync(
    join(barrierDir, `${basename(participant)}.ready`),
    'utf8',
  )) as typeof observation);
  for (const field of ['companionDataDir', 'expectedIdentitySha256'] as const) {
    if (new Set(observations.map(value => value[field])).size !== observations.length) {
      throw new Error(`Companion probes observed a shared ${field}`);
    }
  }
  for (const owner of ['charge', 'skills'] as const) {
    const identities = observations.map(value => (
      `${value[owner].device}:${value[owner].inode}`
    ));
    if (new Set(identities).size !== observations.length) {
      throw new Error(`Companion probes observed a shared ${owner} owner inode`);
    }
  }
  console.log(JSON.stringify({
    status: 'companion-ready',
    companionId,
    companionDataDir,
    expectedIdentitySha256,
  }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'seed-legacy') return seedLegacy(options);
  if (options.mode === 'legacy-server') return legacyServer(options);
  return companionProbe(options);
}

main().catch(error => {
  console.error(`Owner upgrade readiness probe failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
