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
      outcome: 'execution_failure',
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

  it.each([
    ['validation_rejection', 'rejected'],
    ['policy_denial', 'rejected'],
    ['duplicate_skip', 'skipped'],
    ['dependency_skip', 'skipped'],
  ] as const)('projects %s separately from execution failures', async (outcome, phase) => {
    const eventBus = new EventBus();
    const published: CompanionRelayPublishParams[] = [];
    const detach = attachCompanionEventForwarder({
      eventBus,
      publisher: { publishCompanionEvent: (params) => published.push(params) },
    });

    await eventBus.emit('agent.tool.end', {
      toolCallId: `call-${outcome}`,
      toolName: 'shell',
      outcome,
      isError: outcome === 'validation_rejection' || outcome === 'policy_denial',
    });

    expect(published[0]?.payload).toMatchObject({ phase, outcome });
    detach();
  });

  it('forwards a redacted emotion snapshot sourced from the agent bus', async () => {
    const eventBus = new EventBus();
    const published: CompanionRelayPublishParams[] = [];
    const detach = attachCompanionEventForwarder({
      eventBus,
      publisher: { publishCompanionEvent: (params) => published.push(params) },
    });

    await eventBus.emit('agent.emotion.snapshot', {
      trigger: 'vad_shift',
      vad: { valence: 0.123456, arousal: -0.654321, dominance: 0.5 },
      mood: { valence: 0.2, arousal: 0.111111, dominance: -0.9 },
      discrete: { joy: 0.812345, anger: 0.02 },
      confidence: 0.876543,
      acacAxisScores: { agency: 0.7 },
      channelId: 'chan-e',
      timestamp: 1_700_000_000_000,
    });

    expect(published).toHaveLength(1);
    const frame = published[0];
    expect(frame.kind).toBe('emotion.snapshot');
    expect(frame.channelId).toBe('chan-e');
    if (frame.kind !== 'emotion.snapshot') throw new Error('unreachable');
    // The forwarder redacts (rounds) before anything crosses the boundary.
    expect(frame.payload.vad).toEqual({ valence: 0.12, arousal: -0.65, dominance: 0.5 });
    expect(frame.payload.confidence).toBe(0.88);
    expect(frame.payload.discrete[0]).toEqual({ label: 'joy', score: 0.81 });
    expect(frame.payload.acacAxes).toEqual([{ axis: 'agency', score: 0.7 }]);
    expect(frame.payload.timestamp).toBe(new Date(1_700_000_000_000).toISOString());

    detach();
    await eventBus.emit('agent.emotion.snapshot', {
      trigger: 'post_turn',
      vad: { valence: 0, arousal: 0, dominance: 0 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      discrete: {},
      confidence: 0,
      channelId: 'chan-e',
      timestamp: 1_700_000_000_001,
    });
    expect(published).toHaveLength(1);
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
