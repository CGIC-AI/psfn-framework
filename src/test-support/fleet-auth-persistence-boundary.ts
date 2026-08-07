import { expect } from 'vitest';

const testPath = expect.getState().testPath;

if (testPath?.includes('/persistence/postgres/fleet-auth/')) {
  const { installGatewayFleetAuthPersistenceBoundary } = await import(
    '../app/gateway/fleet-auth-persistence-boundary.js'
  );
  installGatewayFleetAuthPersistenceBoundary();
}
