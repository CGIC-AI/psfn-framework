import { describe, expect, it } from 'vitest';
import type { CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  hasUniqueSchemas,
  summarizeCompanionFleet,
} from './multi-companion-e2e.js';

function makeFleet(): CompanionsFleetConfig {
  return {
    companions: [
      {
        companionId: '11111111-1111-4111-8111-111111111111',
        companionDataDir: 'companions/flagship',
        characterCardPath: 'companions/flagship/character-card.json',
        postgresSchema: 'companion_flagship',
        gardenPort: 10061,
      },
      {
        companionId: '22222222-2222-4222-8222-222222222222',
        companionDataDir: 'companions/aria',
        characterCardPath: 'companions/aria/character-card.json',
        postgresSchema: 'companion_aria',
        // no gardenPort — headless companion
      },
    ],
  };
}

describe('summarizeCompanionFleet', () => {
  it('reduces the fleet to its e2e-relevant fields in manifest order', () => {
    const summary = summarizeCompanionFleet(makeFleet());
    expect(summary.companionCount).toBe(2);
    expect(summary.schemas).toEqual(['companion_flagship', 'companion_aria']);
    expect(summary.companionIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('omits companions without a declared gardenPort', () => {
    const summary = summarizeCompanionFleet(makeFleet());
    expect(summary.gardenPorts).toEqual([10061]);
  });
});

describe('hasUniqueSchemas', () => {
  it('is true when every companion has a distinct schema', () => {
    expect(hasUniqueSchemas(summarizeCompanionFleet(makeFleet()))).toBe(true);
  });

  it('is false when two companions share a schema', () => {
    const fleet = makeFleet();
    fleet.companions[1].postgresSchema = fleet.companions[0].postgresSchema;
    expect(hasUniqueSchemas(summarizeCompanionFleet(fleet))).toBe(false);
  });
});
