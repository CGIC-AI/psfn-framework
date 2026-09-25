#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import { createPostgresContactStore } from '../../core/contacts/postgres-adapter.js';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';
import type { TrustLevel } from '../../system/trust/types.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

/**
 * Canonical supported path (bead x5t4) for seeding ICP-eligible mutual sibling
 * contacts across a companion fleet. ICP initiation requires each peer as an
 * existing contact with channel='companion' identity, is_machine_intelligence=
 * true, and trust >= regular in the initiating companion's own Postgres schema.
 * Nothing in normal startup or provisioning creates these; only the e2e
 * certification harness did, by hand. This mirrors that exact sequence
 * (resolveChannelIdentity -> setMachineIntelligence -> setTrustLevel ->
 * updateRelationshipType) as an operator-invoked, idempotent maintenance CLI.
 */

const SEED_ACTOR = 'operator:seed:sibling-contacts';
// 'regular' is the ICP trust floor; 'trusted' mirrors the certification
// harness. 'public' is below the floor and 'primary' is reserved for the human
// owner, so neither is a valid sibling trust level.
const ALLOWED_SIBLING_TRUST: readonly TrustLevel[] = ['regular', 'trusted'];
const DEFAULT_SIBLING_TRUST: TrustLevel = 'regular';

interface CliOptions {
  apply: boolean;
  trust: TrustLevel;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run seed:sibling-contacts [-- OPTIONS]');
  console.log('');
  console.log('Seeds mutual ICP-eligible sibling contacts for every companion in the fleet.');
  console.log('For each ordered companion pair it creates the peer as a channel="companion",');
  console.log('is_machine_intelligence=true contact at the chosen trust level inside the');
  console.log("owning companion's Postgres schema. Idempotent and re-runnable. The default");
  console.log('mode is a read-only plan; pass --apply to write.');
  console.log('');
  console.log('Options:');
  console.log(`  --trust <level>   Sibling trust level (${ALLOWED_SIBLING_TRUST.join('|')}); default ${DEFAULT_SIBLING_TRUST}`);
  console.log('  --apply           Execute the seeding (default is a dry-run plan)');
  console.log('  -h, --help        Show this help message');
}

export function parseSiblingTrust(raw: string): TrustLevel {
  const value = raw.trim() as TrustLevel;
  if (!ALLOWED_SIBLING_TRUST.includes(value)) {
    throw new Error(`--trust must be one of ${ALLOWED_SIBLING_TRUST.join(', ')} (the ICP floor is regular)`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, trust: DEFAULT_SIBLING_TRUST, showHelp: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--trust': ({ options, readValue }) => {
        options.trust = parseSiblingTrust(readValue());
      },
    },
  });
}

/**
 * Seed one directional sibling contact: make `peerCompanionId` an ICP-eligible
 * contact inside the owning companion's contact store. Mirrors the ICP
 * certification sequence exactly.
 */
export async function seedSiblingContact(
  store: ContactStorePort,
  peerCompanionId: string,
  trust: TrustLevel,
): Promise<string> {
  const contact = await store.resolveChannelIdentity(
    'companion',
    peerCompanionId,
    `Companion ${peerCompanionId.slice(0, 8)}`,
  );
  await store.setMachineIntelligence(contact.id, true, SEED_ACTOR);
  await store.setTrustLevel(contact.id, trust, SEED_ACTOR);
  await store.updateRelationshipType(contact.id, 'ai_companion', SEED_ACTOR);
  return contact.id;
}

/** The companions.json fields that pin one companion's contact-store authority. */
interface SiblingContactOwner {
  companionId: string;
  postgresSchema: string;
  postgresRole: string;
}

type SiblingContactStoreFactory = (
  databaseUrl: string,
  target: { schema: string; role: string },
) => Promise<ContactStorePort>;

/**
 * Write every mutual sibling contact. Each owner's contact store connects with
 * the tenant role that companions.json provisions for it (the same role the
 * runtime persistence factory and the chart use), never a derived name: a
 * provisioned fleet only has the configured roles (psfn-framework-w6f98).
 */
export async function applySiblingContactSeeding(input: {
  databaseUrl: string;
  companions: readonly SiblingContactOwner[];
  trust: TrustLevel;
  createStore: SiblingContactStoreFactory;
}): Promise<Array<{ owner: string; peer: string; contactId: string }>> {
  const seeded: Array<{ owner: string; peer: string; contactId: string }> = [];
  for (const owner of input.companions) {
    const role = owner.postgresRole.trim();
    if (!role) {
      throw new Error(`seed:sibling-contacts requires companions.json postgresRole for companion ${owner.companionId}`);
    }
    const store = await input.createStore(input.databaseUrl, { schema: owner.postgresSchema, role });
    for (const peer of input.companions) {
      if (peer.companionId === owner.companionId) continue;
      const contactId = await seedSiblingContact(store, peer.companionId, input.trust);
      seeded.push({ owner: owner.companionId, peer: peer.companionId, contactId });
    }
  }
  return seeded;
}

async function run(options: CliOptions): Promise<void> {
  const runtime = await bootstrapMaintenanceRuntime();
  const databaseUrl = runtime.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('seed:sibling-contacts requires PostgreSQL persistence (postgresDatabaseUrl is not configured)');
  }
  const { fleet } = resolveSystemOwnerFleetContext(process.env);
  const companions = fleet.companions;
  if (companions.length < 2) {
    throw new Error('seed:sibling-contacts requires a fleet of at least two companions');
  }

  const plannedPairs = companions.flatMap((owner) =>
    companions
      .filter((peer) => peer.companionId !== owner.companionId)
      .map((peer) => ({ owner: owner.companionId, peer: peer.companionId })),
  );

  if (!options.apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      trust: options.trust,
      companions: companions.map((companion) => ({
        companionId: companion.companionId,
        postgresSchema: companion.postgresSchema,
        postgresRole: companion.postgresRole,
      })),
      plannedContacts: plannedPairs,
      note: 'Re-run with --apply to write these mutual sibling contacts.',
    }, null, 2));
    return;
  }

  const seeded = await applySiblingContactSeeding({
    databaseUrl,
    companions,
    trust: options.trust,
    createStore: (url, target) => createPostgresContactStore(url, undefined, target),
  });
  console.log(JSON.stringify({ mode: 'apply', trust: options.trust, seeded }, null, 2));
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Seed sibling contacts',
    parseArgs,
    printUsage,
    run,
  });
}

export { parseArgs };
