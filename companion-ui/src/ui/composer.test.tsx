import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerController } from './composer-controller.js';
import { Composer } from './composer.js';

function makeController(overrides: Partial<ComposerController> = {}): ComposerController {
  return {
    attachmentMenuOpen: false,
    cameraInputRef: { current: null },
    clearInput: vi.fn(),
    fileInputRef: { current: null },
    handleAttachmentFiles: vi.fn(),
    imageInputRef: { current: null },
    input: '',
    inputRef: { current: null },
    micActive: false,
    micMode: 'dictation',
    openAttachmentPicker: vi.fn(),
    pendingAttachments: [],
    removeAttachment: vi.fn(),
    selectMicMode: vi.fn(),
    setAttachmentMenuOpen: vi.fn(),
    setInput: vi.fn(),
    stopVoicePlayback: vi.fn(),
    toggleMic: vi.fn(),
    toggleMicMode: vi.fn(),
    voiceNotice: null,
    ...overrides,
  } as ComposerController;
}

function renderComposer(props: {
  controller?: ComposerController;
  canSend?: boolean;
  voiceStopActive?: boolean;
  generationStopActive?: boolean;
  onSendText?: (text: string) => void;
  onStopGeneration?: () => void;
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
      voiceStopActive={props.voiceStopActive ?? false}
    />,
  );
  return { controller, onSendText, onStopGeneration };
}

describe('Composer stop-generation control', () => {
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
    const controller = makeController({ micMode: 'voice' });
    const { onStopGeneration } = renderComposer({
      controller,
      generationStopActive: true,
      voiceStopActive: true,
    });

    const stopButton = screen.getByRole('button', { name: 'Stop voice playback' });
    fireEvent.click(stopButton);
    expect(controller.stopVoicePlayback).toHaveBeenCalledTimes(1);
    expect(onStopGeneration).not.toHaveBeenCalled();
  });

  it('shows a disabled send button when idle with no drafted text', () => {
    renderComposer();

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
  });
});
