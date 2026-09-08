import { useState } from 'react';

export type CompanionDisplayMode = 'none' | 'sprite' | 'model';

interface DisplayChoice {
  readonly mode: CompanionDisplayMode;
  readonly file: File | null;
}

const EMPTY_DISPLAY: DisplayChoice = { mode: 'none', file: null };

/** Local presentation choices belong to exactly one companion and open login. */
export function useCompanionDisplay(companionId: string | null) {
  const [choices, setChoices] = useState<ReadonlyMap<string, DisplayChoice>>(() => new Map());
  const selected = companionId ? choices.get(companionId) ?? EMPTY_DISPLAY : EMPTY_DISPLAY;

  function choose(mode: CompanionDisplayMode) {
    if (!companionId) return;
    setChoices(current => {
      const previous = current.get(companionId) ?? EMPTY_DISPLAY;
      // Choosing the model tab alone never borrows another companion's file.
      return new Map(current).set(companionId, { ...previous, mode });
    });
  }

  function selectFile(file: File) {
    if (!companionId) return;
    setChoices(current => new Map(current).set(companionId, { mode: 'model', file }));
  }

  function removeFile() {
    if (!companionId) return;
    setChoices(current => new Map(current).set(companionId, EMPTY_DISPLAY));
  }

  return {
    ...selected,
    available: companionId !== null,
    choose,
    selectFile,
    removeFile,
    clear: () => setChoices(new Map()),
  };
}

export type CompanionDisplayController = ReturnType<typeof useCompanionDisplay>;
