/**
 * The Personal Workspace journal is read and written only through the journal
 * tool, which enforces per-note visibility provenance (psfn-framework-75oi4).
 * Generic file surfaces (fs tool, analysis-workbench read_file/write_file/
 * list_files) must not become a way around that gate, so they refuse journal
 * paths and drop journal entries from listings and search results.
 * Relative paths are personal-root-relative (first segment `journal`); an
 * absolute path is refused when any segment is `journal`.
 */
const JOURNAL_DIRNAME = 'journal';

export const JOURNAL_PATH_REFUSAL =
  'journal notes are read and written with the journal tool, which applies visibility gating';

export function isJournalPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/');
  const segments = normalized.split('/').filter(segment => segment.length > 0 && segment !== '.');
  if (normalized.startsWith('/')) return segments.includes(JOURNAL_DIRNAME);
  return segments[0] === JOURNAL_DIRNAME;
}
