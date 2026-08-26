const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

export const LOCAL_GATE_SCHEMA_VERSION = 3;
export const REMOTE_ATTESTATION_CONTEXT = 'local-gate/v1';

// Identity of gate semantics and command shapes. Bump this whenever the
// planner changes what a pass means so old stages and attestations rerun.
export const GATE_VERSION = 10;
export const STAGE_SCHEMA_VERSION = 2;

function assertSha(value, name) {
  if (!SHA.test(value)) throw new Error(`${name} must be a lowercase 40-character git SHA`);
}

export function createAttestation({ head, base, baseRef, gates, gatePlan = gates }) {
  assertSha(head, 'head');
  assertSha(base, 'base');
  if (!baseRef) throw new Error('baseRef is required');
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('gates must be non-empty');
  if (!Array.isArray(gatePlan) || gatePlan.length !== gates.length) {
    throw new Error('gatePlan must contain one command identity for every gate');
  }
  return {
    schemaVersion: LOCAL_GATE_SCHEMA_VERSION,
    gateVersion: GATE_VERSION,
    head,
    base,
    baseRef,
    gates: [...gates],
    gatePlan: [...gatePlan],
    completedAt: new Date().toISOString(),
  };
}

export function validateAttestation(attestation, {
  head,
  base,
  gates,
  gatePlan = gates,
  gateVersion = GATE_VERSION,
}) {
  if (!attestation || attestation.schemaVersion !== LOCAL_GATE_SCHEMA_VERSION) {
    return { valid: false, reason: 'Local gate attestation schema is missing or unsupported.' };
  }
  if (attestation.gateVersion !== gateVersion) {
    return { valid: false, reason: 'Local gate attestation gate version is stale.' };
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
  if (!Array.isArray(gatePlan) || JSON.stringify(attestation.gatePlan) !== JSON.stringify(gatePlan)) {
    return {
      valid: false,
      reason: 'Local gate attestation does not contain the exact gate command plan.',
    };
  }
  return { valid: true, reason: '' };
}

export function createCanaryAttestation({ base, mainRef }) {
  assertSha(base, 'base');
  if (!mainRef) throw new Error('mainRef is required');
  return {
    schemaVersion: LOCAL_GATE_SCHEMA_VERSION,
    kind: 'canary',
    gateVersion: GATE_VERSION,
    base,
    mainRef,
    completedAt: new Date().toISOString(),
  };
}

export function gateCommandString(gate) {
  return `${gate.executable} ${gate.args.join(' ')}`;
}

export function isStageReusable(record, {
  head,
  base,
  gateVersion,
  command,
  inputHash = null,
  name,
}) {
  return Boolean(
    record
      && record.schemaVersion === STAGE_SCHEMA_VERSION
      && record.gateVersion === gateVersion
      && record.base === base
      && record.command === command
      && (!name || record.name === name)
      && (inputHash ? record.inputHash === inputHash : record.head === head),
  );
}

export function validateRemoteAttestation(statuses, base, expectedActor) {
  assertSha(base, 'base');
  if (!expectedActor) throw new Error('Trusted local-gate status issuer is not configured');
  const expectedDescription = `base=${base}`;
  const status = statuses.find(({ context }) => context === REMOTE_ATTESTATION_CONTEXT);
  if (!status) throw new Error(`Missing ${REMOTE_ATTESTATION_CONTEXT} commit status`);
  if (status.creator?.login !== expectedActor) {
    throw new Error(`${REMOTE_ATTESTATION_CONTEXT} was not created by the trusted issuer`);
  }
  if (status.state !== 'success' || status.description !== expectedDescription) {
    throw new Error(`${REMOTE_ATTESTATION_CONTEXT} does not attest the exact base`);
  }
  return status;
}

export function buildValidatedPushRefspec(head, branch) {
  assertSha(head, 'head');
  if (!branch || branch === 'main' || /\s/.test(branch)) {
    throw new Error('A valid PR branch is required for the attested push');
  }
  return `${head}:refs/heads/${branch}`;
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
  isAncestor,
  attestedPublication = false,
}) {
  const branchUpdates = updates.filter(({ remoteRef }) => remoteRef.startsWith('refs/heads/'));
  if (branchUpdates.length === 0) {
    return { action: 'allow', reason: 'No branch update requires validation.' };
  }
  if (branchUpdates.some(({ remoteRef }) => remoteRef === 'refs/heads/main')) {
    return { action: 'block', reason: 'Direct pushes to main are prohibited.' };
  }
  if (branchUpdates.some(({ localSha }) => localSha === ZERO_SHA)) {
    return {
      action: 'block',
      reason: 'Remote branch deletions are prohibited; preserve pushed checkpoints.',
    };
  }
  if (
    branchUpdates.length !== 1
    || branchUpdates[0].localSha !== head
    || branchUpdates[0].remoteRef !== `refs/heads/${currentBranch}`
  ) {
    return {
      action: 'block',
      reason: 'Push exactly the checked-out branch HEAD to its same-name remote branch.',
    };
  }
  const [{ localSha, remoteSha }] = branchUpdates;
  if (remoteSha !== ZERO_SHA && !isAncestor(remoteSha, localSha)) {
    if (attestedPublication) {
      return {
        action: 'allow',
        reason: 'Exact-head attested publication may update the branch with force-with-lease.',
      };
    }
    return {
      action: 'block',
      reason: 'Non-fast-forward checkpoint pushes are prohibited; pull/rebase without rewriting shared history.',
    };
  }
  return {
    action: 'allow',
    reason: 'Checkpoint push is a fast-forward update of the checked-out non-main branch.',
  };
}

export function evaluateRequiredChecks({
  expectedHead,
  actualHead,
  checks,
  requireGreptile = false,
}) {
  if (actualHead !== expectedHead) {
    return {
      state: 'failed',
      reason: `PR head changed from ${expectedHead.slice(0, 12)} to ${actualHead.slice(0, 12)} while waiting.`,
    };
  }

  const requiredChecks = ['ci-required', ...(requireGreptile ? ['Greptile Review'] : [])];
  for (const requiredName of requiredChecks) {
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
  return { state: 'passed', reason: `${requiredChecks.join(' and ')} passed.` };
}
