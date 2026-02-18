import { describe, expect, it } from 'vitest';
import type {
  VoiceControlCommand,
  VoiceControlFrame,
  VoiceDataFrame,
  VoiceFrame,
} from './frames.js';
import { ControlPriorityFrameQueue } from './queue.js';

const STREAM_ID = 'test-stream';

function controlFrame(sequence: number, command: VoiceControlCommand): VoiceControlFrame {
  return {
    kind: 'control',
    sequence,
    timestampMs: sequence,
    streamId: STREAM_ID,
    interruptible: false,
    payload: { command },
  };
}

function transcriptPartialFrame(sequence: number, interruptible = true): VoiceDataFrame {
  return {
    kind: 'transcript.partial',
    sequence,
    timestampMs: sequence,
    streamId: STREAM_ID,
    interruptible,
    payload: {
      text: `partial-${sequence}`,
    },
  };
}

function audioOutputFrame(sequence: number, interruptible = true): VoiceDataFrame {
  return {
    kind: 'audio.output.chunk',
    sequence,
    timestampMs: sequence,
    streamId: STREAM_ID,
    interruptible,
    payload: {
      data: new Uint8Array([sequence]),
      format: 'pcm16le',
      sampleRateHz: 48_000,
      channels: 2,
    },
  };
}

function dequeueAll(queue: ControlPriorityFrameQueue): VoiceFrame[] {
  const frames: VoiceFrame[] = [];
  while (!queue.isEmpty) {
    const frame = queue.dequeue();
    if (!frame) break;
    frames.push(frame);
  }
  return frames;
}

describe('ControlPriorityFrameQueue', () => {
  it('keeps FIFO order for non-control frames', () => {
    const queue = new ControlPriorityFrameQueue();
    queue.enqueue(transcriptPartialFrame(1));
    queue.enqueue(audioOutputFrame(2));
    queue.enqueue(transcriptPartialFrame(3));

    const ordered = dequeueAll(queue).map((frame) => frame.sequence);
    expect(ordered).toEqual([1, 2, 3]);
  });

  it('always dequeues control frames before data frames', () => {
    const queue = new ControlPriorityFrameQueue();
    queue.enqueue(transcriptPartialFrame(10));
    queue.enqueue(audioOutputFrame(20));
    queue.enqueue(controlFrame(99, 'stop'));

    const dequeued = dequeueAll(queue);
    expect(dequeued.map((frame) => frame.kind)).toEqual([
      'control',
      'transcript.partial',
      'audio.output.chunk',
    ]);
    expect(dequeued.map((frame) => frame.sequence)).toEqual([99, 10, 20]);
  });

  it('interrupt controls purge only interruptible queued data', () => {
    const queue = new ControlPriorityFrameQueue();
    queue.enqueue(transcriptPartialFrame(1, true));
    queue.enqueue(audioOutputFrame(2, false));
    queue.enqueue(transcriptPartialFrame(3, true));

    const result = queue.enqueue(controlFrame(4, 'interrupt'));
    expect(result.droppedInterruptible).toBe(2);

    const dequeued = dequeueAll(queue);
    expect(dequeued.map((frame) => frame.kind)).toEqual(['control', 'audio.output.chunk']);
    expect(dequeued.map((frame) => frame.sequence)).toEqual([4, 2]);
  });

  it('supports overriding which control commands are interrupting', () => {
    const queue = new ControlPriorityFrameQueue({
      interruptCommands: ['interrupt'],
    });

    queue.enqueue(transcriptPartialFrame(1, true));
    const result = queue.enqueue(controlFrame(2, 'cancel'));
    expect(result.droppedInterruptible).toBe(0);

    const dequeued = dequeueAll(queue);
    expect(dequeued.map((frame) => frame.sequence)).toEqual([2, 1]);
  });
});
