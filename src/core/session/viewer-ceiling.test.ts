import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import {
  capChannelPrivacyToCeiling,
  captureViewerCeilingFromRequest,
  capTrustLevelToCeiling,
  hasAdmittedViewerContext,
  type ViewerCeiling,
} from './viewer-ceiling.js';

const PUBLIC_ROOM: ViewerCeiling = { trustLevel: 'public', channelPrivacy: 'public', sourceChannelId: 'api:lobby' };
const TRUSTED_GROUP: ViewerCeiling = { trustLevel: 'trusted', channelPrivacy: 'invite_only', sourceChannelId: 'api:group' };

describe('viewer ceiling (psfn-framework-mzytp)', () => {
  it('never lets a worker exceed the spawning viewer', () => {
    expect(capTrustLevelToCeiling('primary', PUBLIC_ROOM)).toBe('public');
    expect(capTrustLevelToCeiling('regular', TRUSTED_GROUP)).toBe('regular');
    expect(capTrustLevelToCeiling('primary', TRUSTED_GROUP)).toBe('trusted');
    expect(capChannelPrivacyToCeiling('private', PUBLIC_ROOM)).toBe('public');
    expect(capChannelPrivacyToCeiling('private', TRUSTED_GROUP)).toBe('invite_only');
    expect(capChannelPrivacyToCeiling('public', TRUSTED_GROUP)).toBe('public');
  });

  it('captures the admitted viewer and refuses when it is missing', async () => {
    await runWithRequestContext({
      channelId: 'api:lobby', viewerTrustLevel: 'public', viewerChannelPrivacy: 'public',
    }, async () => {
      expect(hasAdmittedViewerContext()).toBe(true);
      expect(captureViewerCeilingFromRequest('Test spawn')).toEqual(PUBLIC_ROOM);
    });
    await runWithRequestContext({ channelId: 'api:lobby', viewerTrustLevel: 'public' }, async () => {
      expect(hasAdmittedViewerContext()).toBe(false);
      expect(() => captureViewerCeilingFromRequest('Test spawn')).toThrow(/Test spawn refused/);
    });
    expect(() => captureViewerCeilingFromRequest('Test spawn')).toThrow(/no admitted viewer context/);
  });
});
