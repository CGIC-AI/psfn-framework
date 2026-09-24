import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Charter god-file tolerance for the GatewayServer composition facade
// (psfn-framework-emh3p.9). Lower it as the facade shrinks; never raise it.
const GATEWAY_SERVER_FACADE_LINE_LIMIT = 1_500;

const LIFECYCLE_MODULES = [
  'agent-request-routing',
  'audit-trail',
  'companion-message-lane',
  'companion-violations',
  'connection-admission',
  'connection-lifecycle',
  'connection-routing',
  'connection-scope',
  'icp-invalidation-queue',
  'inbound-channel-delivery',
  'rpc-method-registration',
  'shared-satellite-orchestration',
  'topology-validation',
] as const;

// Domain primitives that belong to the extracted modules. The facade composes
// the modules; it must not re-absorb their implementation.
const FACADE_FORBIDDEN_MARKERS = [
  'new SharedSatelliteResponseArbiter(',
  'new GatewayInboundChannelReplay(',
  'parseCompanionMessageSendParams(',
  'registerGatewayMethods(',
  'registerGatewayIcpAutonomyRpc(',
  'verifyCompanionAuthToken(',
  'GATEWAY_CONNECTION_STATE_TRANSITIONS',
  'requestAgentVoiceStream({',
  'resolveConfiguredGatewayCompanion(',
  "addMethod('",
] as const;

function readGatewaySource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('GatewayServer lifecycle-module decomposition', () => {
  it('keeps the composition facade below the charter god-file tolerance', () => {
    const lineCount = readGatewaySource('./server.ts').split('\n').length;

    expect(lineCount).toBeLessThan(GATEWAY_SERVER_FACADE_LINE_LIMIT);
  });

  it('wires every lifecycle module from the facade', () => {
    const facade = readGatewaySource('./server.ts');

    for (const moduleName of LIFECYCLE_MODULES) {
      expect(facade).toContain(`from './server/${moduleName}.js'`);
    }
  });

  it('does not re-absorb extracted domain logic into the facade', () => {
    const facade = readGatewaySource('./server.ts');

    for (const marker of FACADE_FORBIDDEN_MARKERS) {
      expect(facade).not.toContain(marker);
    }
  });

  it('keeps extracted modules independent of the GatewayServer facade', () => {
    const moduleDirectory = fileURLToPath(new URL('./server/', import.meta.url));
    const moduleFiles = readdirSync(moduleDirectory)
      .filter(fileName => fileName.endsWith('.ts') && !fileName.endsWith('.test.ts'));

    expect(moduleFiles.length).toBeGreaterThan(0);
    for (const fileName of moduleFiles) {
      const source = readGatewaySource(`./server/${fileName}`);
      expect(source, fileName).not.toMatch(/from '\.\.\/server\.js'/);
    }
  });
});
