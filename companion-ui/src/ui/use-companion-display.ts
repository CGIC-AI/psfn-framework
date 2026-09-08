import { useEffect, useRef, useState } from 'react';
import type { LocalSpritePack } from '../lib/sprites/import-sprite-pack.js';

export type CompanionDisplayMode = 'none' | 'sprite' | 'model';

interface DisplayChoice {
  readonly mode: CompanionDisplayMode;
  readonly file: File | null;
  readonly spritePack: LocalSpritePack | null;
}

const EMPTY_DISPLAY: DisplayChoice = { mode: 'none', file: null, spritePack: null };

/** Local presentation choices belong to exactly one companion and open login. */
export function useCompanionDisplay(companionId: string | null) {
  const [choices, setChoices] = useState<ReadonlyMap<string, DisplayChoice>>(() => new Map());
  const owned = useRef(choices);
  const selected = companionId ? choices.get(companionId) ?? EMPTY_DISPLAY : EMPTY_DISPLAY;

  useEffect(() => () => {
    for (const choice of owned.current.values()) choice.spritePack?.dispose();
    owned.current = new Map();
  }, []);

  function update(patch: Partial<DisplayChoice>) {
    if (!companionId) return;
    const previous = owned.current.get(companionId) ?? EMPTY_DISPLAY;
    const next = { ...previous, ...patch };
    owned.current = new Map(owned.current).set(companionId, next);
    setChoices(owned.current);
    if (previous.spritePack !== next.spritePack) previous.spritePack?.dispose();
  }

  function choose(mode: CompanionDisplayMode) {
    update({ mode });
  }

  function selectFile(file: File) {
    update({ mode: 'model', file });
  }

  function removeFile() {
    update({ mode: 'none', file: null });
  }

  function selectSpritePack(spritePack: LocalSpritePack) {
    if (!companionId) { spritePack.dispose(); return; }
    update({ mode: 'sprite', spritePack });
  }

  function clear() {
    for (const choice of owned.current.values()) choice.spritePack?.dispose();
    owned.current = new Map();
    setChoices(owned.current);
  }

  return {
    ...selected,
    available: companionId !== null,
    choose,
    selectFile,
    removeFile,
    selectSpritePack,
    removeSpritePack: () => update({ spritePack: null }),
    clear,
  };
}

export type CompanionDisplayController = ReturnType<typeof useCompanionDisplay>;
