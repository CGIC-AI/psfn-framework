import { describe, expect, it } from 'vitest';
import { buildShellExecPolicyConfig } from './shell-policy-config.js';

describe('buildShellExecPolicyConfig', () => {
  it('keeps the CLI disabled unless the operator explicitly enables it', () => {
    expect(buildShellExecPolicyConfig({})).toMatchObject({
      enabled: false,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 30_000,
      defaultMaxOutputChars: 20_000,
      maxOutputChars: 100_000,
    });
  });

  it('loads the explicit namespace sandbox and bounded command policy', () => {
    expect(buildShellExecPolicyConfig({
      SHELL_EXEC_ENABLED: 'true',
      SHELL_EXEC_ALLOWLIST: 'bash,rg',
      SHELL_EXEC_ENV_ALLOWLIST: 'SAFE_VALUE',
      SHELL_EXEC_ALLOWED_CWD: '/app/workspace,/app/workspace/docs',
      SHELL_EXEC_PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL_EXEC_DEFAULT_TIMEOUT_MS: '7000',
      SHELL_EXEC_MAX_TIMEOUT_MS: '45000',
      SHELL_EXEC_DEFAULT_MAX_OUTPUT_CHARS: '30000',
      SHELL_EXEC_MAX_OUTPUT_CHARS: '120000',
    })).toEqual({
      enabled: true,
      allowlist: ['bash', 'rg'],
      envAllowlist: ['SAFE_VALUE'],
      allowedCwd: ['/app/workspace', '/app/workspace/docs'],
      pathOverride: '/usr/local/bin:/usr/bin:/bin',
      defaultTimeoutMs: 7_000,
      maxTimeoutMs: 45_000,
      defaultMaxOutputChars: 30_000,
      maxOutputChars: 120_000,
    });
  });
});
