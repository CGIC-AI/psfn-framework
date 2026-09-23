// ── Per-contact social-outreach channel identity (psfn-framework-vcq8v.4) ──
//
// Every contact has exactly one internal outreach channel. Each outreach
// impulse for that contact runs a fresh, contained companion turn there: the
// channel is never persisted to a session store (so nothing accumulates across
// impulses and nothing leaks into the contact's own conversation history), it
// runs on the foreground chat lane, and it uses the companion context budget so
// the persona is loaded.

const SOCIAL_OUTREACH_CHANNEL_PREFIX = 'internal:social-outreach:';

const CONTACT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function composeSocialOutreachChannelId(contactId: string): string {
  const key = contactId.trim();
  if (!CONTACT_KEY_PATTERN.test(key)) {
    throw new Error('Social outreach channel requires a canonical contact id');
  }
  return `${SOCIAL_OUTREACH_CHANNEL_PREFIX}${key}`;
}

export function isSocialOutreachChannelId(channelId: string | undefined | null): boolean {
  return typeof channelId === 'string' && channelId.startsWith(SOCIAL_OUTREACH_CHANNEL_PREFIX);
}

/** The contact a social-outreach channel belongs to, or null for any other channel. */
export function parseSocialOutreachChannelContactId(channelId: string): string | null {
  if (!isSocialOutreachChannelId(channelId)) return null;
  const key = channelId.slice(SOCIAL_OUTREACH_CHANNEL_PREFIX.length);
  return CONTACT_KEY_PATTERN.test(key) ? key : null;
}
