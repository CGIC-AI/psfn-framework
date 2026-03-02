import { describe, expect, it } from 'vitest';
import { AdminChatBootstrapService } from './bootstrap.js';

describe('AdminChatBootstrapService', () => {
  it('uses global latest session id for default transport when available', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('123456789012345678');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('123456789012345678');
    // Global default should not force a Garden contact remap by itself.
    expect(payload.selectedIdentity.channel).toBe('api');
    expect(payload.selectedIdentity.userId).toBe('admin-user');
  });

  it('falls back to selected identity session id when no global default exists', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => null,
    });

    const payload = service.buildBootstrap();

    expect(payload.defaultSessionId).toBe('api:admin-user');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:admin-user');
  });

  it('keeps explicit operator-selected identity as default session', () => {
    const service = new AdminChatBootstrapService(null, {
      resolveGlobalDefaultSessionId: () => '123456789012345678',
    });

    const payload = service.updateSelection({
      channel: 'api',
      userId: 'operator-7',
    });

    expect(payload.defaultSessionId).toBe('api:operator-7');
    expect(payload.runtime.transportHeaders['X-Session-ID']).toBe('api:operator-7');
  });
});
