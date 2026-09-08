import {
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  CircleStop,
  Mic,
  Plus,
  Send,
} from 'lucide-react';
import type { ComposerController } from './composer-controller.js';
import { AttachmentMenu } from './context-layers.js';

export function Composer({
  canSend,
  voiceStopActive,
  generationStopActive,
  controller,
  onSendText,
  onStopGeneration,
  onStopVoicePlayback,
  onToggleMic,
  targetLabel,
}: {
  canSend: boolean;
  voiceStopActive: boolean;
  generationStopActive: boolean;
  controller: ComposerController;
  onSendText: (text: string) => void;
  onStopGeneration: () => void;
  onStopVoicePlayback: () => void;
  onToggleMic: () => void;
  targetLabel?: string;
}) {
  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = controller.input.trim();
    if (!canSend || !text) return;
    onSendText(text);
    controller.clearInput();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <form className="composer-shell" onSubmit={submit}>
      <div className="composer-menu-wrap">
        <button
          className="composer-button"
          type="button"
          onClick={() => controller.setAttachmentMenuOpen((value) => !value)}
          aria-expanded={controller.attachmentMenuOpen}
          aria-label="Open attachment menu"
        >
          <Plus aria-hidden />
        </button>
        {controller.attachmentMenuOpen && <AttachmentMenu />}
      </div>
      <textarea
        ref={controller.inputRef}
        value={controller.input}
        onChange={(event) => controller.setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={targetLabel ? `Message shard ${targetLabel}...` : 'Message your companion...'}
        rows={1}
        disabled={!canSend}
        aria-label={targetLabel ? `Message shard ${targetLabel}` : 'Message your companion'}
      />
      <div className="mic-control">
        <button
          className={`composer-button mic-button ${controller.micActive ? 'active' : ''} voice`}
          type="button"
          onClick={onToggleMic}
          disabled={!canSend}
          title="Voice chat sends spoken turns to your companion"
          aria-label="Toggle voice chat"
        >
          <Mic aria-hidden />
        </button>
        <span className="mic-mode">Voice</span>
      </div>
      <StopOrSendButton
        canSend={canSend}
        generationStopActive={generationStopActive}
        hasText={Boolean(controller.input.trim())}
        onStopGeneration={onStopGeneration}
        onStopVoicePlayback={onStopVoicePlayback}
        voiceStopActive={voiceStopActive}
      />
    </form>
  );
}

/**
 * Voice playback stop keeps priority; otherwise an in-flight companion turn
 * with no drafted text exposes an explicit stop-generation control so people
 * can interrupt without sending a new message or disconnecting. Drafted text
 * keeps the send affordance, which already interrupts on send.
 */
function StopOrSendButton({
  canSend,
  generationStopActive,
  hasText,
  onStopGeneration,
  onStopVoicePlayback,
  voiceStopActive,
}: {
  canSend: boolean;
  generationStopActive: boolean;
  hasText: boolean;
  onStopGeneration: () => void;
  onStopVoicePlayback: () => void;
  voiceStopActive: boolean;
}) {
  const stopGenerationActive = !voiceStopActive && generationStopActive && !hasText;
  const stopActive = voiceStopActive || stopGenerationActive;
  const onStop = voiceStopActive ? onStopVoicePlayback : onStopGeneration;
  return (
    <button
      className={`send-button ${stopActive ? 'stop-playback' : ''}`}
      type={stopActive ? 'button' : 'submit'}
      onClick={stopActive ? onStop : undefined}
      disabled={!stopActive && (!canSend || !hasText)}
      aria-label={voiceStopActive
        ? 'Stop voice playback'
        : stopGenerationActive
          ? 'Stop generating'
          : 'Send message'}
    >
      {stopActive ? <CircleStop aria-hidden /> : <Send aria-hidden />}
    </button>
  );
}
