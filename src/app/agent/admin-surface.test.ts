import { describe, expect, it } from 'vitest';
import { isAdminTransportRequested } from './admin-surface.js';

describe('agent admin transport enablement', () => {
  it('starts an explicitly configured Unix socket without requiring a fake TCP port', () => {
    expect(isAdminTransportRequested(undefined, {
      ADMIN_TRANSPORT_MODE: 'socket',
      ADMIN_TRANSPORT_SOCKET: '/run/psfn/garden-admin-companion.sock',
    })).toBe(true);
  });

  it('keeps the implicit socket transport disabled when no admin surface was requested', () => {
    expect(isAdminTransportRequested(undefined, {})).toBe(false);
  });

  it('preserves the legacy ADMIN_PORT enablement signal', () => {
    expect(isAdminTransportRequested(3001, {})).toBe(true);
  });
});
