import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { wireContactRuntime, type ContactRuntimeTarget } from './runtime-wiring.js';

class FakeTarget implements ContactRuntimeTarget {
  contactStore = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireContactRuntime', () => {
  it('injects ContactStore and registers all contact tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const contactStore = wireContactRuntime(target, db, 'primary-user-123');

    expect(target.contactStore).toBe(contactStore);
    expect(target.tools.map(t => t.name).sort()).toEqual([
      'contact_link_identity',
      'contact_list',
      'contact_lookup',
      'contact_note',
      'contact_set_channel_privacy',
      'contact_set_trust',
    ]);
  });

  it('threads primary user id into ContactStore behavior', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    wireContactRuntime(target, db, 'primary-user-123');
    const contact = target.contactStore!.resolveUserId('primary-user-123');
    expect(contact.trustLevel).toBe('primary');
  });
});

describe('entrypoint composition', () => {
  it('runtime.ts uses shared contact runtime wiring', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(runtimeSource).toContain('wireContactRuntime(');
  });

  it('agent-main.ts uses shared contact runtime wiring', () => {
    const agentMainSource = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(agentMainSource).toContain('wireContactRuntime(');
  });
});
