export function assertFleetAuthLegacySurfacesUnavailable(options: {
  fleetAuthEnabled: boolean;
  processMode: 'gateway' | 'operator';
  env: NodeJS.ProcessEnv;
}): void {
  if (!options.fleetAuthEnabled) return;
  const exposesGatewayApi = options.processMode === 'gateway'
    && Boolean(options.env.API_PORT?.trim());
  const exposesGarden = options.processMode === 'operator'
    || Boolean(options.env.ADMIN_PORT?.trim())
    || Boolean(options.env.ADMIN_TOKEN?.trim())
    || options.env.ADMIN_ALLOW_INSECURE === 'true';
  if (exposesGatewayApi || exposesGarden) {
    throw new Error(
      'Fleet auth enabled mode rejects legacy Garden/API token, cookie, HTTP, and WebSocket '
      + 'surfaces before listen until principal authentication is wired',
    );
  }
}
