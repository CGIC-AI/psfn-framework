import { describe, expect, it } from 'vitest';
import { HUB_WS_ENV_NAME, readCompanionUiRuntimeConfig } from './config.js';

describe('companion UI runtime config', () => {
  it('requires the Satellite Hub websocket URL', () => {
    expect(() => readCompanionUiRuntimeConfig({})).toThrow(HUB_WS_ENV_NAME);
  });

  it('trims configured hub websocket URL', () => {
    expect(readCompanionUiRuntimeConfig({
      VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL: '  ws://hub.local:8787/  ',
    })).toEqual({ hubWsUrl: 'ws://hub.local:8787/' });
  });
});
