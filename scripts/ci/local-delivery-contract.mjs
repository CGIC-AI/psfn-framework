const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

export const LOCAL_GATE_SCHEMA_VERSION = 1;
export const REMOTE_ATTESTATION_CONTEXT = 'local-gate/v1';

function assertSha(value, name) {
  if (!SHA.test(value)) throw new Error(`${name} must be a lowercase 40-character git SHA`);
}

export function createAttestation({ head, base, baseRef, gates }) {
  assertSha(head, 'head');
  assertSha(base, 'base');
  if (!baseRef) throw new Error('baseRef is required');
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('gates must be non-empty');
  return {
    schemaVersion: LOCAL_GATE_SCHEMA_VERSION,
    head,
    base,
    baseRef,
    gates: [...gates],
    completedAt: new Date().toISOString(),
  };
}

export function validateAttestation(attestation, { head, base, gates }) {
  if (!attestation || attestation.schemaVersion !== LOCAL_GATE_SCHEMA_VERSION) {
    return { valid: false, reason: 'Local gate attestation schema is missing or unsupported.' };
  }
  if (attestation.head !== head) {
    return { valid: false, reason: 'Local gate attestation head does not match the exact HEAD.' };
  }
  if (attestation.base !== base) {
    return { valid: false, reason: 'Local gate attestation base is stale.' };
  }
  if (!Array.isArray(gates) || JSON.stringify(attestation.gates) !== JSON.stringify(gates)) {
    return { valid: false, reason: 'Local gate attestation does not contain the exact gate plan.' };
  }
  return { valid: true, reason: '' };
}

export function validateRemoteAttestation(statuses, base) {
  assertSha(base, 'base');
  const expectedDescription = `base=${base}`;
  const status = statuses.find(({ context }) => context === REMOTE_ATTESTATION_CONTEXT);
  if (!status) throw new Error(`Missing ${REMOTE_ATTESTATION_CONTEXT} commit status`);
  if (status.state !== 'success' || status.description !== expectedDescription) {
    throw new Error(`${REMOTE_ATTESTATION_CONTEXT} does not attest the exact base`);
  }
  return status;
}

