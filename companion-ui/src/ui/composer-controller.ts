import {
  type ChangeEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AttachmentKind, MicMode, PendingAttachment } from './types.js';

export function useComposerController() {
  const [input, setInput] = useState('');
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [micMode, setMicMode] = useState<MicMode>('dictation');
  const [micActive, setMicActive] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const inputElement = inputRef.current;
    if (!inputElement) return;
    inputElement.style.height = 'auto';
    inputElement.style.height = `${Math.min(inputElement.scrollHeight, 160)}px`;
  }, [input]);

  function clearInput() {
    setInput('');
  }

  function toggleMic() {
    setMicActive((value) => {
      const next = !value;
      setVoiceNotice(next
        ? `${micMode === 'dictation' ? 'Dictation' : 'Voice chat'} capture is selected. Browser audio capture is not wired to the hub yet, so text remains the source of truth.`
        : null);
      return next;
    });
  }

  function selectMicMode(mode: MicMode) {
    setMicMode(mode);
    setMicActive(false);
    setVoiceNotice(null);
  }

  function toggleMicMode() {
    selectMicMode(micMode === 'dictation' ? 'voice' : 'dictation');
  }

  function stopVoicePlayback() {
    window.speechSynthesis.cancel();
    setVoiceNotice('Stopped companion voice playback. The text response remains in the thread.');
  }

  function openAttachmentPicker(kind: AttachmentKind) {
    setAttachmentMenuOpen(false);
    if (kind === 'file') fileInputRef.current?.click();
    if (kind === 'image') imageInputRef.current?.click();
    if (kind === 'camera') cameraInputRef.current?.click();
  }

  function handleAttachmentFiles(event: ChangeEvent<HTMLInputElement>, kind: AttachmentKind) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: `${kind}:${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
        kind,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
      })),
    ]);
    event.target.value = '';
  }

  function removeAttachment(id: string) {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return {
    attachmentMenuOpen,
    cameraInputRef,
    clearInput,
    fileInputRef,
    handleAttachmentFiles,
    imageInputRef,
    input,
    inputRef,
    micActive,
    micMode,
    openAttachmentPicker,
    pendingAttachments,
    removeAttachment,
    selectMicMode,
    setAttachmentMenuOpen,
    setInput,
    stopVoicePlayback,
    toggleMic,
    toggleMicMode,
    voiceNotice,
  };
}

export type ComposerController = ReturnType<typeof useComposerController>;
