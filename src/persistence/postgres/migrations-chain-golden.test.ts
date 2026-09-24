import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import * as registry from './migrations.js';

/**
 * Golden pin of every migration chain exported by the public registry
 * (psfn-framework-emh3p.10). Migration order and text are production state:
 * each chain is pinned by statement count and a sha256 of its JSON-encoded
 * ordered statement list, so reordering, omission, duplication, statement
 * boundary drift, or any byte change inside a statement fails here.
 *
 * Updating an entry is a deliberate schema change, never a side effect of
 * moving code between modules. A new migration appended to a chain updates
 * that chain's length and digest in the same commit that adds the SQL.
 */
const CHAIN_GOLDEN: Readonly<Record<string, { readonly length: number; readonly sha256: string }>> = {
  POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS: { length: 2, sha256: '24eb78b2b4c8c035ce9327566c9d0c1d68d6d36253f10890db555b8da8eff570' },
  POSTGRES_AUDIT_MIGRATIONS: { length: 4, sha256: 'a6ccf33b23985293fc0ebd87ca783768cfc7720aa1407815f79bfe5fc343ab6a' },
  POSTGRES_AUTOMATA_MIGRATIONS: { length: 47, sha256: '6a3287d272a3ca33302dda8f8c24484c79d26488e3591403853cb6f99e596ad2' },
  POSTGRES_AUTOMATA_ROLLBACK_MIGRATIONS: { length: 10, sha256: 'e5964aef91d70c85d5935319f39fa64ed6c0b3b3f50329b6c0e8f54a0053af54' },
  POSTGRES_AUTOMATA_RUN_MIGRATIONS: { length: 5, sha256: 'aeb0255184d8c96626698e65b5e0e820338c262e84df6be841315f5ceb7bb99a' },
  POSTGRES_BACKGROUND_WORK_MIGRATIONS: { length: 50, sha256: 'c85971735089a71868321af2b010cf4917b7ec2dba60628df799f29cb05914ae' },
  POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK: { length: 2, sha256: '344ac89473968e84647d98eabf6d1469e820d60eeba9546de9f88776d3db7c5e' },
  POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS: { length: 11, sha256: '7932c602af1a0901446b8893985ccb920aa88f7b13bb2f743f5dce21c201d3cd' },
  POSTGRES_COGSEC_RECEIPT_MIGRATIONS: { length: 3, sha256: '6937812c17943b3be78665bc40d48aa172196044046f58ce8de1c06a60c8083f' },
  POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS: { length: 4, sha256: '7225500fc6e27ef9a8392e6d1ac309d8daa7e978c83affa02cad89bae1835eed' },
  POSTGRES_CONTACT_MIGRATIONS: { length: 76, sha256: '01d91e28ba069194d7c917a288dcab9ded9156ff98cd14d6bddfd5995aedb1a3' },
  POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS: { length: 7, sha256: '8c88775f6d3ec7c66d501d68734496d7049611f7f635150583968efdbf7cdce5' },
  POSTGRES_DOING_MIRROR_MIGRATIONS: { length: 8, sha256: '9772da95f5dc3377237541cbc43f7da09a9f9e17d5a35ac698e6498f1882aeb0' },
  POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS: { length: 4, sha256: '01875697f398d7ca041b00a6e6870f75720b10d6bdc59c5cb0bb962d10b08d2a' },
  POSTGRES_ENROLLMENT_MIGRATIONS: { length: 8, sha256: 'fe6d1b7fbcda247527e83f52662cfbc75beb821ec1869c2b7f666d9136c74ae8' },
  POSTGRES_HEALTH_EVENT_MIGRATIONS: { length: 3, sha256: '991aa188f78116ae337210e7e6295d5c567dd7a7b8e5eb4e7a266dfb87741f3d' },
  POSTGRES_HUMAN_ESCALATION_MIGRATIONS: { length: 5, sha256: '98f4cc922c6304eaef68c32949c81b74f78f1dc24f600e4912421bbcd71bb33d' },
  POSTGRES_INTENTION_MIGRATIONS: { length: 83, sha256: 'e699f169b7f282a7a7ec2158c7b6f03c51edd2fb7cd91f191c793a04ef262d87' },
  POSTGRES_INTERNAL_STATE_MIGRATIONS: { length: 1, sha256: 'f6b1a44de0bbb24ec9e81a769c08c1abdc43dbae41530f68f2997a23ee76ca31' },
  POSTGRES_INTROSPECTION_MIGRATIONS: { length: 10, sha256: 'ed8eee01a8f2544aef7cdfda0547caab72e470352a707ad28932d66f7a079908' },
  POSTGRES_LETTER_MIGRATIONS: { length: 3, sha256: 'f3b1e3413554aeed4e474da3c8c1599729a39d1dabc4cd261d583b46567dd107' },
  POSTGRES_MEMORY_MIGRATIONS: { length: 195, sha256: 'ee1d689db48aeb0195ec7fac740ed7e11db6106b5668215767c06c61efc3b1ca' },
  POSTGRES_MODEL_USAGE_MIGRATIONS: { length: 77, sha256: '3c06591f627e799df16d70c50254141f9c4aebb832e45ea7c9aafd0259f410db' },
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK: { length: 2, sha256: 'bdabb3bd376f2377224c830ae2906bd76d8ba4dccc36903245b81f2aa8c47ddf' },
  POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS: { length: 27, sha256: 'a58e7d8103eda9180f9f8e744e1044b361afbbb1c67879c4f8523bbce2fce39e' },
  POSTGRES_PARTICIPANT_TREND_MIGRATIONS: { length: 2, sha256: '3e013f16bb0e97001401789d0464a3fc5911961b2c79ac7610b9ec2dfcc459e4' },
  POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS: { length: 4, sha256: '13a6b20025a7245fe7213075cc5bef5897f88593c749cc2b6f6a127ba1fc87f8' },
  POSTGRES_REFLECTION_MIGRATIONS: { length: 5, sha256: '700b771d966312b474c8ca21c455d9d7285b5a0690a39d2ea6c6db50993234a8' },
  POSTGRES_SCHEDULED_PROMPT_MIGRATIONS: { length: 7, sha256: 'b5e6e45f4c7aa6a952869641fcb921371bc67abd1e0007cc2b6757f0b9d2541c' },
  POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS: { length: 2, sha256: '759b633e02dd9a2f700e7e69dcd76f1b2c369370b0c528cf66dc5c3f9d31a4af' },
  POSTGRES_SHARED_ALL_MIGRATION_VERSIONS: { length: 21, sha256: 'd2592aec818c569765bfa500e771578e176f38be15ddf0a61a24fdab79b09876' },
  POSTGRES_SHARED_BASE_MIGRATION_VERSIONS: { length: 19, sha256: 'e5fa3aa287b2a0cfb17e4b312c87201859a6bddbb41969b1fdc3029149b1ecbc' },
  POSTGRES_SHARED_MIGRATIONS: { length: 107, sha256: '30d719a7fc6843dbedb98b5aef239b625411077af25bb06e87f6c5441f43d815' },
  POSTGRES_SHARED_WIKI_MIGRATIONS: { length: 10, sha256: '89c8eb71ac8cfeb1dc1ecf39511033c76ad397a997823fdd6b10e6bff940ac3b' },
  POSTGRES_TRANSCRIPT_MIGRATIONS: { length: 16, sha256: '73ac14c94299e526baa696c4d9849f65001552877445cb0331de266543e47945' },
  POSTGRES_WIKI_PROJECTION_MIGRATIONS: { length: 6, sha256: '9834e276d05dc8449bab498c2a5d1e8cab5cc7b49f14f4354d01ef2d3720c220' },
};

