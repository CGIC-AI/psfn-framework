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
}: {
  canSend: boolean;
  voiceStopActive: boolean;
  generationStopActive: boolean;
  controller: ComposerController;
  onSendText: (text: string) => void;
  onStopGeneration: () => void;
}) {
  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = controller.input.trim();
    if (!text) return;
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
        {controller.attachmentMenuOpen && <AttachmentMenu onPick={controller.openAttachmentPicker} />}
        <input
          ref={controller.fileInputRef}
          className="hidden-file-input"
          type="file"
          multiple
          onChange={(event) => controller.handleAttachmentFiles(event, 'file')}
        />
        <input
          ref={controller.imageInputRef}
          className="hidden-file-input"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => controller.handleAttachmentFiles(event, 'image')}
        />
        <input
          ref={controller.cameraInputRef}
          className="hidden-file-input"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => controller.handleAttachmentFiles(event, 'camera')}
        />
      </div>
      <textarea
        ref={controller.inputRef}
        value={controller.input}
        onChange={(event) => controller.setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message your companion..."
        rows={1}
        disabled={!canSend}
        aria-label="Message your companion"
      />
      <div className="mic-control">
        <button
          className={`composer-button mic-button ${controller.micActive ? 'active' : ''} ${controller.micMode}`}
          type="button"
          onClick={controller.toggleMic}
          title={controller.micMode === 'dictation' ? 'Dictation' : 'Voice chat'}
          aria-label={controller.micMode === 'dictation' ? 'Toggle dictation' : 'Toggle voice chat'}
        >
          <Mic aria-hidden />
        </button>
        <button className="mic-mode" type="button" onClick={controller.toggleMicMode}>
          {controller.micMode === 'dictation' ? 'Dictation' : 'Voice'}
        </button>
      </div>
      <StopOrSendButton
        canSend={canSend}
        generationStopActive={generationStopActive}
        hasText={Boolean(controller.input.trim())}
        onStopGeneration={onStopGeneration}
        onStopVoicePlayback={controller.stopVoicePlayback}
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
