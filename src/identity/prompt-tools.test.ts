import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { PromptLayerStore } from './prompt-store.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createPromptLayerUpdateTool,
  createPromptLayerToggleTool,
} from './prompt-tools.js';

/** Extract text from an AgentToolResult */
function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}

describe('Prompt Layer Tools', () => {
  let tmpDir: string;
  let store: PromptLayerStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-tools-'));
    store = new PromptLayerStore(
      join(tmpDir, 'layers.json'),
      join(tmpDir, 'history.jsonl'),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('prompt_layer_list', () => {
    it('returns message when no layers exist', async () => {
      const tool = createPromptLayerListTool(store);
      const result = await tool.execute('test', {});
      const text = resultText(result);

      expect(text).toBe('No prompt layers configured.');
    });

    it('lists all layers with their details', async () => {
      store.create({ type: 'base', name: 'Base', content: 'base content' });
      store.create({ type: 'runtime', name: 'Runtime', content: 'runtime content', priority: 5 });
      store.create({ type: 'channel', name: 'Discord', content: 'discord', channelType: 'discord_text' });

      const tool = createPromptLayerListTool(store);
      const result = await tool.execute('test', {});
      const text = resultText(result);

      expect(text).toContain('[ON] base/Base');
      expect(text).toContain('[ON] runtime/Runtime');
      expect(text).toContain('priority=5');
      expect(text).toContain('channel=discord_text');
    });
  });

  describe('prompt_layer_get', () => {
    it('returns full layer details', async () => {
      const layer = store.create({ type: 'base', name: 'Test Base', content: 'You are helpful.' });
      const tool = createPromptLayerGetTool(store);

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('ID: ' + layer.id);
      expect(text).toContain('Type: base');
      expect(text).toContain('Name: Test Base');
      expect(text).toContain('You are helpful.');
    });

    it('handles prefix match', async () => {
      const layer = store.create({ type: 'base', name: 'Test', content: 'content' });
      const prefix = layer.id.slice(0, 8);

      const tool = createPromptLayerGetTool(store);
      const result = await tool.execute('test', { layer_id: prefix });
      const text = resultText(result);

      expect(text).toContain('Name: Test');
    });

    it('returns not found for unknown id', async () => {
      const tool = createPromptLayerGetTool(store);
      const result = await tool.execute('test', { layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
    });
  });

  describe('prompt_layer_update', () => {
    it('blocks agent from modifying base layers', async () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'original' });
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Cannot modify base layers');
      expect(store.getById(layer.id)?.content).toBe('original');
    });

    it('blocks agent from modifying operator layers', async () => {
      const layer = store.create({ type: 'operator', name: 'Operator', content: 'original' });
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: layer.id, content: 'modified' });
      const text = resultText(result);

      expect(text).toContain('Cannot modify operator layers');
    });

    it('allows agent to modify runtime layers', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: layer.id, content: 'modified by agent' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
      expect(text).toContain('v2');
      expect(store.getById(layer.id)?.content).toBe('modified by agent');
      expect(store.getById(layer.id)?.updatedBy).toBe('agent');
    });

    it('allows agent to modify channel layers', async () => {
      const layer = store.create({ type: 'channel', name: 'Discord', content: 'original', channelType: 'discord_text' });
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: layer.id, content: 'updated' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
    });

    it('allows agent to modify task layers', async () => {
      const layer = store.create({ type: 'task', name: 'Heartbeat', content: 'original', taskKind: 'heartbeat' });
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: layer.id, content: 'updated' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
    });

    it('supports prefix match for layer id', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'original' });
      const prefix = layer.id.slice(0, 8);
      const tool = createPromptLayerUpdateTool(store);

      const result = await tool.execute('test', { layer_id: prefix, content: 'updated' });
      const text = resultText(result);

      expect(text).toContain('Updated layer');
      expect(store.getById(layer.id)?.content).toBe('updated');
    });
  });

  describe('prompt_layer_toggle', () => {
    it('blocks agent from disabling base layers', async () => {
      const layer = store.create({ type: 'base', name: 'Base', content: 'base' });
      const tool = createPromptLayerToggleTool(store);

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('Cannot disable base layers');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('allows agent to toggle runtime layers', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      const tool = createPromptLayerToggleTool(store);

      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('disabled');
      expect(store.getById(layer.id)?.enabled).toBe(false);
    });

    it('allows re-enabling a disabled layer', async () => {
      const layer = store.create({ type: 'runtime', name: 'Runtime', content: 'runtime' });
      store.toggle(layer.id); // disable
      expect(store.getById(layer.id)?.enabled).toBe(false);

      const tool = createPromptLayerToggleTool(store);
      const result = await tool.execute('test', { layer_id: layer.id });
      const text = resultText(result);

      expect(text).toContain('enabled');
      expect(store.getById(layer.id)?.enabled).toBe(true);
    });

    it('returns not found for unknown layer', async () => {
      const tool = createPromptLayerToggleTool(store);
      const result = await tool.execute('test', { layer_id: 'nonexistent' });
      const text = resultText(result);

      expect(text).toContain('Layer not found');
    });
  });
});
