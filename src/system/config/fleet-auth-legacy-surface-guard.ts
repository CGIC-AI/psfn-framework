export function assertFleetAuthLegacySurfacesUnavailable(options: {
  fleetAuthEnabled: boolean;
  processMode: 'gateway' | 'operator';
  env: NodeJS.ProcessEnv;
  principalAuthenticationWired?: boolean;
  fleetAuthBootstrapRoutesWired?: boolean;
}): void {
  if (!options.fleetAuthEnabled) return;
  const exposesGatewayApi = options.processMode === 'gateway'
    && Boolean(options.env.API_PORT?.trim());
  const exposesLegacyGardenCredentials = options.principalAuthenticationWired !== true
    && (Boolean(options.env.ADMIN_TOKEN?.trim())
      || options.env.ADMIN_ALLOW_INSECURE === 'true');
  const exposesUnprotectedOperator = options.processMode === 'operator'
    && options.principalAuthenticationWired !== true;
  const gatewayApiProtected = options.principalAuthenticationWired === true
    || options.fleetAuthBootstrapRoutesWired === true;
  if (exposesLegacyGardenCredentials || exposesUnprotectedOperator
    || (exposesGatewayApi && !gatewayApiProtected)) {
    throw new Error(
      'Fleet auth enabled mode rejects legacy Garden/API token, cookie, HTTP, and WebSocket '
      + 'surfaces before listen until bootstrap-only routes or principal authentication are wired',
    );
  }
}
