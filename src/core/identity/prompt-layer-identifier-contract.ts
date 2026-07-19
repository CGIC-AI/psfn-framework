export const PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND =
  'npm run migrate:prompt-layer-identifiers -- --apply';

export function assertBasePromptLayerIdentifier(
  type: string,
  identifier: string | undefined,
): void {
  if (type === 'base' && !identifier) {
    throw new Error(
      'identifier must be a non-empty string for base prompt layers; '
      + `run \`${PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND}\` first for existing stored layers`,
    );
  }
}
