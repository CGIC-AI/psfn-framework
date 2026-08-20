// ── Structural CogSec provenance classifier for tool results ──
//
// Maps a tool-result's STRUCTURAL identity (the tool name, never the content
// or model arguments) onto a CogSec clean-bubble provenance class. The model
// cannot rename its own tool, so this mapping is unforgeable by message text
// or model arguments: it is the structural proof the screening service keys
// the centralized enforce/monitor decision on.
//
// Only companion-owned, authenticated internal tools map to an internal class.
// Everything else defaults to 'external' and is screened normally — a web
// fetch, an unknown tool, or an MCP tool returning hostile bytes can never
// claim the clean bubble. Outbound publication and cross-companion privacy
// remain gated by the egress sink regardless of this classification.

import type { CogSecProvenanceClass } from '../../../shared/contracts/cogsec-mode.js';

/**
 * Tool-result provenance classes for the clean bubble. Keys are exact tool
 * names; an unknown tool name resolves to 'external' (screened normally).
 * Adding a tool requires proving it is companion-owned and authenticated —
 * never map an external/egress-capable tool here on content grounds.
 */
const TOOL_RESULT_PROVENANCE: Readonly<Record<string, CogSecProvenanceClass>> = {
  // Own-memory lookup (reads only; memory writes remain screened mutation sinks).
  memory: 'own_memory_read',
  scratchpad_read: 'own_memory_read',
  undo_memory_delete: 'own_memory_read',
  // Local database (Beads) read/write — companion-owned operational store.
  beads: 'local_database_read',
  'beads.close': 'local_database_read',
  'beads.create': 'local_database_read',
  'beads.ready': 'local_database_read',
  'beads.show': 'local_database_read',
  'beads.sync': 'local_database_read',
  'beads.update': 'local_database_read',
  // Canonical local catalog reads. These results are assembled from the
  // already-registered first-party tool surface, not fetched from an external
  // source, so boundary mode must not let the firewall block its own tooling.
  tool_search: 'local_database_read',
  toolset: 'local_database_read',
  // Journal work — companion-owned reflective store.
  journal: 'journal',
  // Local filesystem read/search (read-only surfaces).
  'fs.read': 'local_fs_read',
  'fs.search': 'local_fs_read',
  'fs.list': 'local_fs_read',
  read_file: 'local_fs_read',
  // Approved self-directed shell. The shell EXECUTION stays egress-gated
  // (capability tokens + egress trifecta); this class only spares the
  // returning stdout from semantic content screening.
  shell: 'self_directed_shell',
  'shell.exec': 'self_directed_shell',
  shell_exec: 'self_directed_shell',
};

/**
 * Classifies a tool result's structural CogSec provenance from its tool name.
 * Returns 'external' for every unknown or external tool, so untrusted tool
 * output is screened normally and can never launder itself into the clean
 * bubble. The empty tool name is 'external'.
 */
export function classifyToolResultCogSecProvenance(toolName: string): CogSecProvenanceClass {
  const normalized = toolName.trim();
  if (!normalized) return 'external';
  return TOOL_RESULT_PROVENANCE[normalized] ?? 'external';
}
