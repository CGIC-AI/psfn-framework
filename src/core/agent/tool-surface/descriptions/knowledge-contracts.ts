import { action, type CanonicalToolSurfaceContract } from './contracts.js';

export const KNOWLEDGE_TOOL_CONTRACTS = {
  library: {
    purpose: 'Preserve companion-owned research notes, imported workspace files, generated artifacts, and promoted scratchpad entries in a durable library.',
    actions: [
      action('list'),
      action('read', ['id']),
      action('import_text', ['title', 'content'], ['sourceUrl', 'note']),
      action('import_file', ['path'], ['title', 'note']),
      action('promote_scratchpad', ['scratchpadId'], ['title', 'note']),
    ],
    output: 'It returns bounded entry summaries or stored metadata and preview text for reads, plus exact library identifiers and stored paths for imports and promotions.',
    guidance: 'Use web to retrieve external material first; do not use library for lived facts, editable reference documents, or temporary working notes—use memory, wiki, or scratchpad.',
    example: {
      action: 'import_text',
      title: 'Greenhouse lighting study',
      content: 'Seedlings showed stronger growth under the twelve-hour light cycle.',
      sourceUrl: 'https://example.com/greenhouse-lighting-study',
    },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
