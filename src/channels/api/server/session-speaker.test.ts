import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { SatelliteRoutingMetadata } from '../../../shared/contracts/satellite-registry.js';
import { buildSubstrateMessage } from './session.js';

// S13 MOVE: a relayed world participant the world flags as an AI enters the
// turn with the same machine-intelligence marker Discord bots carry, so the
// existing contact auto-tagging and companion fatigue budget apply. A human
// speaker carries no marker.
function satellite(kind: 'human' | 'ai' | undefined): SatelliteRoutingMetadata {
  return fromPartial<SatelliteRoutingMetadata>({
    schemaVersion: 1,
    satelliteId: 'eidoverse-world',
    endpointId: 'eidoverse-avatar',
    claimType: 'world-avatar',
    sessionId: 'session-1',
    ...(kind ? { speaker: { id: 'who', name: 'who', kind } } : {}),
  });
}

function build(kind: 'human' | 'ai' | undefined) {
  return buildSubstrateMessage({
    channelId: 'satellite:world-avatar:session-1',
    channelType: 'api',
    source: 'satellite',
    content: 'hello',
    authorId: kind ? `primary-user:who` : 'primary-user',
    authorName: 'who',
    req: fromPartial<IncomingMessage>({ headers: {} }),
    overrides: {},
    satellite: satellite(kind),
  });
}

describe('satellite speaker → machine-intelligence routing marker', () => {
  it('marks an ai-flagged world speaker as machine intelligence', () => {
    const message = build('ai');
    expect(message.routing?.authorIsMachineIntelligence).toBe(true);
    expect(message.authorId).toBe('primary-user:who');
  });

  it('leaves a human-flagged speaker and a default-identity turn unmarked', () => {
    expect(build('human').routing?.authorIsMachineIntelligence).toBeUndefined();
    expect(build(undefined).routing?.authorIsMachineIntelligence).toBeUndefined();
  });
});
