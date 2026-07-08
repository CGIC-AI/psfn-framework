export interface RosterPageResult<TMember> {
  members: TMember[];
  total: number;
}

export interface RosterLoaderDeps<TRoom, TMember> {
  fetchRoster: (room: TRoom, offset: number) => Promise<RosterPageResult<TMember>>;
  onStart: (room: TRoom, offset: number) => void;
  onResult: (result: RosterPageResult<TMember>) => void;
  onError: (message: string) => void;
  onSettled: () => void;
}

/**
 * Serializes roster state updates behind a request sequence: only the most
 * recent request may mutate state. Rapid room switches or pagination can
 * otherwise resolve out of order and show one room's members under another
 * room's selection.
 */
export function createRosterLoader<TRoom, TMember>(
  deps: RosterLoaderDeps<TRoom, TMember>,
): (room: TRoom, offset?: number) => Promise<void> {
  let sequence = 0;
  return async function loadRoster(room: TRoom, offset = 0): Promise<void> {
    const requestSeq = ++sequence;
    deps.onStart(room, offset);
    try {
      const data = await deps.fetchRoster(room, offset);
      if (requestSeq !== sequence) return;
      deps.onResult(data);
    } catch (e) {
      if (requestSeq !== sequence) return;
      deps.onError(e instanceof Error ? e.message : 'Failed to load roster');
    } finally {
      if (requestSeq === sequence) {
        deps.onSettled();
      }
    }
  };
}
