import { describe, it, expect } from 'vitest';
import { toMemoryRow, fromMemoryRow } from './rows.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  normalizeConsentFlags,
  normalizeMemoryProvenance,
  type ConsentFlags,
  type MemoryProvenance,
  type MemoryScopeKind,
  type PurrMemory,
} from '../types.js';

// Generative round-trip guard for the disclosure-critical row codec
// (psfn-framework-owffl.1). The xnfks consent-flags bug shipped green because
// every codec test used hand-picked examples; none exercised the round-trip
// over arbitrary field states. These properties pin the whole class: any field
// that gates disclosure must survive toMemoryRow -> fromMemoryRow unchanged,
// and malformed stored jsonb must normalize CLOSED, never open.

const CASES = 500;
const SEED = 588221;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const pick = <T>(rng: Rng, values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
const maybe = <T>(rng: Rng, value: () => T): T | undefined => (rng() < 0.5 ? value() : undefined);
const int = (rng: Rng, max: number): number => Math.floor(rng() * max);
const str = (rng: Rng, prefix: string): string => `${prefix}-${int(rng, 1_000_000)}`;

const SCOPE_KINDS: readonly MemoryScopeKind[] = [
  'conversation', 'contact', 'project', 'north_star', 'task_worker', 'shard', 'system',
];

function generateConsentFlags(rng: Rng): ConsentFlags | undefined {
  const roll = rng();
  if (roll < 0.2) return undefined;
  if (roll < 0.3) return {};
  const flags: ConsentFlags = {};
  if (rng() < 0.6) flags.allowRecall = rng() < 0.5;
  if (rng() < 0.6) flags.allowAbstraction = rng() < 0.5;
  if (rng() < 0.6) flags.deleteOnRequest = rng() < 0.5;
  if (rng() < 0.4) flags.redactionBehavior = pick(rng, ['delete', 'abstract'] as const);
  return flags;
}

function generateProvenance(rng: Rng): MemoryProvenance | undefined {
  return maybe(rng, () => {
    const provenance: MemoryProvenance = {};
    if (rng() < 0.6) provenance.channelId = str(rng, 'channel');
    if (rng() < 0.5) provenance.turnId = str(rng, 'turn');
    if (rng() < 0.4) provenance.actor = pick(rng, ['companion', 'operator', 'system', 'shard', 'subagent', 'repl'] as const);
    if (rng() < 0.4) provenance.reason = str(rng, 'reason');
    if (rng() < 0.4) provenance.subjectContactId = str(rng, 'contact');
    if (rng() < 0.3) provenance.sourceMessageIds = [int(rng, 10_000), int(rng, 10_000)];
    if (rng() < 0.3) provenance.sourceConversationAt = 1_700_000_000_000 + int(rng, 1_000_000);
    return provenance;
  });
}

function generateMemory(rng: Rng): PurrMemory {
  const lastAccessed = 1_700_000_000_000 + int(rng, 10_000_000);
  const supersededBy = maybe(rng, () => str(rng, 'superseded'));
  const consentFlags = generateConsentFlags(rng);
  const provenance = generateProvenance(rng);
  return {
    id: `018f${int(rng, 0xffff).toString(16).padStart(4, '0')}-0000-7000-8000-${int(rng, 0xffffffff).toString(16).padStart(12, '0')}`,
    text: str(rng, 'memory-text'),
    type: pick(rng, VALID_MEMORY_TYPES),
    importance: Math.round(rng() * 100) / 100,
    confidence: Math.round(rng() * 100) / 100,
    emotionalValence: Math.round((rng() * 2 - 1) * 100) / 100,
    salience: Math.round(rng() * 100) / 100,
    sourceRef: pick(rng, ['tool:memory_write', str(rng, 'turn'), str(rng, 'reflection')]),
    extractedAt: lastAccessed - int(rng, 100_000),
    lastAccessed,
    accessCount: int(rng, 50),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
    tags: Array.from({ length: int(rng, 5) }, () => str(rng, 'tag')),
    ...(rng() < 0.5
      ? {
          scopeRef: {
            kind: pick(rng, SCOPE_KINDS),
            id: str(rng, 'scope'),
            ...(rng() < 0.5 ? { label: str(rng, 'label') } : {}),
          },
        }
      : {}),
    ...(rng() < 0.4 ? { scopeTags: [str(rng, 'scope-tag')] } : {}),
    ...(rng() < 0.4 ? { retentionClass: pick(rng, ['standard', 'durable'] as const) } : {}),
    sensitivity: pick(rng, VALID_SENSITIVITY_LEVELS),
    ...(consentFlags !== undefined ? { consentFlags } : {}),
    ...(rng() < 0.4 ? { contactId: str(rng, 'contact') } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(rng() < 0.25
      ? {
          deletedAt: lastAccessed + int(rng, 10_000),
          deletedBy: str(rng, 'deleter'),
          deleteReason: str(rng, 'delete-reason'),
        }
      : {}),
  };
}

describe('memory row round-trip preserves disclosure-gating fields (owffl.1, xnfks class)', () => {
  it(`preserves consent, sensitivity, contact, scope, tags, provenance, retention, and deletion across ${CASES} generated memories (seed ${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < CASES; i += 1) {
      const memory = generateMemory(rng);
      const restored = fromMemoryRow(toMemoryRow(memory));
      const label = `seed=${SEED} case=${i} id=${memory.id}`;

      // Consent is the absolute-denial guarantee: what was stored must be
      // exactly what the Layer-3 gate sees on read, for every combination.
      expect(restored.consentFlags, `${label} consentFlags`).toEqual(
        normalizeConsentFlags(memory.consentFlags ?? {}),
      );
      expect(restored.sensitivity, `${label} sensitivity`).toBe(memory.sensitivity);
      expect(restored.contactId, `${label} contactId`).toBe(memory.contactId);
      expect(restored.scopeRef, `${label} scopeRef`).toEqual(memory.scopeRef);
      expect(restored.tags, `${label} tags`).toEqual(memory.tags);
      expect(
        restored.provenance,
        `${label} provenance`,
      ).toEqual(normalizeMemoryProvenance(memory.provenance ?? {}));
      expect(restored.retentionClass, `${label} retentionClass`).toBe(memory.retentionClass);
      expect(restored.deletedAt, `${label} deletedAt`).toBe(memory.deletedAt);
      expect(restored.deletedBy, `${label} deletedBy`).toBe(memory.deletedBy);
      expect(restored.deleteReason, `${label} deleteReason`).toBe(memory.deleteReason);
      expect(restored.supersededBy, `${label} supersededBy`).toBe(memory.supersededBy);
    }
  });

  it(`normalizes malformed stored consent jsonb CLOSED — garbage never fabricates an allow, explicit denial always survives (${CASES} cases, seed ${SEED + 1})`, () => {
    const rng = mulberry32(SEED + 1);
    const garbageValue = (): unknown => {
      switch (int(rng, 7)) {
        case 0: return int(rng, 100);
        case 1: return str(rng, 'junk');
        case 2: return [str(rng, 'junk')];
        case 3: return null;
        case 4: return { nested: str(rng, 'junk') };
        case 5: return rng() < 0.5;
        default: return undefined;
      }
    };
    const knownKeys = new Set(['allowRecall', 'allowAbstraction', 'deleteOnRequest', 'redactionBehavior']);

    for (let i = 0; i < CASES; i += 1) {
      const garbage: Record<string, unknown> = {};
      for (const key of knownKeys) {
        if (rng() < 0.7) garbage[key] = garbageValue();
      }
      if (rng() < 0.5) garbage[str(rng, 'unknown-key')] = garbageValue();
      // Half the cases carry a genuine explicit denial buried in the garbage.
      const carriesDenial = rng() < 0.5;
      if (carriesDenial) garbage.allowRecall = false;

      const row = toMemoryRow(generateMemory(rng));
      const restored = fromMemoryRow({ ...row, consent_flags: garbage });
      const label = `seed=${SEED + 1} case=${i}`;
      const flags = restored.consentFlags ?? {};

      expect(flags, `${label} normalization`).toEqual(normalizeConsentFlags(garbage));
      for (const [key, value] of Object.entries(flags)) {
        expect(knownKeys.has(key), `${label} unknown key ${key} leaked through`).toBe(true);
        if (key === 'redactionBehavior') {
          expect(['delete', 'abstract'], `${label} redactionBehavior domain`).toContain(value);
        } else {
          expect(typeof value, `${label} ${key} type`).toBe('boolean');
        }
      }
      if (carriesDenial) {
        expect(flags.allowRecall, `${label} explicit denial must survive garbage`).toBe(false);
      }
      if (typeof garbage.allowRecall !== 'boolean') {
        expect(flags.allowRecall, `${label} non-boolean input must never become an allow`).toBeUndefined();
      }
    }
  });
});
