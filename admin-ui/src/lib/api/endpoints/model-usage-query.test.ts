import { describe, expect, it } from 'vitest';
import { serializeModelUsageQuery } from './model-usage-query';

describe('serializeModelUsageQuery', () => {
  it('canonicalizes every valid timezone entry without matching key suffixes', () => {
    const params = new URLSearchParams();
    params.append('sometimezone', 'America/New_York');
    params.append('timezone', 'America/New_York');
    params.append('timezone', 'Europe/Paris');

    expect(serializeModelUsageQuery(params)).toBe(
      'sometimezone=America%2FNew_York'
        + '&timezone=America/New_York'
        + '&timezone=Europe/Paris',
    );
  });

  it('keeps malformed timezone separators encoded', () => {
    const params = new URLSearchParams();
    params.append('timezone', 'America/New_York');
    params.append('timezone', 'Not/A_Timezone');

    expect(serializeModelUsageQuery(params)).toBe(
      'timezone=America/New_York&timezone=Not%2FA_Timezone',
    );
  });
});
