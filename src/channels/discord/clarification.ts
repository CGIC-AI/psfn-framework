import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type {
  ClarifyDeliverResult,
  PendingClarification,
} from '../../boundary/gateway/protocol.js';

/**
 * Discord button rendering + interaction collection for a structured
 * clarification (vvf.5.2). Greenfield: no prior ButtonBuilder/ActionRowBuilder
 * usage existed in the Discord adapter.
 *
 * The button label is display-only and may be truncated (Discord caps labels at
 * 80 chars); the authoritative choice is always resolved by INDEX from the
 * runtime-owned {@link PendingClarification}, never from the clicked label, so a
 * resolved selection can be verified byte-for-byte against the delivered
 * choices. Custom ids carry the clarification id so a stray button from another
 * clarification can never resolve this one.
 */

const CLARIFY_CUSTOM_ID_PREFIX = 'clarify';
const CLARIFY_CUSTOM_ID_SEPARATOR = ':';
/** Discord hard limit on a button label. */
const DISCORD_BUTTON_LABEL_LIMIT = 80;

export function buildClarificationCustomId(clarificationId: string, index: number): string {
  return [CLARIFY_CUSTOM_ID_PREFIX, clarificationId, String(index)].join(CLARIFY_CUSTOM_ID_SEPARATOR);
}

/** Prefix that scopes an interaction collector to exactly one clarification. */
export function clarificationCustomIdPrefix(clarificationId: string): string {
  return `${CLARIFY_CUSTOM_ID_PREFIX}${CLARIFY_CUSTOM_ID_SEPARATOR}${clarificationId}${CLARIFY_CUSTOM_ID_SEPARATOR}`;
}

/**
 * Parse a clicked button's custom id back into a choice index for the given
 * clarification. Returns `null` (fail closed) when the id does not belong to
 * this clarification or does not name an in-range choice — the caller never
 * fabricates a selection from an unparseable id.
 */
export function parseClarificationCustomId(
  customId: string,
  clarification: PendingClarification,
): number | null {
  const wirePrefix = `${CLARIFY_CUSTOM_ID_PREFIX}${CLARIFY_CUSTOM_ID_SEPARATOR}`;
  if (!customId.startsWith(wirePrefix)) return null;
  const payload = customId.slice(wirePrefix.length);
  const indexSeparator = payload.lastIndexOf(CLARIFY_CUSTOM_ID_SEPARATOR);
  if (indexSeparator <= 0) return null;
  const clarificationId = payload.slice(0, indexSeparator);
  const rawIndex = payload.slice(indexSeparator + 1);
  if (clarificationId !== clarification.id) return null;
  if (!/^\d+$/.test(rawIndex)) return null;
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0 || index >= clarification.choices.length) return null;
  return index;
}

function truncateLabel(choice: string): string {
  if (choice.length <= DISCORD_BUTTON_LABEL_LIMIT) return choice;
  return `${choice.slice(0, DISCORD_BUTTON_LABEL_LIMIT - 1)}…`;
}

/**
 * Build the action rows of choice buttons. Clarify is bounded to 2..5 choices
 * upstream, so a single row (Discord allows 5 buttons per row) always suffices.
 */
export function buildClarificationComponents(
  clarification: PendingClarification,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  clarification.choices.forEach((choice, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildClarificationCustomId(clarification.id, index))
        .setLabel(truncateLabel(choice))
        .setStyle(ButtonStyle.Secondary),
    );
  });
  return [row];
}

/** The message body that accompanies the buttons. */
export function formatClarificationMessage(clarification: PendingClarification): string {
  return clarification.question;
}

/**
 * A single collected button press, abstracted from discord.js so the delivery
 * orchestration is unit-testable without a live gateway connection.
 */
export interface DiscordClarifyInteraction {
  readonly customId: string;
  /** Acknowledge the click and disable the buttons. Must not reject the flow. */
  acknowledge(): Promise<void>;
}

/**
 * The rendered clarification message, awaiting a button press. Implemented over
 * a real discord.js message in the adapter; faked in tests.
 */
export interface DiscordClarifyMessageHandle {
  /**
   * Resolve with the button press, or `null` when the wait window elapses with
   * no answer. Must not reject on timeout — timeout is a structured no-answer.
   */
  awaitInteraction(timeoutMs: number): Promise<DiscordClarifyInteraction | null>;
  /** Best-effort disable of the buttons after the window closes with no answer. */
  disable(): Promise<void>;
}

export interface DiscordClarifyChannel {
  present(clarification: PendingClarification): Promise<DiscordClarifyMessageHandle>;
}

/**
 * Render a clarification's choices as Discord buttons, collect the click, and
 * map it to a verified {@link ClarifyDeliverResult}. Fails closed: timeout or an
 * unrecognized button yields a `pending` no-answer with no selection.
 */
export async function deliverDiscordClarification(
  channel: DiscordClarifyChannel,
  clarification: PendingClarification,
  target: string,
  timeoutMs: number,
): Promise<ClarifyDeliverResult> {
  const noAnswer: ClarifyDeliverResult = { status: 'pending', channel: 'discord', target };
  const handle = await channel.present(clarification);
  const interaction = await handle.awaitInteraction(timeoutMs);
  if (!interaction) {
    await handle.disable();
    return noAnswer;
  }

  const index = parseClarificationCustomId(interaction.customId, clarification);
  await interaction.acknowledge();
  if (index === null) {
    return noAnswer;
  }

  return {
    status: 'resolved',
    channel: 'discord',
    target,
    selection: {
      clarificationId: clarification.id,
      selectedIndex: index,
      selectedChoice: clarification.choices[index]!,
    },
  };
}
