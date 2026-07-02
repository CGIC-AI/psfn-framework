import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContactStore } from './store.js';
import {
  applyObservedMachineIntelligence,
  isDeliberateMachineIntelligenceCorrection,
  observedMachineIntelligenceActor,
} from './observed-machine-intelligence.js';
import { resolveFatigueRelationshipClass } from '../agent/fatigue/policy.js';

const PRIMARY_USER_ID = 'owner-1';

const silentLogger = { warn: () => undefined };

describe('applyObservedMachineIntelligence (E7.3 auto-tagging)', () => {
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContactStore(db, PRIMARY_USER_ID);
  });

  it('marks a bot-flagged contact as machine intelligence through the real store path', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'peer-bot-1', 'PeerBot');
    expect(contact.isMachineIntelligence).not.toBe(true);

    const result = await applyObservedMachineIntelligence({
      contactStore: store,
      contact,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    });

    expect(result.disposition).toBe('marked');
    expect(result.contact.isMachineIntelligence).toBe(true);

    // Persisted through the real contact store, not just the returned object.
    const reloaded = await store.getById(contact.id);
    expect(reloaded?.isMachineIntelligence).toBe(true);

    // Provenance-honest audit: a system:channel_observation actor.
    const audit = await store.listMutationAuditEntries({
      contactId: contact.id,
      field: 'is_machine_intelligence',
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(observedMachineIntelligenceActor('discord'));
    expect(audit[0]?.newValue).toBe('true');
  });

  it('is idempotent — re-observation of an already-marked contact does not rewrite', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'peer-bot-2', 'PeerBot2');
    await applyObservedMachineIntelligence({
      contactStore: store,
      contact,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    });

    const marked = await store.getById(contact.id);
    const second = await applyObservedMachineIntelligence({
      contactStore: store,
      contact: marked!,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    });

    expect(second.disposition).toBe('already_marked');
    const audit = await store.listMutationAuditEntries({
      contactId: contact.id,
      field: 'is_machine_intelligence',
    });
    expect(audit).toHaveLength(1);
  });

  it('does nothing when the message carries no MI observation', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'human-1', 'Human');
    const result = await applyObservedMachineIntelligence({
      contactStore: store,
      contact,
      observedIsMachineIntelligence: false,
      channelType: 'discord',
      logger: silentLogger,
    });
    expect(result.disposition).toBe('not_observed');
    expect(result.contact.isMachineIntelligence).not.toBe(true);
    const reloaded = await store.getById(contact.id);
    expect(reloaded?.isMachineIntelligence).not.toBe(true);
  });

  it('does NOT clobber an operator correction (Garden/admin actor) on re-observation', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'peer-bot-3', 'PeerBot3');
    // Operator was misfired-on and explicitly corrected the contact to NOT MI.
    await store.setMachineIntelligence(contact.id, true, observedMachineIntelligenceActor('discord'));
    const corrected = await store.getById(contact.id);
    await store.setMachineIntelligence(contact.id, false, 'admin:api');

    const afterCorrection = await store.getById(contact.id);
    expect(afterCorrection?.isMachineIntelligence).not.toBe(true);

    // Re-observation must respect the operator's correction.
    const result = await applyObservedMachineIntelligence({
      contactStore: store,
      contact: afterCorrection!,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    });

    expect(result.disposition).toBe('operator_override');
    const reloaded = await store.getById(contact.id);
    expect(reloaded?.isMachineIntelligence).not.toBe(true);
    // Sanity: the earlier system mark did happen (audit records both actors).
    expect(corrected?.isMachineIntelligence).toBe(true);
  });

  it('does NOT clobber a deliberate contact-tool correction on re-observation', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'peer-bot-4', 'PeerBot4');
    // Realistic flow: the contact was auto-tagged MI, then the operator/companion
    // corrected it via the set_machine_intelligence contact tool (true -> false).
    await store.setMachineIntelligence(contact.id, true, observedMachineIntelligenceActor('discord'));
    await store.setMachineIntelligence(contact.id, false, 'agent:tool:contact_set_machine_intelligence');
    const afterTool = await store.getById(contact.id);

    const result = await applyObservedMachineIntelligence({
      contactStore: store,
      contact: afterTool!,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    });

    expect(result.disposition).toBe('operator_override');
    const reloaded = await store.getById(contact.id);
    expect(reloaded?.isMachineIntelligence).not.toBe(true);
  });

  it('feeds fatigue relationship-class resolution once marked', async () => {
    const contact = await store.resolveChannelIdentity('discord', 'peer-bot-5', 'PeerBot5');
    // Before marking: not a machine intelligence -> the non-MI class.
    expect(resolveFatigueRelationshipClass({
      contactId: contact.id,
      isMachineIntelligence: contact.isMachineIntelligence === true,
      relationshipType: contact.relationshipType,
      trustLevel: contact.trustLevel,
    })).toBe('non_machine_intelligence');

    const marked = (await applyObservedMachineIntelligence({
      contactStore: store,
      contact,
      observedIsMachineIntelligence: true,
      channelType: 'discord',
      logger: silentLogger,
    })).contact;

    const relationshipClass = resolveFatigueRelationshipClass({
      contactId: marked.id,
      isMachineIntelligence: marked.isMachineIntelligence === true,
      relationshipType: marked.relationshipType,
      trustLevel: marked.trustLevel,
    });
    expect(relationshipClass).not.toBe('non_machine_intelligence');
  });
});

describe('isDeliberateMachineIntelligenceCorrection', () => {
  it('treats system:-prefixed actors as observations (not corrections)', () => {
    expect(isDeliberateMachineIntelligenceCorrection('system:channel_observation:discord')).toBe(false);
    expect(isDeliberateMachineIntelligenceCorrection(undefined)).toBe(false);
    expect(isDeliberateMachineIntelligenceCorrection('')).toBe(false);
  });

  it('treats operator/admin/agent-tool actors as deliberate corrections', () => {
    expect(isDeliberateMachineIntelligenceCorrection('admin:api')).toBe(true);
    expect(isDeliberateMachineIntelligenceCorrection('agent:tool:contact_set_machine_intelligence')).toBe(true);
    expect(isDeliberateMachineIntelligenceCorrection('operator:raul')).toBe(true);
  });
});
