import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

describe('agent completion-handoff wiring', () => {
  it('keeps child task results inside companion orchestration', () => {
    expect(mainSource).not.toContain('wireTaskLifecyclePartnerNotifications');
    expect(mainSource).not.toContain('task-lifecycle-author');
    expect(mainSource).not.toContain("channelId: 'internal:reflection:task-lifecycle-notification'");
  });
});
