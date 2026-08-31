import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { InvalidEnvError, requireEnv } from './env.mjs';

const COMPACT_ASSERTION_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function createFrameworkHubDeviceAssertionIssuer({
  repoRoot,
  env = process.env,
  execFile = execFileSync,
}) {
  const systemDataDir = requireEnv(
    'SYSTEM_DATA_DIR',
    'Hub-device shakedown dispatch requires the canonical system-data root',
    env,
  );
  const privateKeyPath = requireEnv(
    'HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH',
    'Hub-device shakedown dispatch requires HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH',
    env,
  );
  const ttlText = requireEnv(
    'HUB_DEVICE_ASSERTION_TTL_SECONDS',
    'Hub-device shakedown dispatch requires HUB_DEVICE_ASSERTION_TTL_SECONDS',
    env,
  );
  if (!/^[1-9][0-9]*$/u.test(ttlText)) {
    throw new InvalidEnvError(
      'HUB_DEVICE_ASSERTION_TTL_SECONDS',
      'Hub device assertion TTL must be an integer between 5 and 60 seconds',
    );
  }
  const ttlSeconds = Number.parseInt(ttlText, 10);
  if (ttlSeconds < 5 || ttlSeconds > 60) {
    throw new InvalidEnvError(
      'HUB_DEVICE_ASSERTION_TTL_SECONDS',
      'Hub device assertion TTL must be an integer between 5 and 60 seconds',
    );
  }

  const executable = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const script = join(repoRoot, 'scripts', 'ops', 'issue-hub-device-assertion.ts');
  return ({ companionId, satelliteId, endpointId, sessionId }) => {
    let output;
    try {
      output = execFile(executable, [script], {
        encoding: 'utf8',
        input: JSON.stringify({
          fleetAuthPath: join(systemDataDir, 'fleet-auth.json'),
          satelliteRegistryPath: join(systemDataDir, 'satellites.json'),
          privateKeyPath,
          ttlSeconds,
          companionId,
          satelliteId,
          endpointId,
          sessionId,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('canonical Hub device assertion issuer failed');
    }
    const assertion = String(output).trim();
    if (assertion.length > 8192 || !COMPACT_ASSERTION_PATTERN.test(assertion)) {
      throw new Error('canonical Hub device assertion issuer returned malformed output');
    }
    return assertion;
  };
}