export function parsePrePushUpdates(input) {
  return input
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        throw new Error(`Malformed pre-push update: ${line}`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export function planPrePush({
  updates,
  head,
  currentBranch,
  attestationValid,
  gateActive,
}) {
  const branchUpdates = updates.filter(
    ({ localSha, remoteRef }) => localSha !== ZERO_SHA && remoteRef.startsWith('refs/heads/'),
  );
  if (branchUpdates.length === 0) {
    return { action: 'allow', reason: 'No branch update requires validation.' };
  }
  if (branchUpdates.some(({ remoteRef }) => remoteRef === 'refs/heads/main')) {
    return { action: 'block', reason: 'Direct pushes to main are prohibited.' };
  }
  if (
    branchUpdates.length !== 1 ||
    branchUpdates[0].localSha !== head ||
    branchUpdates[0].remoteRef !== `refs/heads/${currentBranch}`
  ) {
    return {
      action: 'block',
      reason: 'Push exactly the checked-out branch HEAD so the local attestation is unambiguous.',
    };
  }
  if (attestationValid) {
    return { action: 'allow', reason: 'Exact-HEAD local gate attestation is current.' };
  }
  if (gateActive) {
    return {
      action: 'block',
      reason: 'Local gate recursion detected without a valid exact-HEAD attestation.',
    };
  }
  return { action: 'run-gate', reason: 'Exact-HEAD local gate attestation is missing or stale.' };
}

function command(name, executable, args, options = {}) {
  return { name, executable, args, ...options };
}

export function buildGatePlan({ paths, base = 'origin/main', head = 'HEAD' }) {
  const matches = (pattern) => paths.some((path) => pattern.test(path));
  const ubsPaths = paths.filter((path) => /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(path));
  const workflowPaths = paths.filter((path) =>
    /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/.test(path),
  );
  const plan = [
    command('ci-rules', 'npm', ['run', 'test:ci-rules']),
    command('change-budget', 'npm', [
      'run',
      'verify:change-budget',
      '--',
      '--base',
      base,
      '--head',
      head,
    ]),
    command('lint', 'npm', ['run', 'lint'], { nodeHeapMb: 4096 }),
    command('build', 'npm', ['run', 'build'], { nodeHeapMb: 4096 }),
    command('typecheck', 'npm', ['run', 'verify:typecheck-baseline'], { nodeHeapMb: 4096 }),
    command('repository-hygiene', 'npm', ['run', 'verify:repository-hygiene']),
    command('semgrep-rules', 'npm', ['run', 'semgrep:test']),
    command('semgrep-diff', 'npm', ['run', 'semgrep:diff', '--', base]),
    command('ubs', 'ubs', ['--no-auto-update', ...ubsPaths], { skip: ubsPaths.length === 0 }),
    command('tests', 'npm', ['test']),
  ];

  if (
    matches(
      /^(?:\.env\.example|src\/shared\/contracts\/runtime\.ts|src\/system\/config\/|src\/system\/settings(?:\.ts|\/)|src\/operator\/garden\/.*settings|admin-ui\/src\/.*settings)/,
    )
  ) {
    plan.push(command('settings-contract', 'npm', ['run', 'verify:settings-contract']));
  }
  if (
    matches(
      /(?:^|\/)package(?:-lock)?\.json$|(?:^|\/)Dockerfile[^/]*$|^\.github\/workflows\/|^deploy\/helm\/|^scripts\/verify-supply-chain\./,
    )
  ) {
    plan.push(
      command('supply-chain', 'npm', ['run', 'verify:supply-chain', '--', '--ref', base]),
    );
  }
  if (matches(/^(?:deploy\/helm\/|docker\/|scripts\/(?:verify-(?:helm|k8s|kube)|ops\/ship-kube))/)) {
    plan.push(
      command('deployment-contracts', 'npm', ['run', 'verify:deployment-contracts']),
    );
  }
  if (matches(/^admin-ui\//)) {
    plan.push(command('garden-ui', 'npm', ['run', 'verify:garden-ui']));
  }
  if (matches(/^companion-ui\//)) {
    plan.push(command('companion-ui', 'npm', ['run', 'verify:companion-ui']));
  }
  if (matches(/^\.github\/(?:workflows\/|actions\/)|^\.github\/dependabot\.yml$/)) {
    plan.push(
      command('changed-workflow-analysis', 'node', [
        'scripts/ci/run-zizmor-changed.mjs',
        ...workflowPaths,
      ]),
    );
  }
  return plan;
}

export function assessHookInstallation({ hooksPath, existingHooks }) {
  if (hooksPath && hooksPath !== '.githooks') {
    return {
      allowed: false,
      reason: `Refusing to replace custom hooksPath: ${hooksPath}`,
    };
  }
  if (!hooksPath && existingHooks.length > 0) {
    return {
      allowed: false,
      reason: `Refusing to disable existing hooks: ${existingHooks.join(', ')}`,
    };
  }
  return { allowed: true, reason: '' };
}

export function evaluateRequiredChecks({ expectedHead, actualHead, checks }) {
  if (actualHead !== expectedHead) {
    return {
      state: 'failed',
      reason: `PR head changed from ${expectedHead.slice(0, 12)} to ${actualHead.slice(0, 12)} while waiting.`,
    };
  }

  for (const requiredName of ['ci-required', 'Greptile Review']) {
    const check = checks.find(({ name }) => name === requiredName);
    if (!check || check.status !== 'COMPLETED') {
      return { state: 'pending', reason: `${requiredName} has not completed.` };
    }
    if (check.conclusion !== 'SUCCESS') {
      return {
        state: 'failed',
        reason: `${requiredName} concluded ${check.conclusion || 'without a result'}.`,
      };
    }
  }
  return { state: 'passed', reason: 'ci-required and Greptile Review passed.' };
}
