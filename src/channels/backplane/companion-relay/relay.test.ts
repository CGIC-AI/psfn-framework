import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import type { CompanionEventEnvelope } from '../../../shared/contracts/companion-relay.js';
import { companionEventKindsForScopes } from '../../../shared/contracts/companion-relay.js';
import {
  CompanionEventRelay,
  parseCompanionRelayPublishParams,
} from './relay.js';

describe('companionEventKindsForScopes', () => {
  it('denies by default and maps scopes to kinds', () => {
    expect(companionEventKindsForScopes([])).toEqual([]);
    expect(companionEventKindsForScopes(['location', 'presence'])).toEqual([]);
    expect(companionEventKindsForScopes(['approvals'])).toEqual([
      'approval.requested',
      'approval.resolved',
    ]);
    expect(companionEventKindsForScopes(['artifacts', 'tool_activity'])).toEqual([
      'artifact.created',
      'tool.activity',
    ]);
  });
});

describe('CompanionEventRelay', () => {
  let tempDir: string;
  let eventBus: EventBus;
  let relay: CompanionEventRelay;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'companion-relay-'));
    eventBus = new EventBus();
    relay = new CompanionEventRelay({
      eventBus,
      previewRoots: [tempDir],
      maxPreviewBytes: 1_000,
    });
  });

  afterEach(() => {
    relay.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function collect(kinds: Parameters<CompanionEventRelay['subscribe']>[0]['allowedKinds']): CompanionEventEnvelope[] {
    const received: CompanionEventEnvelope[] = [];
    relay.subscribe({ allowedKinds: kinds, onEvent: (e) => received.push(e) });
    return received;
  }

  it('fans out bus events only to subscribers scoped for the kind', async () => {
    const approvalsOnly = collect(['approval.requested', 'approval.resolved']);
    const toolsOnly = collect(['tool.activity']);

    await eventBus.emit('companion.approval.requested', {
      payload: {
        id: 'conf-1',
        title: 'write file: /workspace/todo.txt',
        requestedAt: new Date(1).toISOString(),
        redactedContext: 'Updating the shared todo list',
        status: 'pending',
      },
      timestamp: Date.now(),
    });
    await eventBus.emit('companion.tool.activity', {
      payload: {
        id: 'call-1',
        tool: 'shell',
        phase: 'started',
        timestamp: new Date(2).toISOString(),
      },
      channelId: 'chan-1',
      timestamp: Date.now(),
    });

    expect(approvalsOnly).toHaveLength(1);
    expect(approvalsOnly[0].kind).toBe('approval.requested');
    expect(approvalsOnly[0].emittedAt).toBeTruthy();
    expect(toolsOnly).toHaveLength(1);
    expect(toolsOnly[0].kind).toBe('tool.activity');
    expect(toolsOnly[0].channelId).toBe('chan-1');
  });

  it('registers artifact previews inside the preview roots and strips the sidecar from envelopes', async () => {
    const filePath = join(tempDir, 'img.png');
    writeFileSync(filePath, Buffer.alloc(100));
    const received = collect(['artifact.created']);

    await eventBus.emit('companion.artifact.created', {
      payload: {
        id: 'art-1',
        label: 'img.png',
        mediaType: 'image/png',
        provenance: 'image_generation',
        createdAt: new Date(3).toISOString(),
        previewable: true,
      },
      preview: {
        artifactId: 'art-1',
        localPath: filePath,
        mediaType: 'image/png',
        sizeBytes: 100,
      },
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain(filePath);
    const source = relay.getPreviewSource('art-1');
    expect(source?.localPath).toBe(filePath);
    expect(source?.previewable).toBe(true);
  });

  it('rejects preview registrations outside every preview root (fail closed)', async () => {
    await eventBus.emit('companion.artifact.created', {
      payload: {
        id: 'art-2',
        label: 'escape.png',
        mediaType: 'image/png',
        provenance: 'image_generation',
        createdAt: new Date(4).toISOString(),
        previewable: true,
      },
      preview: {
        artifactId: 'art-2',
        localPath: join(tempDir, '..', 'outside.png'),
        mediaType: 'image/png',
        sizeBytes: 10,
      },
      timestamp: Date.now(),
    });
    expect(relay.getPreviewSource('art-2')).toBeNull();
  });

  it('marks oversized previews non-previewable', async () => {
    const filePath = join(tempDir, 'big.png');
    writeFileSync(filePath, Buffer.alloc(10));
    await eventBus.emit('companion.artifact.created', {
      payload: {
        id: 'art-3',
        label: 'big.png',
        mediaType: 'image/png',
        provenance: 'image_generation',
        createdAt: new Date(5).toISOString(),
        previewable: true,
      },
      preview: {
        artifactId: 'art-3',
        localPath: filePath,
        mediaType: 'image/png',
        sizeBytes: 5_000, // exceeds maxPreviewBytes: 1_000
      },
      timestamp: Date.now(),
    });
    expect(relay.getPreviewSource('art-3')?.previewable).toBe(false);
  });

  it('drops a subscriber whose handler throws instead of failing the publish', async () => {
    let healthyDeliveries = 0;
    relay.subscribe({
      allowedKinds: ['tool.activity'],
      onEvent: () => {
        throw new Error('subscriber boom');
      },
    });
    relay.subscribe({
      allowedKinds: ['tool.activity'],
      onEvent: () => {
        healthyDeliveries += 1;
      },
    });

    const emit = () => eventBus.emit('companion.tool.activity', {
      payload: { id: 'c', tool: 't', phase: 'started', timestamp: new Date(6).toISOString() },
      timestamp: Date.now(),
    });
    await emit();
    await emit();
    expect(healthyDeliveries).toBe(2);
    expect(relay.subscriberCount()).toBe(1);
  });
});

describe('parseCompanionRelayPublishParams', () => {
  it('rejects approval kinds and malformed frames outright', () => {
    expect(() => parseCompanionRelayPublishParams(null)).toThrow(/params/);
    expect(() => parseCompanionRelayPublishParams({ kind: 'approval.requested', payload: {} }))
      .toThrow(/kind/);
    expect(() => parseCompanionRelayPublishParams({ kind: 'tool.activity', payload: { id: 'x' } }))
      .toThrow();
    expect(() => parseCompanionRelayPublishParams({
      kind: 'tool.activity',
      payload: { id: 'x', tool: 't', phase: 'sideways', timestamp: new Date().toISOString() },
    })).toThrow(/phase/);
  });

  it('reconstructs payloads field-by-field, dropping smuggled extras', () => {
    const parsed = parseCompanionRelayPublishParams({
      kind: 'tool.activity',
      channelId: 'chan-9',
      payload: {
        id: 'call-9',
        tool: 'shell',
        phase: 'completed',
        timestamp: new Date(7).toISOString(),
        arguments: { command: 'cat /etc/shadow' },
        output: 'root:...',
      },
    });
    expect(parsed.kind).toBe('tool.activity');
    expect(Object.keys(parsed.payload).sort()).toEqual(['id', 'phase', 'timestamp', 'tool']);
    expect(JSON.stringify(parsed)).not.toContain('shadow');
  });

  it('parses artifact frames with an optional preview sidecar', () => {
    const parsed = parseCompanionRelayPublishParams({
      kind: 'artifact.created',
      payload: {
        id: 'art-9',
        label: 'render.png',
        mediaType: 'image/png',
        provenance: 'image_generation',
        createdAt: new Date(8).toISOString(),
        previewable: true,
      },
      preview: {
        artifactId: 'art-9',
        localPath: '/companion-data/media/generated-images/render.png',
        mediaType: 'image/png',
        sizeBytes: 42,
      },
    });
    expect(parsed.kind).toBe('artifact.created');
    if (parsed.kind !== 'artifact.created') throw new Error('unreachable');
    expect(parsed.preview?.sizeBytes).toBe(42);
    expect(() => parseCompanionRelayPublishParams({
      kind: 'artifact.created',
      payload: {
        id: 'art-10',
        label: 'x',
        mediaType: 'image/png',
        provenance: 'p',
        createdAt: new Date(9).toISOString(),
        previewable: true,
      },
      preview: { artifactId: 'art-10', localPath: '/tmp/x', mediaType: 'image/png', sizeBytes: -5 },
    })).toThrow(/sizeBytes/);
  });
});
