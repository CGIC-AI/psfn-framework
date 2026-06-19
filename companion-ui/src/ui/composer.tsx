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
  controller,
  onSendText,
}: {
  canSend: boolean;
  voiceStopActive: boolean;
  controller: ComposerController;
  onSendText: (text: string) => void;
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
      <button
        className={`send-button ${voiceStopActive ? 'stop-playback' : ''}`}
        type={voiceStopActive ? 'button' : 'submit'}
        onClick={voiceStopActive ? controller.stopVoicePlayback : undefined}
        disabled={!voiceStopActive && (!canSend || !controller.input.trim())}
        aria-label={voiceStopActive ? 'Stop voice playback' : 'Send message'}
      >
        {voiceStopActive ? <CircleStop aria-hidden /> : <Send aria-hidden />}
      </button>
    </form>
  );
}
