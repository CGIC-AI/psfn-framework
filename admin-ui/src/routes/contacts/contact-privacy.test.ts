import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactConversationChannelView } from '$lib/types';
import { getChannelEnvelopeData, saveChannelEnvelopeLabel, getChannelDemotionNotice, demoteChannelToPublic, type ChannelEnvelopeData } from '$lib/api/endpoints/channels';
import { buildPrivacyChangeCandidates, contactChannelPrivacy, contactPrivacyKey, saveContactPolicyPrivacy } from './contact-privacy';

vi.mock('$lib/api/endpoints/channels', () => ({
  getChannelEnvelopeData: vi.fn(), saveChannelEnvelopeLabel: vi.fn(), getChannelDemotionNotice: vi.fn(), demoteChannelToPublic: vi.fn(),
}));
const contact = {
  id: 'person-a', channels: [
    { channel: 'api:hermes', userId: 'body-a', privacyLevel: 'private' },
    { channel: 'discord', userId: 'person-a', privacyLevel: 'invite_only' },
  ],
} as Contact;
const related: ContactConversationChannelView[] = [
  { channel: 'api', channelId: 'hermes', policyChannelId: 'api:hermes', sessionCount: 100, privacyLevel: 'private' },
];
function policies(privacy: 'private' | 'invite_only' | 'public' = 'private'): ChannelEnvelopeData {
  return {
    channels: [{ channelId: 'api:hermes', privacy, broadcast: false, contactTracking: 'auto', source: 'channel_label', needsReview: false, hasLabel: true,
      label: { privacy, contactTracking: 'approval', deliveryStyle: 'concise', needsReview: true } }],
    prefixOverrides: {}, privatePrefixes: [], broadcastPrefixes: [], epochs: [],
  };
}

beforeEach(() => { vi.resetAllMocks(); });
describe('contact-card privacy editing', () => {
  it('includes one editable shared Hermes policy beside ordinary contact permissions', () => {
    const candidates = buildPrivacyChangeCandidates(contact, related, policies());
    expect(candidates).toContainEqual({ key: 'policy:api:hermes', target: 'policy', channelId: 'api:hermes', privacyLevel: 'private' });
    expect(candidates.filter(row => row.key === 'policy:api:hermes')).toHaveLength(1);
    expect(candidates).toContainEqual({ key: 'identity:discord:person-a', target: 'identity', channel: 'discord', userId: 'person-a', privacyLevel: 'invite_only' });
    expect(contactPrivacyKey(contact.channels![0])).toBe(contactPrivacyKey(related[0]));
  });
  it('shows the authoritative label instead of stale contact evidence and requires a loaded policy to edit', () => {
    expect(contactChannelPrivacy(contact.channels![0], policies('invite_only'))).toBe('invite_only');
    expect(contactChannelPrivacy(related[0], policies('invite_only'))).toBe('invite_only');
    expect(contactChannelPrivacy(related[0], null)).toBeUndefined();
    expect(buildPrivacyChangeCandidates(contact, related, null).map(row => row.target)).toEqual(['identity']);
  });
  it('saves the root policy while preserving newly fetched channel settings', async () => {
    vi.mocked(getChannelEnvelopeData).mockResolvedValue(policies());
    vi.mocked(saveChannelEnvelopeLabel).mockResolvedValue({ ok: true, message: 'Saved', data: policies('invite_only') });
    const confirm = vi.fn();
    const result = await saveContactPolicyPrivacy('api:hermes', 'invite_only', confirm);
    expect(saveChannelEnvelopeLabel).toHaveBeenCalledExactlyOnceWith('api:hermes', {
      privacy: 'invite_only', contactTracking: 'approval', deliveryStyle: 'concise', needsReview: true,
    });
    expect(result?.channels[0].privacy).toBe('invite_only');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('does not manufacture a policy or report a rejected write as saved', async () => {
    vi.mocked(getChannelEnvelopeData).mockResolvedValue({ ...policies(), channels: [] });
    await expect(saveContactPolicyPrivacy('api:hermes', 'invite_only', vi.fn())).rejects.toThrow('unavailable');
    expect(saveChannelEnvelopeLabel).not.toHaveBeenCalled();
    vi.mocked(getChannelEnvelopeData).mockResolvedValue(policies());
    vi.mocked(saveChannelEnvelopeLabel).mockResolvedValue({ ok: false, message: 'Owner write denied', data: policies() });
    await expect(saveContactPolicyPrivacy('api:hermes', 'invite_only', vi.fn())).rejects.toThrow('Owner write denied');
  });
  it('preserves disclosure safeguards when public is chosen in the inline dropdown', async () => {
    vi.mocked(getChannelEnvelopeData).mockResolvedValue(policies('invite_only'));
    vi.mocked(getChannelDemotionNotice).mockResolvedValue({ channelId: 'api:hermes', currentPrivacy: 'invite_only', from: 'invite_only', to: 'public', demotable: true, notice: 'Public disclosure notice', noticeVersion: 'notice-v1' });
    vi.mocked(demoteChannelToPublic).mockResolvedValue({ ok: true, message: 'Saved', data: policies('public') });
    const confirm = vi.fn(() => true);
    await saveContactPolicyPrivacy('api:hermes', 'public', confirm);
    expect(confirm).toHaveBeenCalledWith('Public disclosure notice');
    expect(demoteChannelToPublic).toHaveBeenCalledExactlyOnceWith('api:hermes', 'notice-v1');
    expect(saveChannelEnvelopeLabel).not.toHaveBeenCalled();
  });
  it('leaves the policy unchanged when disclosure is cancelled or forbidden', async () => {
    vi.mocked(getChannelEnvelopeData).mockResolvedValue(policies('invite_only'));
    vi.mocked(getChannelDemotionNotice).mockResolvedValue({ channelId: 'api:hermes', currentPrivacy: 'invite_only', from: 'invite_only', to: 'public', demotable: true, notice: 'Notice', noticeVersion: 'notice-v1' });
    expect(await saveContactPolicyPrivacy('api:hermes', 'public', () => false)).toBeNull();
    vi.mocked(getChannelDemotionNotice).mockResolvedValue({ channelId: 'api:hermes', currentPrivacy: 'private', from: 'invite_only', to: 'public', demotable: false, notice: 'Notice', noticeVersion: 'notice-v1', reason: 'Transition denied' });
    await expect(saveContactPolicyPrivacy('api:hermes', 'public', vi.fn())).rejects.toThrow('Transition denied');
    expect(demoteChannelToPublic).not.toHaveBeenCalled();
    expect(saveChannelEnvelopeLabel).not.toHaveBeenCalled();
  });
  it('clears broadcast when making a public channel private without forging confirmation provenance', async () => {
    const current = policies('public');
    current.channels[0] = { ...current.channels[0], broadcast: true, label: { privacy: 'public', broadcast: true, classificationSource: 'operator_confirmed' } };
    vi.mocked(getChannelEnvelopeData).mockResolvedValue(current);
    vi.mocked(saveChannelEnvelopeLabel).mockResolvedValue({ ok: true, message: 'Saved', data: policies() });
    await saveContactPolicyPrivacy('api:hermes', 'private', vi.fn());
    expect(saveChannelEnvelopeLabel).toHaveBeenCalledExactlyOnceWith('api:hermes', { privacy: 'private', broadcast: false });
  });
});
