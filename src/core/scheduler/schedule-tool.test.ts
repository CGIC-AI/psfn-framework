import { describe, expect, it, vi } from 'vitest';
import { createScheduleTool } from './schedule-tool.js';

describe('schedule tool', () => {
  it('groups model-facing actions by schedule domain and required arguments', () => {
    const tool = createScheduleTool({
      scheduler: {} as any,
      agentLoop: {} as any,
      sender: {} as any,
      heartbeatPolicyStore: {} as any,
      syncReflectionTasks: vi.fn(),
      runTemplate: vi.fn(),
    });

    expect(tool.description).toContain('Orientation: action=list');
    expect(tool.description).toContain('Follow-ups: create_follow_up needs content');
    expect(tool.description).toContain('activate_follow_up needs follow_up_id');
    expect(tool.description).toContain('Reminders: create_reminder needs title/content');
    expect(tool.description).toContain('trigger_reminder needs reminder_id');
    expect(tool.description).toContain('Templates: list_templates inspects them');
    expect(tool.description).toContain('update_template uses template_id for existing templates and id only when adding');
    expect(tool.description).toContain('Scheduled prompts: schedule_prompt needs name, prompt, and delay_minutes');
  });
});
