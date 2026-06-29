import type {
  AuthenticityDetailLossRisk,
  AuthenticityEmotionalTexture,
  AuthenticityProvenance,
  AuthenticityProvenanceKind,
  AuthenticitySourceAuthor,
  AuthenticityTransformer,
  AuthenticityWording,
} from './contracts/runtime.js';

export const DERIVED_DETAIL_LOSS_NOTE = 'Derived context; exact details may be lost.';
export const DERIVED_EMOTIONAL_TEXTURE_NOTE = 'Emotional texture may be flattened by summarization or retrieval.';

export interface BuildAuthenticityProvenanceInput {
  kind: AuthenticityProvenanceKind;
  sourceAuthor: AuthenticitySourceAuthor;
  transformedBy: AuthenticityTransformer;
  wording: AuthenticityWording;
  directSpeech: boolean;
  detailLoss: AuthenticityDetailLossRisk;
  emotionalTexture: AuthenticityEmotionalTexture;
  safeAsPartnerSpeech: boolean;
  sourceSpanCount?: number;
  sourceEntryIds?: readonly number[];
  notes?: readonly string[];
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeEntryIds(value: readonly number[] | undefined): number[] | undefined {
  if (!value || value.length === 0) return undefined;
  const ids = value
    .map(id => normalizePositiveInteger(id))
    .filter((id): id is number => id !== undefined);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function normalizeNotes(value: readonly string[] | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  const notes = value
    .map(note => note.trim())
    .filter(note => note.length > 0);
  return notes.length > 0 ? [...new Set(notes)] : undefined;
}

export function buildAuthenticityProvenance(
  input: BuildAuthenticityProvenanceInput,
): AuthenticityProvenance {
  const sourceEntryIds = normalizeEntryIds(input.sourceEntryIds);
  const sourceSpanCount = normalizePositiveInteger(input.sourceSpanCount)
    ?? (sourceEntryIds ? sourceEntryIds.length : undefined);
  const notes = normalizeNotes(input.notes);
  return {
    schemaVersion: 1,
    kind: input.kind,
    sourceAuthor: input.sourceAuthor,
    transformedBy: input.transformedBy,
    wording: input.wording,
    directSpeech: input.directSpeech,
    detailLoss: input.detailLoss,
    emotionalTexture: input.emotionalTexture,
    safeAsPartnerSpeech: input.safeAsPartnerSpeech,
    ...(sourceSpanCount !== undefined ? { sourceSpanCount } : {}),
    ...(sourceEntryIds ? { sourceEntryIds } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function cloneAuthenticityProvenance(
  provenance: AuthenticityProvenance | undefined,
): AuthenticityProvenance | undefined {
  if (!provenance) return undefined;
  return {
    ...provenance,
    ...(provenance.sourceEntryIds ? { sourceEntryIds: [...provenance.sourceEntryIds] } : {}),
    ...(provenance.notes ? { notes: [...provenance.notes] } : {}),
  };
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function formatAuthenticityProvenanceMarker(
  provenance: AuthenticityProvenance,
): string {
  const attributes: Array<[string, string]> = [
    ['kind', provenance.kind],
    ['source_author', provenance.sourceAuthor],
    ['transformed_by', provenance.transformedBy],
    ['wording', provenance.wording],
    ['direct_speech', String(provenance.directSpeech)],
    ['detail_loss', provenance.detailLoss],
    ['emotional_texture', provenance.emotionalTexture],
    ['safe_as_partner_speech', String(provenance.safeAsPartnerSpeech)],
  ];
  if (provenance.sourceSpanCount !== undefined) {
    attributes.push(['source_span_count', String(provenance.sourceSpanCount)]);
  }
  const attributeText = attributes
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
    .join(' ');
  if (!provenance.notes || provenance.notes.length === 0) {
    return `<authenticity_provenance ${attributeText} />`;
  }
  const notes = provenance.notes.map(note => `  <note>${escapeXmlText(note)}</note>`);
  return [
    `<authenticity_provenance ${attributeText}>`,
    ...notes,
    '</authenticity_provenance>',
  ].join('\n');
}

export function prependAuthenticityProvenanceMarker(
  content: string,
  provenance: AuthenticityProvenance,
): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `${formatAuthenticityProvenanceMarker(provenance)}\n${trimmed}`;
}
