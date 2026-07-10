import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import type { Attachment } from '../../../shared/contracts/runtime.js';
import { attachCompanionEventForwarder } from './agent-forwarder.js';
import { emitCompanionArtifactCreatedEvents } from './artifact-emission.js';
import type { CompanionRelayPublishParams } from './relay.js';

describe('attachCompanionEventForwarder', () => {
  it('forwards redacted tool lifecycle events and drops error details', async () => {
    const eventBus = new EventBus();
    const published: CompanionRelayPublishParams[] = [];
    const detach = attachCompanionEventForwarder({
      eventBus,
      publisher: { publishCompanionEvent: (params) => published.push(params) },
    });

    await eventBus.emit('agent.tool.start', {
      channelId: 'chan-1',
      toolCallId: 'call-1',
      toolName: 'shell',
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'chan-1',
      toolCallId: 'call-1',
      toolName: 'shell',
      isError: true,
      errorMessage: 'ENOENT /companion-data/private/journal.md',
    });

    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      kind: 'tool.activity',
      channelId: 'chan-1',
      payload: { id: 'call-1', tool: 'shell', phase: 'started' },
    });
    expect(published[1].payload).toMatchObject({ phase: 'failed' });
    expect(JSON.stringify(published)).not.toContain('journal.md');

    detach();
    await eventBus.emit('agent.tool.start', {
      channelId: 'chan-1',
      toolCallId: 'call-2',
      toolName: 'shell',
    });
    expect(published).toHaveLength(2);
  });

  it('logs instead of throwing when the publisher fails', async () => {
    const eventBus = new EventBus();
    const detach = attachCompanionEventForwarder({
      eventBus,
      publisher: {
        publishCompanionEvent: () => {
          throw new Error('gateway connection lost');
        },
      },
    });
    await expect(eventBus.emit('agent.tool.start', {
      channelId: 'chan-1',
      toolCallId: 'call-1',
      toolName: 'shell',
    })).resolves.toBeUndefined();
    detach();
  });
});

describe('emitCompanionArtifactCreatedEvents', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'companion-artifacts-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits a redacted payload plus an in-process preview sidecar', async () => {
    const filePath = join(tempDir, 'render.png');
    writeFileSync(filePath, Buffer.alloc(64));
    const eventBus = new EventBus();
    const handler = vi.fn();
    eventBus.on('companion.artifact.created', handler);

    const attachment: Attachment = {
      url: 'https://provider.example/internal/render.png',
      contentType: 'image/png',
      name: 'render.png',
      localPath: filePath,
    };
    await emitCompanionArtifactCreatedEvents({
      eventBus,
      attachments: [attachment],
      channelId: 'chan-9',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.channelId).toBe('chan-9');
    expect(event.payload.previewable).toBe(true);
    expect(event.payload.label).toBe('render.png');
    expect(event.preview).toEqual({
      artifactId: event.payload.id,
      localPath: filePath,
      mediaType: 'image/png',
      sizeBytes: 64,
    });
    // The redacted payload itself never carries the path or source URL.
    expect(JSON.stringify(event.payload)).not.toContain(filePath);
    expect(JSON.stringify(event.payload)).not.toContain('provider.example');
  });

  it('announces unreadable attachments as non-previewable (fail closed)', async () => {
    const eventBus = new EventBus();
    const handler = vi.fn();
    eventBus.on('companion.artifact.created', handler);

    await emitCompanionArtifactCreatedEvents({
      eventBus,
      attachments: [{
        url: 'https://provider.example/render.png',
        contentType: 'image/png',
        name: 'render.png',
        localPath: join(tempDir, 'missing.png'),
      }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.payload.previewable).toBe(false);
    expect(event.preview).toBeUndefined();
  });
});
