import { describe, expect, it } from 'vitest';
import {
  buildPublicAdoptionPlan,
  type PublicAdoptionInventory,
} from './public-adoption.js';

function fixtureInventory(): PublicAdoptionInventory {
  return {
    sourceSchema: 'public',
    objects: [
      {
        kind: 'view',
        name: 'flagship_contacts_view',
        definitionChecksum: 'c'.repeat(64),
        rowCount: 2,
        dataChecksum: '3'.repeat(32),
        definition: 'SELECT id, display_name FROM public.flagship_contacts;',
      },
      {
        kind: 'table',
        name: 'flagship_contacts',
        definitionChecksum: 'b'.repeat(64),
        rowCount: 2,
        dataChecksum: '2'.repeat(32),
        columnDefaults: [{
          column: 'id',
          expression: "nextval('public.flagship_contacts_id_seq'::regclass)",
        }],
        foreignKeys: [{
          name: 'flagship_contacts_parent_id_fkey',
          definition: 'FOREIGN KEY (parent_id) REFERENCES public.flagship_contacts(id)',
        }],
      },
      {
        kind: 'sequence',
        name: 'flagship_contacts_id_seq',
        definitionChecksum: 'a'.repeat(64),
        rowCount: 1,
        dataChecksum: '1'.repeat(64),
        startValue: '1',
        minValue: '1',
        maxValue: '9223372036854775807',
        incrementBy: '1',
        cacheSize: '1',
        cycle: false,
        lastValue: '2',
        isCalled: true,
        ownedBy: { table: 'flagship_contacts', column: 'id' },
      },
    ],
  };
}

describe('public-to-flagship Postgres adoption planning', () => {
  it('is pure, deterministic, ordered, and carries rollback evidence', () => {
    const inventory = fixtureInventory();
    const first = buildPublicAdoptionPlan(inventory, 'companion_flagship');
    const second = buildPublicAdoptionPlan(
      { ...inventory, objects: [...inventory.objects].reverse() },
      'companion_flagship',
    );
    expect(second).toEqual(first);
    expect(first.objects.map(object => `${object.kind}:${object.name}`)).toEqual([
      'sequence:flagship_contacts_id_seq',
      'table:flagship_contacts',
      'view:flagship_contacts_view',
    ]);
    expect(first.planChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.rollback).toEqual({
      metadataSchema: 'psfn_admin',
      sourceSchema: 'public',
      targetSchema: 'companion_flagship',
      sourcePreserved: true,
      rollbackAction: 'drop_target_schema',
    });
  });

  it('changes the manifest checksum when count/checksum evidence changes', () => {
    const original = fixtureInventory();
    const changed = fixtureInventory();
    const table = changed.objects.find(object => object.kind === 'table');
    if (!table) throw new Error('test fixture table missing');
    table.rowCount += 1;
    expect(buildPublicAdoptionPlan(changed, 'companion_flagship').planChecksum)
      .not.toBe(buildPublicAdoptionPlan(original, 'companion_flagship').planChecksum);
  });

  it('rejects reserved targets, duplicate objects, and invalid identifiers', () => {
    expect(() => buildPublicAdoptionPlan(fixtureInventory(), 'public')).toThrow('reserved');
    const duplicate = fixtureInventory();
    duplicate.objects.push({ ...duplicate.objects[0] });
    expect(() => buildPublicAdoptionPlan(duplicate, 'companion_flagship')).toThrow('repeats');
    expect(() => buildPublicAdoptionPlan(fixtureInventory(), 'companion-flagship'))
      .toThrow('Invalid Postgres schema name');
  });
});
