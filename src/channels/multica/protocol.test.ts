import { describe, expect, it } from 'vitest';
import { parseClaimResponse } from './protocol.js';

const BASE_TASK = {
  id: '44444444-4444-4444-8444-444444444444',
  runtime_id: '33333333-3333-4333-8333-333333333333',
  workspace_id: '11111111-1111-4111-8111-111111111111',
};

describe('Multica claim protocol', () => {
  it('preserves an exact member initiator identity', () => {
    expect(parseClaimResponse({
      task: {
        ...BASE_TASK,
        initiator_type: 'member',
        initiator_id: '99999999-9999-4999-8999-999999999999',
        initiator_name: 'Operator',
      },
    })).toMatchObject({
      initiator_type: 'member',
      initiator_id: '99999999-9999-4999-8999-999999999999',
      initiator_name: 'Operator',
    });
  });

  it.each([
    { initiator_type: 'member' },
    { initiator_id: '99999999-9999-4999-8999-999999999999' },
    { initiator_type: 'human', initiator_id: '99999999-9999-4999-8999-999999999999' },
    { initiator_type: 'member', initiator_id: 'not-a-uuid' },
  ])('rejects malformed initiator authority %#', initiator => {
    expect(() => parseClaimResponse({ task: { ...BASE_TASK, ...initiator } })).toThrow(/initiator/);
  });
});
