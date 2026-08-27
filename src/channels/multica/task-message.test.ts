import { describe, expect, it } from 'vitest';
import type { MulticaClaimedTask } from './protocol.js';
import { toMulticaSubstrateMessage } from './task-message.js';

const BASE_TASK: MulticaClaimedTask = {
  id: '44444444-4444-4444-8444-444444444444',
  runtime_id: '33333333-3333-4333-8333-333333333333',
  workspace_id: '11111111-1111-4111-8111-111111111111',
};

describe('Multica task message attribution', () => {
  it('keeps an unattributed automated task on the workspace system identity', async () => {
    await expect(toMulticaSubstrateMessage(BASE_TASK, null, null)).resolves.toMatchObject({
      authorId: `multica:system:${BASE_TASK.workspace_id}`,
      authorName: 'Multica system',
      routing: { authorIsMachineIntelligence: true },
    });
  });

  it('keeps an agent-originated task on a distinct machine identity', async () => {
    await expect(toMulticaSubstrateMessage({
      ...BASE_TASK,
      initiator_type: 'agent',
      initiator_id: '88888888-8888-4888-8888-888888888888',
      initiator_name: 'Review unit',
    }, null, null)).resolves.toMatchObject({
      authorId: 'multica:agent:88888888-8888-4888-8888-888888888888',
      authorName: 'Review unit',
      routing: { authorIsMachineIntelligence: true },
    });
  });
});
