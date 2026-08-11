// waw5q — per-companion quarantine list response carries the cluster-owned
// firewall status (empty queue ≠ firewall off) and optional plain-text
// attribution enrichment. Content-free: no bodies, no raw ids by default.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIntakeEnvelope,
  transitionIntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';
import {
  createIntakeQuarantineStore,
  type IntakeQuarantineStore,
} from '../../../core/cogsec/intake/quarantine-store.js';
import {
  createAdminIntakeQuarantineReadService,
  type AdminIntakeQuarantineFirewallStatus,
} from './intake-quarantine-service.js';

const NOW = 1_750_000_000_000;

function heldEntry(store: IntakeQuarantineStore, overrides: {
  sourceClass?: 'web_fetch' | 'regular_contact' | 'tool_output';
  originRef?: string;
  sourceChannelId?: string;
  canonicalContactId?: string;
  decisionReason?: string;
  cogSecCaseId?: string;
} = {}): string {
  const sha256 = 'b'.repeat(64);
  let envelope = createIntakeEnvelope({
    sourceClass: overrides.sourceClass ?? 'web_fetch',
    sourceRiskTier: 'untrusted',
    contentRef: { store: 'intake-quarantine', ref: `sha256:${sha256}`, sha256, sizeBytes: 42 },
    origin: { ref: overrides.originRef ?? 'https://suspect.example/article' },
    atMs: NOW,
  });
  const reason = overrides.decisionReason ?? 'l1:injection/override_attempt';
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'screened',
    actor: 'test:screening',
    reason,
    atMs: NOW,
    decision: { action: 'quarantine', reason, decidedBy: 'screening', decidedAtMs: NOW },
  });
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'quarantined',
    actor: 'test:screening',
    reason: 'routed per screening decision',
    atMs: NOW,
  });
  const entry = store.hold({
    envelope,
    mode: 'enforce',
    rawText: 'raw held bytes',
    ...(overrides.sourceChannelId !== undefined ? { sourceChannelId: overrides.sourceChannelId } : {}),
    ...(overrides.canonicalContactId !== undefined ? { canonicalContactId: overrides.canonicalContactId } : {}),
    ...(overrides.cogSecCaseId !== undefined ? { cogSecCaseId: overrides.cogSecCaseId } : {}),
    atMs: NOW,
  });
  return entry.id;
}

describe('admin intake quarantine read service (waw5q)', () => {
  let dir: string;
  let store: IntakeQuarantineStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'garden-quarantine-waw5q-'));
    store = createIntakeQuarantineStore(join(dir, 'intake-quarantine.json'), {
      itemTtlHours: 168,
      maxHeldItems: 500,
      now: () => NOW,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces a cluster-owned firewall status so an empty queue never means the firewall is off', () => {
    const firewallStatusProvider = (heldCount: number): AdminIntakeQuarantineFirewallStatus => ({
      mode: 'enforce',
      queueEmptyDoesNotMeanFirewallOff: true,
      note: 'The shared gateway firewall is in enforce mode.',
      heldCount,
      quarantineItemTtlHours: 168,
      quarantineMaxHeldItems: 500,
    });
    const service = createAdminIntakeQuarantineReadService({
      store,
      now: () => NOW,
      firewallStatusProvider,
    });

    const empty = service.listItems();
    expect(empty.items).toHaveLength(0);
    expect(empty.firewallStatus).toEqual({
      mode: 'enforce',
      queueEmptyDoesNotMeanFirewallOff: true,
      note: 'The shared gateway firewall is in enforce mode.',
      heldCount: 0,
      quarantineItemTtlHours: 168,
      quarantineMaxHeldItems: 500,
    });

    heldEntry(store, { sourceChannelId: 'discord:guild:1' });
    const populated = service.listItems();
    expect(populated.firewallStatus.heldCount).toBe(1);
    // The marker is a literal true on every response, populated or not.
    expect(populated.firewallStatus.queueEmptyDoesNotMeanFirewallOff).toBe(true);
  });

  it('omits firewall status rather than fabricating an off policy when no provider is wired', () => {
    const service = createAdminIntakeQuarantineReadService({ store, now: () => NOW });
    const { firewallStatus } = service.listItems();
    expect(firewallStatus).toBeUndefined();
  });

  it('enriches each item with content-free plain-text attribution when resolvers are wired', () => {
    heldEntry(store, {
      sourceClass: 'web_fetch',
      sourceChannelId: 'web:https://suspect.example/article',
      decisionReason: 'l1:injection/override_attempt',
      cogSecCaseId: 'cogsec_2030_group_a',
    });
    const service = createAdminIntakeQuarantineReadService({
      store,
      now: () => NOW,
      firewallStatusProvider: heldCount => ({
        mode: 'enforce',
        queueEmptyDoesNotMeanFirewallOff: true,
        note: 'enforce',
        heldCount,
        quarantineItemTtlHours: 168,
        quarantineMaxHeldItems: 500,
      }),
      attributionResolvers: {
        contactDisplayName: contactId => (contactId === 'contact-allowed' ? 'Example Person' : undefined),
      },
    });
    const { items } = service.listItems();
    expect(items).toHaveLength(1);
    expect(items[0].attribution).toMatchObject({
      sourceChannelLabel: 'Web',
      sourceChannelClass: 'web',
      direction: 'inbound',
      faultType: 'Prompt injection',
      screeningStage: 'l1',
      decision: 'Held for review',
      correlationId: 'cogsec_2030_group_a',
    });
    // No body and no raw url/id leaks into the default projection.
    const serialized = JSON.stringify(items[0].attribution);
    expect(serialized).not.toContain('suspect.example');
    expect(serialized).not.toContain('web:https');
  });

  it('marks outbound tool/screener holds with the outbound direction', () => {
    heldEntry(store, {
      sourceClass: 'tool_output',
      sourceChannelId: 'tool:fs.read',
      decisionReason: 'l2-fail-closed:timeout',
    });
    const service = createAdminIntakeQuarantineReadService({ store, now: () => NOW });
    const { items } = service.listItems();
    expect(items[0].attribution?.direction).toBe('outbound');
    expect(items[0].attribution?.screeningStage).toBe('l2');
    expect(items[0].attribution?.faultType).toBe('Screening malfunction');
  });

  it('omits the target contact display name when the viewer is not authorized', () => {
    heldEntry(store, {
      sourceClass: 'regular_contact',
      sourceChannelId: 'discord:guild:2',
      canonicalContactId: 'contact-other',
    });
    const service = createAdminIntakeQuarantineReadService({
      store,
      now: () => NOW,
      attributionResolvers: {
        contactDisplayName: contactId => (contactId === 'contact-allowed' ? 'Example Person' : undefined),
      },
    });
    const { items } = service.listItems();
    expect(items[0].attribution?.targetContactDisplayName).toBeUndefined();
    expect(JSON.stringify(items[0].attribution)).not.toContain('contact-other');
  });
});
