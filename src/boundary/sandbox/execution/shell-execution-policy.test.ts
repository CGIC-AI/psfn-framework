import { describe, expect, it } from 'vitest';
import { isShellExecutableNetworkAllowed } from './shell-execution-policy.js';

describe('isShellExecutableNetworkAllowed', () => {
  const sandboxPath = '/usr/local/bin:/usr/bin:/bin';

  it('matches only the resolved top-level executable', () => {
    expect(isShellExecutableNetworkAllowed('/usr/bin/bash', ['bash'], sandboxPath)).toBe(true);
    expect(isShellExecutableNetworkAllowed('/usr/bin/bash', ['multica'], sandboxPath)).toBe(false);
  });

  it('accepts an exact canonical path and rejects a same-name executable outside the image path', () => {
    expect(isShellExecutableNetworkAllowed('/usr/bin/bash', ['/usr/bin/bash'], sandboxPath)).toBe(true);
    expect(isShellExecutableNetworkAllowed('/workspace/bash', ['bash'], sandboxPath)).toBe(false);
  });
});