const NON_CHAIN_EXPORTS = {
  SHARED_SCHEMA_NAME: 'shared',
} as const;

function chainDigest(chain: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(chain)).digest('hex');
}

const exported = registry as Readonly<Record<string, unknown>>;

describe('Postgres migration registry golden chains', () => {
  it('exports exactly the pinned registry surface', () => {
    expect(Object.keys(exported).sort()).toEqual(
      [...Object.keys(CHAIN_GOLDEN), ...Object.keys(NON_CHAIN_EXPORTS)].sort(),
    );
  });

  it('keeps the shared schema name', () => {
    expect(registry.SHARED_SCHEMA_NAME).toBe(NON_CHAIN_EXPORTS.SHARED_SCHEMA_NAME);
  });

  it('keeps the shared ledger versions and advisory-lock keys in order', () => {
    expect(registry.POSTGRES_SHARED_BASE_MIGRATION_VERSIONS).toEqual([
      1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(registry.POSTGRES_SHARED_ALL_MIGRATION_VERSIONS).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(registry.POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK).toEqual([1_297_431_347, 1_159_535_447]);
    expect(registry.POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK).toEqual([1_297_431_347, 1_431_521_607]);
  });

  it.each(Object.entries(CHAIN_GOLDEN))('pins %s statement order and bytes', (name, golden) => {
    const chain = exported[name];
    expect(Array.isArray(chain)).toBe(true);
    const statements = chain as readonly unknown[];
    expect(statements).toHaveLength(golden.length);
    expect(chainDigest(statements)).toBe(golden.sha256);
  });
});
