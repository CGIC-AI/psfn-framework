import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

export function useComposerController(draftOwner = 'current-thread') {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const input = drafts.get(draftOwner) ?? '';
  function setInput(value: SetStateAction<string>) {
    setDrafts(current => new Map(current).set(draftOwner,
      typeof value === 'function' ? value(current.get(draftOwner) ?? '') : value));
  }
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const inputElement = inputRef.current;
    if (!inputElement) return;
    inputElement.style.height = 'auto';
    inputElement.style.height = `${Math.min(inputElement.scrollHeight, 160)}px`;
  }, [input]);

  function clearInput() {
    setInput('');
  }

  function clearHumanScopedState() {
    setDrafts(new Map());
    resetInteraction();
  }

  function resetInteraction() {
    setAttachmentMenuOpen(false);
    setMicActive(false);
    setVoiceNotice(null);
  }

  const syncMicCapture = useCallback((active: boolean, notice: string | null) => {
    setMicActive(active);
    setVoiceNotice(notice);
  }, []);

  return {
    attachmentMenuOpen,
    clearHumanScopedState,
    clearInput,
    input,
    inputRef,
    micActive,
    resetInteraction,
    setAttachmentMenuOpen,
    setInput,
    syncMicCapture,
    voiceNotice,
  };
}

export type ComposerController = ReturnType<typeof useComposerController>;
