import { describe, expect, it } from 'vitest';
import { serializeModelUsageQuery } from './model-usage-query';

describe('serializeModelUsageQuery', () => {
  it('canonically percent-encodes every timezone entry', () => {
    const params = new URLSearchParams();
    params.append('sometimezone', 'America/New_York');
    params.append('timezone', 'America/New_York');
    params.append('timezone', 'Europe/Paris');

    expect(serializeModelUsageQuery(params)).toBe(
      'sometimezone=America%2FNew_York'
        + '&timezone=America%2FNew_York'
        + '&timezone=Europe%2FParis',
    );
  });

  it('does not special-case malformed timezone names', () => {
    const params = new URLSearchParams();
    params.append('timezone', 'America/New_York');
    params.append('timezone', 'Not/A_Timezone');

    expect(serializeModelUsageQuery(params)).toBe(
      'timezone=America%2FNew_York&timezone=Not%2FA_Timezone',
    );
  });
});
