import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../../memory/types.js';
import type { PromptLayer } from '../../identity/prompt-types.js';
import { layout, loginPage, memoryRow, promptLayersFragment } from './templates.js';

describe('admin templates', () => {
  it('renders layout with external stylesheet', () => {
    const html = layout('Dashboard', '<div>body</div>', 'dashboard');
    expect(html).toContain('<link rel="stylesheet" href="/static/admin.css">');
    expect(html).toContain('<script src="/static/htmx.min.js"></script>');
    expect(html).toContain('<script src="/static/sse.js"></script>');
  });

  it('escapes login errors', () => {
    const html = loginPage('<invalid>"token"');
    expect(html).toContain('&lt;invalid&gt;&quot;token&quot;');
  });

  it('escapes memory row text and encodes ids', () => {
    const memory: PurrMemory = {
      id: 'id with spaces/and/slash',
      text: '<script>alert("x")</script>',
      type: 'semantic',
      importance: 0.5,
      confidence: 0.6,
      emotionalValence: 0.1,
      salience: 0.7,
      sourceRef: 'test:1',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
      tags: [],
      sensitivity: 'public',
    };

    const html = memoryRow(memory);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('/memory/id%20with%20spaces%2Fand%2Fslash');
    expect(html).toContain('/api/memory/id%20with%20spaces%2Fand%2Fslash/supersede');
  });

  it('sorts prompt layers by type order then priority', () => {
    const baseLayer: PromptLayer = {
      id: 'base-1',
      type: 'base',
      name: 'Base',
      content: 'base content',
      enabled: true,
      priority: 10,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'abc123',
      version: 1,
    };

    const runtimeLayer: PromptLayer = {
      id: 'runtime-1',
      type: 'runtime',
      name: 'Runtime',
      content: 'runtime content',
      enabled: true,
      priority: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'def456',
      version: 1,
    };

    const operatorLayer: PromptLayer = {
      id: 'operator-1',
      type: 'operator',
      name: 'Operator',
      content: 'operator content',
      enabled: true,
      priority: 5,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
      checksum: 'ghi789',
      version: 1,
    };

    const html = promptLayersFragment([runtimeLayer, operatorLayer, baseLayer]);
    const basePos = html.indexOf('/prompts/base-1');
    const operatorPos = html.indexOf('/prompts/operator-1');
    const runtimePos = html.indexOf('/prompts/runtime-1');

    expect(basePos).toBeGreaterThanOrEqual(0);
    expect(operatorPos).toBeGreaterThan(basePos);
    expect(runtimePos).toBeGreaterThan(operatorPos);
  });
});
