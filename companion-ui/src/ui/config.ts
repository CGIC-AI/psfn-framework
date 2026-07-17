const COMPANION_UI_PREFIX = '/companion-ui/';

export interface CompanionUiRuntimeConfig {
  readonly origin: string;
  readonly sessionStatusPath: '/v1/fleet-auth/session/status';
  readonly loginPath: '/v1/fleet-auth/login?return_to=%2Fcompanion-ui%2F';
}

export function readCompanionUiRuntimeConfig(
  location: Pick<Location, 'hostname' | 'origin' | 'pathname' | 'protocol'> = window.location,
): CompanionUiRuntimeConfig {
  const localDevelopment = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
    && location.protocol === 'http:';
  if ((!localDevelopment && location.protocol !== 'https:')
    || !location.pathname.startsWith(COMPANION_UI_PREFIX)
    || new URL(location.origin).origin !== location.origin) {
    throw new Error('Companion UI must run at the canonical same-origin /companion-ui/ HTTPS path');
  }
  return Object.freeze({
    origin: location.origin,
    sessionStatusPath: '/v1/fleet-auth/session/status',
    loginPath: '/v1/fleet-auth/login?return_to=%2Fcompanion-ui%2F',
  });
}

export function resolveCompanionUiWebSocketUrl(
  websocketPath: string,
  location: Pick<Location, 'host' | 'hostname' | 'protocol'> = window.location,
): string {
  if (!/^\/companion-ui\/companions\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/ws$/u
    .test(websocketPath)) {
    throw new Error('Companion UI WebSocket path is not an exact server-issued path');
  }
  const localDevelopment = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
    && location.protocol === 'http:';
  if (!localDevelopment && location.protocol !== 'https:') {
    throw new Error('Companion UI WebSocket requires the canonical HTTPS origin');
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${websocketPath}`;
}
