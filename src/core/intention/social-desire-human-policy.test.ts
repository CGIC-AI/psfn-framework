import { describe, expect, it } from 'vitest';
import type { Contact } from '../contacts/types.js';
import { createSocialDesireHumanDeliveryPolicy } from './social-desire-human-policy.js';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-primary',
    displayName: 'Primary',
    trustLevel: 'primary',
    relationshipType: 'partner',
    timezone: 'America/Los_Angeles',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('social desire human delivery policy', () => {
  it('revalidates primary trust and the exact approved heartbeat channel/type', async () => {
    let liveContact = contact();
    const policy = createSocialDesireHumanDeliveryPolicy({
      contacts: { getById: () => liveContact },
      approvedHeartbeatChannel: { channelId: 'discord:primary', channelType: 'discord' },
      quietHours: {
        enabled: false,
        startLocalTime: '22:00',
        endLocalTime: '07:00',
        timeZone: 'UTC',
        inactivityThresholdMinutes: 60,
      },
    });
    const input = {
      contactId: liveContact.id,
      channelId: 'discord:primary',
      channelType: 'discord' as const,
      nowMs: Date.parse('2026-07-20T12:00:00.000Z'),
    };
    await expect(policy.evaluate(input)).resolves.toEqual({ allowed: true });

    liveContact = contact({ trustLevel: 'trusted' });
    await expect(policy.evaluate(input)).resolves.toEqual({
      allowed: false,
      reason: 'social_desire_contact_not_primary',
    });
    liveContact = contact();
    await expect(policy.evaluate({ ...input, channelId: 'discord:other' })).resolves.toEqual({
      allowed: false,
      reason: 'social_desire_channel_not_approved',
    });
    await expect(policy.evaluate({ ...input, channelType: 'api' })).resolves.toEqual({
      allowed: false,
      reason: 'social_desire_channel_not_approved',
    });
  });

  it('reschedules in the recipient local quiet-hours window', async () => {
    const policy = createSocialDesireHumanDeliveryPolicy({
      contacts: { getById: () => contact() },
      approvedHeartbeatChannel: { channelId: 'discord:primary', channelType: 'discord' },
      quietHours: {
        enabled: true,
        startLocalTime: '22:00',
        endLocalTime: '01:00',
        timeZone: 'UTC',
        inactivityThresholdMinutes: 60,
      },
    });
    // 06:30 UTC is outside the configured UTC window but 23:30 PDT for the recipient.
    await expect(policy.evaluate({
      contactId: 'contact-primary',
      channelId: 'discord:primary',
      channelType: 'discord',
      nowMs: Date.parse('2026-07-20T06:30:00.000Z'),
    })).resolves.toEqual({
      allowed: false,
      reason: 'quiet_hours',
      rescheduleAt: Date.parse('2026-07-20T08:00:00.000Z'),
    });
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'Not/A_Timezone'],
  ])('blocks when the recipient timezone is %s during enabled quiet hours', async (_case, timezone) => {
    const policy = createSocialDesireHumanDeliveryPolicy({
      contacts: { getById: () => contact({ timezone }) },
      approvedHeartbeatChannel: { channelId: 'discord:primary', channelType: 'discord' },
      quietHours: {
        enabled: true,
        startLocalTime: '22:00',
        endLocalTime: '07:00',
        timeZone: 'UTC',
        inactivityThresholdMinutes: 60,
      },
    });

    await expect(policy.evaluate({
      contactId: 'contact-primary',
      channelId: 'discord:primary',
      channelType: 'discord',
      nowMs: Date.parse('2026-07-20T12:00:00.000Z'),
    })).resolves.toEqual({
      allowed: false,
      reason: 'social_desire_recipient_timezone_unavailable',
    });
  });
});
