import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';
import { loadCharacterCard } from '../../core/identity/loader.js';

/**
 * Names for fleet sibling contacts (psfn-framework-7frk9).
 *
 * Sibling contacts were seeded as "Companion <id prefix>", so a companion
 * searching for its sibling by its display name found nothing. The
 * name comes from the sibling's companions.json `displayName`, falling back
 * to its character card name; a sibling with neither fails closed. The card
 * name, when it differs, becomes the contact's nickname so search matches it
 * too.
 */
export interface SiblingNameSource {
  readonly companionId: string;
  readonly displayName?: string;
  readonly characterCardPath?: string;
}

export interface SiblingContactName {
  readonly displayName: string;
  readonly alias?: string;
}

type CardNameReader = (path: string) => string;

const readCardName: CardNameReader = path => loadCharacterCard(path).data.name;

export function resolveSiblingContactName(
  companion: SiblingNameSource,
  readName: CardNameReader = readCardName,
): SiblingContactName {
  const configured = companion.displayName?.trim();
  const cardPath = companion.characterCardPath?.trim();
  const cardName = cardPath ? readName(cardPath).trim() : undefined;
  const displayName = configured || cardName;
  if (!displayName) {
    throw new Error(
      `Sibling contact for companion ${companion.companionId} has no name: set companions.json displayName `
      + 'or a character card name',
    );
  }
  return cardName && cardName !== displayName ? { displayName, alias: cardName } : { displayName };
}

/** The placeholder name earlier seeding wrote for a sibling contact. */
export function placeholderSiblingContactName(companionId: string): string {
  return `Companion ${companionId.slice(0, 8)}`;
}

/**
 * Give a seeded sibling contact its real name. Idempotent: renames only a
 * contact still carrying the placeholder name, and sets the alias only when no
 * nickname exists, so a name an operator or the companion chose is kept.
 */
export async function applySiblingContactName(
  store: ContactStorePort,
  contact: Contact,
  companionId: string,
  name: SiblingContactName,
  actor: string,
): Promise<void> {
  const displayName = contact.displayName === placeholderSiblingContactName(companionId)
    ? name.displayName
    : contact.displayName;
  const nickname = contact.nickname ?? name.alias;
  if (displayName === contact.displayName && nickname === contact.nickname) return;
  const updated = await store.updateIdentityProfile(contact.id, displayName, nickname, actor);
  if (!updated) throw new Error(`Could not name sibling contact ${contact.id}`);
}
