import { describe, expect, it } from 'vitest';
import {
  buildSessionMessagesPath,
  SESSION_MESSAGE_PAGE_SIZE,
} from './sessions';

describe('session admin endpoint paths', () => {
  it('builds bounded session-message requests with cursor pagination', () => {
    expect(SESSION_MESSAGE_PAGE_SIZE).toBe(100);
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      beforeId: 42,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100&beforeId=42');
  });

  it('omits nullable cursor params for the initial newest-message page', () => {
    expect(buildSessionMessagesPath('api:session one', {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      beforeId: null,
    })).toBe('/api/admin/sessions/api%3Asession%20one?limit=100');
  });
});
