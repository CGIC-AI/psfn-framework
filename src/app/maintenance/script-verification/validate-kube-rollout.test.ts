import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const gatePath = join(repoRoot, 'scripts/ops/validate-kube-rollout.sh');
const namespace = 'gate-test';
const companionId = 'test-companion';
const imageTag = 'test-tag';
const agentDeployment = `psfn-agent-${companionId}`;

/**
 * The gate is a bash script whose real inputs are kubectl responses, so the
 * only honest way to test its coverage accounting is to answer kubectl for it.
 * This shim is driven by a JSON fixture and additionally asserts that the
 * testing-harness key arrives at the gateway byte-for-byte — the exact
 * property that psfn-framework-zu0g5 broke.
 */
const FAKE_KUBECTL = String.raw`#!/usr/bin/env node
const fs = require('node:fs');

const fixture = JSON.parse(fs.readFileSync(process.env.GATE_TEST_FIXTURE, 'utf8'));
const argv = process.argv.slice(2);
const joined = argv.join(' ');
const namespace = ${JSON.stringify(namespace)};
const companionId = ${JSON.stringify(companionId)};
const imageTag = ${JSON.stringify(imageTag)};
const agentDeployment = ${JSON.stringify(agentDeployment)};

function out(text) {
  process.stdout.write(text);
  process.exit(0);
}

function fail(text) {
  process.stderr.write(text);
  process.exit(1);
}

function pod(name, containerName, ready) {
  return {
    metadata: { name },
    spec: { containers: [{ name: containerName, image: 'localhost/psfn-framework:' + imageTag }] },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [{ name: containerName, state: { running: {} } }],
    },
  };
}

const allPods = [
  pod('psfn-gateway-0', 'gateway', true),
  pod('psfn-garden-0', 'garden', true),
  pod(agentDeployment + '-0', 'agent', true),
];

if (joined.includes('get deployments') && joined.includes('fleet-target=registered')) {
  out(JSON.stringify({ items: [{ metadata: { name: agentDeployment } }] }));
}

if (joined.includes('get deploy psfn-emosim')) {
  fail('deployments.apps "psfn-emosim" not found\n');
}

if (joined.includes('get deploy psfn-garden') && joined.includes('ports[0].name')) {
  out('https-garden');
}

if (joined.includes('ports[*].hostPort')) {
  // No hostPort: the gate must reach the gateway through an in-pod exec, which
  // is how the live Pi topology behaves.
  out('');
}

if (joined.includes('COMPANION_ID')) {
  out(companionId);
}

if (argv[2] === 'rollout' && argv[3] === 'status') {
  out('deployment "' + argv[4].replace('deploy/', '') + '" successfully rolled out\n');
}

if (joined.includes('get pods') && joined.includes('component=garden')) {
  out(JSON.stringify({ items: [pod('psfn-garden-0', 'garden', true)] }));
}

if (joined.includes('get pods') && joined.includes('-o json')) {
  out(JSON.stringify({ items: allPods }));
}

if (joined.includes('cat /app/contract-hash.txt')) {
  out('contracthash01\n');
}

if (joined.includes('get deploy psfn-gateway') && joined.includes('-o json')) {
  out(
    JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'gateway',
                env: [
                  {
                    name: 'TESTING_HARNESS_API_KEY',
                    valueFrom: { secretKeyRef: { name: 'psfn-app', key: 'TESTING_HARNESS_API_KEY' } },
                  },
                ],
              },
            ],
          },
        },
      },
    }),
  );
}

if (joined.includes('get secret')) {
  const template = argv.find((arg) => arg.startsWith('go-template='));
  if (template && template.includes('range')) {
    out(Object.keys(fixture.secretData).sort().join('\n') + '\n');
  }
  if (typeof fixture.rawSecretTemplateOutput === 'string') {
    out(fixture.rawSecretTemplateOutput);
  }
  out(fixture.secretData.TESTING_HARNESS_API_KEY ?? '');
}

if (joined.includes('psql')) {
  const sql = argv[argv.length - 1];
  if (sql.includes('pg_extension')) out('vector\n');
  if (sql.includes('model_usage_events')) out('OK|litellm|litellm|model-a|model-a|1700000000000\n');
  if (sql.includes('session_messages_projection')) out('0\n');
  fail('unexpected sql: ' + sql + '\n');
}

if (joined.includes('redis-cli')) {
  out('PONG\n');
}

if (argv[2] === 'logs') {
  out('[agent] Ready — waiting for messages\n');
}

if (argv.includes('-i') && joined.includes('deploy/psfn-gateway')) {
  const stdin = fs.readFileSync(0, 'utf8');
  const newline = stdin.indexOf('\n');
  const deliveredKey = stdin.slice(0, newline);
  const script = stdin.slice(newline + 1);
  if (deliveredKey !== fixture.expectedHarnessKey) {
    fail(
      'harness key was mangled in transit: expected ' +
        JSON.stringify(fixture.expectedHarnessKey) +
        ' got ' +
        JSON.stringify(deliveredKey) +
        '\n',
    );
  }
  if (script.includes('/v1/chat/completions')) {
    out(
      JSON.stringify({
        model: companionId,
        validationUser: 'gate-test-user',
        firstStatus: 200,
        secondStatus: 200,
        secondReplyChars: 42,
      }),
    );
  }
  out(
    JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ data: [{ id: companionId }] }),
    }),
  );
}

fail('fake kubectl received an unhandled call: ' + joined + '\n');
`;

