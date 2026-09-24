/**
 * Excludes internal cognitive artifacts (context-feedback) exactly like
 * `isInternalMemoryArtifact`: a `source:context_feedback|` source-ref prefix or
 * a `context_feedback` tag (case-insensitive). Expects the `memory` alias.
 */
export const INTERNAL_ARTIFACT_EXCLUSION_SQL = `
  NOT (
    lower(memory.source_ref) LIKE 'source:context_feedback|%'
    OR (
      jsonb_typeof(memory.tags) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(memory.tags) AS tag(value)
        WHERE lower(tag.value) = 'context_feedback'
      )
    )
  )
`;
