import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerController } from './composer-controller.js';
import { Composer } from './composer.js';

function makeController(overrides: Partial<ComposerController> = {}): ComposerController {
  return {
    attachmentMenuOpen: false,
    clearInput: vi.fn(),
    clearHumanScopedState: vi.fn(),
    resetInteraction: vi.fn(),
    input: '',
    inputRef: { current: null },
    micActive: false,
    setAttachmentMenuOpen: vi.fn(),
    setInput: vi.fn(),
    syncMicCapture: vi.fn(),
    voiceNotice: null,
    ...overrides,
  };
}

function renderComposer(props: {
  controller?: ComposerController;
  canSend?: boolean;
  voiceStopActive?: boolean;
  generationStopActive?: boolean;
  onSendText?: (text: string) => void;
  onStopGeneration?: () => void;
  onToggleMic?: () => void;
  onStopVoicePlayback?: () => void;
} = {}) {
  const controller = props.controller ?? makeController();
  const onSendText = props.onSendText ?? vi.fn();
  const onStopGeneration = props.onStopGeneration ?? vi.fn();
  render(
    <Composer
      canSend={props.canSend ?? true}
      controller={controller}
      generationStopActive={props.generationStopActive ?? false}
      onSendText={onSendText}
      onStopGeneration={onStopGeneration}
      onToggleMic={props.onToggleMic ?? vi.fn()}
      onStopVoicePlayback={props.onStopVoicePlayback ?? vi.fn()}
      voiceStopActive={props.voiceStopActive ?? false}
    />,
  );
  return { controller, onSendText, onStopGeneration };
}

describe('Composer stop-generation control', () => {
  it('does not collect files that the connection cannot send', () => {
    renderComposer({ controller: makeController({ attachmentMenuOpen: true }) });
    expect(screen.getByText(/File and photo sharing is not available yet/)).toBeTruthy();
    for (const name of ['Upload file', 'Upload image', 'Take photo']) {
      expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(screen.queryByText('Dictation')).toBeNull();
  });

  it('requests microphone capture only from the explicit mic button', () => {
    const onToggleMic = vi.fn();
    renderComposer({ onToggleMic });

    expect(onToggleMic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle voice chat' }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
  });

  it('exposes an explicit stop control that interrupts an in-flight assistant turn', () => {
    const { onStopGeneration } = renderComposer({ generationStopActive: true });

    const stopButton = screen.getByRole('button', { name: 'Stop generating' });
    expect((stopButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stopButton);
    expect(onStopGeneration).toHaveBeenCalledTimes(1);
  });

  it('keeps the send affordance while text is drafted during generation', () => {
    const { onStopGeneration } = renderComposer({
      controller: makeController({ input: 'steer the turn' }),
      generationStopActive: true,
    });

    expect(screen.queryByRole('button', { name: 'Stop generating' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(false);
    expect(onStopGeneration).not.toHaveBeenCalled();
  });

  it('keeps voice playback stop priority over generation stop', () => {
    const onStopVoicePlayback = vi.fn();
    const { onStopGeneration } = renderComposer({
      onStopVoicePlayback,
      generationStopActive: true,
      voiceStopActive: true,
    });

    const stopButton = screen.getByRole('button', { name: 'Stop voice playback' });
    fireEvent.click(stopButton);
    expect(onStopVoicePlayback).toHaveBeenCalledTimes(1);
    expect(onStopGeneration).not.toHaveBeenCalled();
  });

  it('shows a disabled send button when idle with no drafted text', () => {
    renderComposer();

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
  });
});
