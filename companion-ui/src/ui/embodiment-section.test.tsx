import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserEmbodimentStatus } from '../lib/api/primary-embodiment.js';
import { EmbodimentSection } from './embodiment-section.js';

const STATUS: BrowserEmbodimentStatus = {
  generation: 8, version: 9, primaryPresent: true, currentDeviceIsPrimary: false, lastDecision: null,
};
const PROPS = { companionId: 'companion-one', companionName: 'Mira', connected: true, signedIn: true };

function createStream() {
  return { primaryEmbodiment: {
    read: vi.fn<() => Promise<BrowserEmbodimentStatus>>().mockResolvedValue(STATUS),
    handoff: vi.fn<(generation: number) => Promise<BrowserEmbodimentStatus>>()
      .mockResolvedValue({ ...STATUS, generation: 9, currentDeviceIsPrimary: true }),
  } };
}

function deferredStatus() {
  let resolve!: (value: BrowserEmbodimentStatus) => void;
  const promise = new Promise<BrowserEmbodimentStatus>(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

describe('EmbodimentSection', () => {
  it('reads on connection and switches only on an explicit click using the observed generation', async () => {
    const stream = createStream();
    render(<EmbodimentSection {...PROPS} stream={stream} />);
    await screen.findByText('Another device is the primary embodiment.');
    expect(stream.primaryEmbodiment.handoff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this device as primary' }));
    expect(stream.primaryEmbodiment.handoff).toHaveBeenCalledExactlyOnceWith(8);
    await screen.findByText('This device is the primary embodiment.');
    expect((screen.getByRole('button', { name: 'Primary on this device' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows guest status reads but disables guest handoffs', async () => {
    const stream = createStream();
    render(<EmbodimentSection {...PROPS} signedIn={false} stream={stream} />);
    await screen.findByText('Another device is the primary embodiment.');
    expect(screen.getByText('Sign in as a Partner to switch primary embodiment.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Use this device as primary' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(stream.primaryEmbodiment.handoff).not.toHaveBeenCalled();
  });

  it('does not request authority while disconnected or on an unsupported transport', async () => {
    const stream = createStream();
    const { rerender } = render(<EmbodimentSection {...PROPS} connected={false} stream={stream} />);
    expect(screen.getByText('Connect to a companion to check this device.')).toBeTruthy();
    expect(stream.primaryEmbodiment.read).not.toHaveBeenCalled();
    rerender(<EmbodimentSection {...PROPS} stream={{ primaryEmbodiment: undefined }} />);
    expect(screen.getByText('Embodiment controls are unavailable on this connection.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refresh status' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears a previous companion projection and ignores its late response', async () => {
    const first = createStream();
    const oldReply = deferredStatus();
    first.primaryEmbodiment.read.mockReturnValue(oldReply.promise);
    const next = createStream();
    next.primaryEmbodiment.read.mockResolvedValue({ ...STATUS, generation: 2, primaryPresent: false });
    const { rerender } = render(<EmbodimentSection {...PROPS} stream={first} />);
    rerender(<EmbodimentSection {...PROPS} companionId="companion-two" companionName="Elara" stream={next} />);
    await screen.findByText('No device is currently the primary embodiment.');
    await act(async () => oldReply.resolve({ ...STATUS, currentDeviceIsPrimary: true }));
    expect(screen.queryByText('This device is the primary embodiment.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use this device as primary' }));
    await waitFor(() => expect(next.primaryEmbodiment.handoff).toHaveBeenCalledExactlyOnceWith(2));
    expect(first.primaryEmbodiment.handoff).not.toHaveBeenCalled();
  });

  it('drops disconnected status and waits for the replacement attachment to report its own generation', async () => {
    const first = createStream();
    const next = createStream();
    const nextReply = deferredStatus();
    next.primaryEmbodiment.read.mockReturnValue(nextReply.promise);
    const { rerender } = render(<EmbodimentSection {...PROPS} stream={first} />);
    await screen.findByText('Another device is the primary embodiment.');
    rerender(<EmbodimentSection {...PROPS} connected={false} stream={first} />);
    expect((screen.getByRole('button', { name: 'Use this device as primary' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<EmbodimentSection {...PROPS} stream={next} />);
    expect(screen.getByText('Checking primary embodiment…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Use this device as primary' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => nextReply.resolve({ ...STATUS, generation: 12 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this device as primary' }));
    await waitFor(() => expect(next.primaryEmbodiment.handoff).toHaveBeenCalledExactlyOnceWith(12));
  });

  it('requires a fresh read after an unconfirmed switch and never retries automatically', async () => {
    const stream = createStream();
    stream.primaryEmbodiment.handoff.mockRejectedValue(new Error('Sensitive authority details'));
    render(<EmbodimentSection {...PROPS} stream={stream} />);
    await screen.findByText('Another device is the primary embodiment.');
    fireEvent.click(screen.getByRole('button', { name: 'Use this device as primary' }));
    await screen.findByText('The switch could not be confirmed. Refresh the status before trying again.');
    expect(screen.queryByText('Sensitive authority details')).toBeNull();
    expect(stream.primaryEmbodiment.handoff).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Use this device as primary' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('Another device is the primary embodiment.');
    expect(stream.primaryEmbodiment.read).toHaveBeenCalledTimes(2);
    expect(stream.primaryEmbodiment.handoff).toHaveBeenCalledTimes(1);
  });
});
