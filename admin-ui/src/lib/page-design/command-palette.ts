export const OPEN_COMMAND_PALETTE_EVENT = 'garden:open-command-palette';

export function requestCommandPalette(target: EventTarget): boolean {
  return target.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