interface Fixture {
  secretData: Record<string, string>;
  expectedHarnessKey?: string;
  rawSecretTemplateOutput?: string;
}

describe('validate-kube-rollout.sh coverage accounting', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function runGate(fixture: Fixture, extraArgs: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-gate-'));
    tempDirs.push(dir);

    const kubectlPath = join(dir, 'kubectl');
    writeFileSync(kubectlPath, FAKE_KUBECTL, 'utf8');
    chmodSync(kubectlPath, 0o755);

    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');

    const emptyConfig = join(dir, 'private-ops.env');
    writeFileSync(emptyConfig, '# empty\n', 'utf8');

    return spawnSync(
      'bash',
      [gatePath, '--local', '--namespace', namespace, '--expect-tag', imageTag, ...extraArgs],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          PSFN_OPS_CONFIG: emptyConfig,
          GATE_TEST_FIXTURE: fixturePath,
        },
      },
    );
  }

  function base64(value: string) {
    return Buffer.from(value, 'utf8').toString('base64');
  }

  it('passes every planned check and delivers the harness key byte-exactly', () => {
    const key = 'sk-harness-0123456789abcdefghijklmnop';
    const result = runGate(
      { secretData: { TESTING_HARNESS_API_KEY: base64(key) }, expectedHarnessKey: key },
      ['--smoke'],
    );

    expect(result.stdout, result.stdout + result.stderr).toContain(
      'PASS testing-harness key',
    );
    expect(result.stdout).toContain('PASS gateway models');
    expect(result.stdout).toContain('PASS gateway chat smoke');
    expect(result.stdout).toMatch(
      /Summary: 12 checks planned, 12 ran; 12 passed, 0 failed, 0 skipped, 0 requested-skip, 0 not run/,
    );
    expect(result.stdout).not.toContain('COVERAGE INCOMPLETE');
    expect(result.status).toBe(0);
  });

  it('strips a CRLF tail from a secret written on Windows line endings', () => {
    const key = 'sk-harness-crlf-token';
    const result = runGate(
      { secretData: { TESTING_HARNESS_API_KEY: base64(`${key}\r\n`) }, expectedHarnessKey: key },
      ['--smoke'],
    );

    expect(result.stdout, result.stdout + result.stderr).toContain('PASS testing-harness key');
    expect(result.stdout).toContain('PASS gateway models');
    expect(result.status).toBe(0);
  });

  it('names a missing harness key and still runs every check that does not need it', () => {
    const result = runGate({ secretData: { API_KEY: base64('other') } }, ['--smoke']);

    expect(result.stdout, result.stdout + result.stderr).toContain(
      'secret/psfn-app has no data.TESTING_HARNESS_API_KEY',
    );
    expect(result.stdout).toContain('keys present: API_KEY');
    expect(result.stdout).toContain('SKIP gateway models (nothing was validated)');
    expect(result.stdout).toContain('SKIP gateway chat smoke (nothing was validated)');

    // The whole point of the bead: a failed prerequisite must not swallow the
    // checks that never needed it.
    expect(result.stdout).toContain('PASS postgres pgvector and redis');
    expect(result.stdout).toContain('PASS agent log scan');
    expect(result.stdout).toContain('PASS provider routing');
    expect(result.stdout).toContain('PASS zero bookkeeping writes');

    expect(result.stdout).toMatch(
      /Summary: 12 checks planned, 12 ran; 9 passed, 1 failed, 2 skipped/,
    );
    expect(result.stdout).toContain('SKIPPED — prerequisite failed, nothing was validated:');
    expect(result.stdout).toContain('COVERAGE INCOMPLETE: 3 of 12 planned checks did not pass.');
    expect(result.status).toBe(1);
  });

  it('rejects the Go "<no value>" sentinel instead of decoding it to mojibake', () => {
    const result = runGate({
      secretData: { TESTING_HARNESS_API_KEY: base64('unused') },
      rawSecretTemplateOutput: '<no value>',
    });

    expect(result.stdout, result.stdout + result.stderr).toContain(
      'secret/psfn-app data.TESTING_HARNESS_API_KEY is not canonical base64',
    );
    // U+FFFD is the byte-for-byte signature of the original defect.
    expect(result.stdout + result.stderr).not.toContain('�');
    expect(result.stdout).toContain('FAIL testing-harness key');
    expect(result.status).toBe(1);
  });

  it('rejects a decoded key that cannot be sent in an HTTP header', () => {
    const result = runGate({
      secretData: {
        TESTING_HARNESS_API_KEY: Buffer.from([0x73, 0x6b, 0xc3, 0x9f, 0x2d, 0x31]).toString('base64'),
      },
    });

    expect(result.stdout, result.stdout + result.stderr).toContain(
      'cannot be sent in an HTTP header: byte 2 is 0xc3',
    );
    expect(result.stdout + result.stderr).not.toContain('�');
    expect(result.status).toBe(1);
  });

  it('names every check that did not run when a gate failure aborts the plan', () => {
    const key = 'sk-harness-abort';
    const result = runGate(
      { secretData: { TESTING_HARNESS_API_KEY: base64(key) }, expectedHarnessKey: key },
      ['--smoke', '--expect-tag', 'a-tag-that-is-not-deployed'],
    );

    expect(result.stdout, result.stdout + result.stderr).toContain('FAIL app pods and images');
    expect(result.stdout).toContain(
      'NOT RUN — gate aborted after "app pods and images" failed, nothing was validated:',
    );
    expect(result.stdout).toContain('  - gateway chat smoke');
    expect(result.stdout).toContain('  - zero bookkeeping writes');
    expect(result.stdout).toMatch(/0 skipped, 0 requested-skip, 10 not run/);
    expect(result.stdout).toContain('COVERAGE INCOMPLETE');
    expect(result.status).toBe(1);
  });

  it('reports an operator-requested skip as unvalidated without failing the gate', () => {
    const key = 'sk-harness-requested';
    const result = runGate(
      { secretData: { TESTING_HARNESS_API_KEY: base64(key) }, expectedHarnessKey: key },
      ['--skip-provider-routing'],
    );

    expect(result.stdout, result.stdout + result.stderr).toContain(
      'SKIP provider routing (operator request; nothing was validated)',
    );
    expect(result.stdout).toContain('SKIPPED by operator request, nothing was validated:');
    expect(result.stdout).toContain(
      'COVERAGE REDUCED BY REQUEST: 1 of 11 planned checks validated nothing',
    );
    expect(result.stdout).not.toContain('COVERAGE INCOMPLETE');
    expect(result.status).toBe(0);
  });
});
