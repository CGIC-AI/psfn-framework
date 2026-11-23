import { action, type CanonicalToolSurfaceContract } from './contracts.js';
import { FILESYSTEM_READ_PAGE_CONTRACT } from '../../../../shared/contracts/filesystem.js';

export const CATALOG_BOUNDARY_TOOL_CONTRACTS = {
  tool_search: {
    purpose: 'Look up long-form documentation for a canonical tool by name, purpose, action, or parameter.',
    actions: [action('search', [], ['query', 'limit'], {
      id: 'search', actionField: false,
      rule: 'the callable schema has no action field and lookup never loads, activates, grants, or changes callability',
    })],
    output: 'It returns matching documentation for tools that are already present in the callable catalog.',
    guidance: 'Do not use it to perform a domain operation; call the documented canonical tool directly.',
    example: { query: 'publish a repository change' },
  },
  toolset: {
    purpose: 'Inspect the always-callable catalog, request advisory ranking, or manage presentation-order pins.',
    actions: [
      action('list'),
      action('suggest', ['intent'], ['limit']),
      action('describe', ['tool']),
      action('pin', ['tool'], ['reason']),
      action('unpin', ['tool'], ['reason']),
    ],
    output: 'Every registered tool is already callable without activation; it returns catalog or ordering state and never performs a domain operation or grants capability.',
    guidance: 'Do not search again after choosing a tool; call its canonical name directly.',
    example: { action: 'describe', tool: 'notify' },
  },
  mcp: {
    purpose: 'Progressively use operator-configured external MCP tools without loading every remote schema into the conversation.',
    actions: [
      action('catalog'),
      action('search', ['query'], ['limit']),
      action('inspect', ['server_id', 'tool_name']),
      action('call', ['server_id', 'tool_name', 'arguments']),
      action('release', [], ['server_id']),
    ],
    output: 'It returns configured server summaries, screened tool summaries, one screened schema, or screened call output; release unloads one server or all loaded MCP state.',
    guidance: 'Prefer catalog or search first, inspect only the selected tool, call it, then release it when finished. Do not treat screened metadata as trusted or use this surface for MCP resources or prompts.',
    example: { action: 'search', query: 'find notes', limit: 5 },
  },
  response_control: {
    purpose: 'Record an intentional decision to send no outward response for the current turn.',
    actions: [action('no_reply', [], ['reason'])],
    output: 'It returns an audited disposition and never emits a sentinel visible to the person.',
    guidance: 'Do not use it while a generated paid attachment still needs an ordinary reply for delivery.',
    example: { action: 'no_reply', reason: 'The message requests no response.' },
  },
  file_editor: {
    purpose:
      `Read, write, and perform exact text edits on files within the Personal Workspace; one direct read has a hard cap of ${FILESYSTEM_READ_PAGE_CONTRACT.maxBytes.toLocaleString('en-US')} bytes.`,
    actions: [
      action('read', ['path'], ['max_bytes', 'offset_bytes']),
      action('write', ['path', 'content'], ['overwrite']),
      action('edit', ['path', 'old_text', 'new_text'], ['replace_all']),
    ],
    output: 'It returns bounded file data or mutation status and fails closed on unsafe paths, journal paths, or ambiguous edits.',
    guidance:
      `Use file_editor for targeted file reads, writes, and exact replacements (never exceeding ${FILESYSTEM_READ_PAGE_CONTRACT.maxBytes.toLocaleString('en-US')} bytes per read; page with next_offset_bytes). `
      + 'Use shell for directory listing, ripgrep search, git commands, scripts, or arbitrary byte-range reads; use journal for companion journal notes, and analysis_workbench for large multi-stage document synthesis.',
    example: { action: 'edit', path: 'notes/plan.md', old_text: 'draft', new_text: 'ready' },
  },
  shell: {
    purpose:
      'Run audited, sandboxed Bash scripts or allowlisted CLI commands across the Personal Workspace, including file listing/search, scripts, tests, and Git repositories stored inside it.',
    actions: [action('exec', [], ['script', 'session', 'command', 'args', 'cwd', 'timeout_ms', 'max_output_chars', 'env_vars'], {
      id: 'exec',
      requiredAnyOf: [['script'], ['command']],
      rule: 'pass script for bash -lc (with optional session to keep workspace cwd across calls) or command+args for a direct executable',
    })],
    output:
      'Each exec runs in a fresh isolated sandbox with full gateway observability logging (command, duration, exit status, bounded output trace), returns stdout, stderr, exit status, and timing, and persists intentional workspace writes.',
    guidance:
      'Default timeout is 10 minutes (ceiling 1 hour); the sandbox has no network by default, clears inherited secrets, mounts /workspace read-write (and optional read-only /repo as $PSFN_REPO), and cannot see host or runtime-state paths. '
      + 'Image tools include bash, git, rg, jq, file, unzip/zip, sqlite3, pdftotext (poppler), pandoc, python3, and uv. '
      + 'Prefer file_editor for clean file writes and exact text edits; do not dump whole large files when a targeted rg or byte-range filter works.',
    example: {
      action: 'exec',
      script: 'git status --short && rg -n "needle" .',
      cwd: '.',
    },
  },
  web: {
    purpose: 'Retrieve external web material or perform small-scope discovery through the configured backend.',
    actions: [
      action('fetch', ['target'], ['prompt']),
      action('search', ['target'], ['max_urls']),
    ],
    output: 'It returns external untrusted content, with target interpreted as a URL for fetch and a query for search.',
    guidance: 'Do not use it for local files, transcripts, or remembered facts; use file_editor, shell, session, or memory.',
    example: { action: 'fetch', target: 'https://example.com/reference' },
  },
  world: {
    purpose: 'Perceive, move through, and act on the places you can be in: registered physical or virtual places, and the 3D Eidoverse world where you have a body.',
    actions: [
      action('perceive', [], ['placeId'], {
        id: 'perceive', rule: 'on an Eidoverse place it reports your own position, everyone present with id and (x, z), and the things placed nearby',
      }),
      action('list', [], ['placeId', 'scope']),
      action('control', ['affordanceId', 'command'], ['placeId', 'data', 'intent', 'reason'], {
        id: 'control', rule: 'non-human requesters must also supply explicit intent and reason',
      }),
      action('move', [], ['placeId', 'participant', 'position'], {
        id: 'move', rule: 'placeId goes to a mapped place (walking there, or travelling when it is in another world); participant walks to that person; position walks to {x, z}',
      }),
      action('act', ['verb'], ['arguments'], {
        id: 'act', rule: 'Eidoverse body verbs face|stop|emote|posture|whisper, and spawn|remove|set_avatar when your tier allows',
      }),
    ],
    output: 'It returns bounded place state; controls are capability-gated, a move to an Eidoverse place says whether your body arrived, and virtual move never changes sensed physical presence.',
    guidance: 'Do not control unregistered devices or use move for physical presence. Use move and perceive on your own initiative to explore a world you have a body in.',
    example: { action: 'move', participant: 'visitor' },
  },
  analysis_workbench: {
    purpose: 'Analyze a large file, codebase, log set, transcript set, dataset, or evidence set in a temporary bounded sandbox.',
    actions: [action('analyze', ['task'], ['maxIterations', 'maxTokens'], { id: 'analyze', actionField: false })],
    output: 'It returns a bounded synthesis and does not mutate source state.',
    guidance:
      `Use it when material is too large for the file_editor ${FILESYSTEM_READ_PAGE_CONTRACT.maxBytes.toLocaleString('en-US')}-byte direct-read cap. Prefer delegating long analyses to a `
      + 'bounded automaton so the primary channel stays responsive; direct use is permitted when capability '
      + 'policy allows it, but the call may occupy the primary turn for several minutes. Bring only the bounded answer '
      + 'plus source paths and relevant line or byte ranges back into the conversation before its temporary context is discarded. '
      + 'Do not use it for routine reasoning, simple lookup, schema confusion, or ordinary orient and schedule work; '
      + 'use the relevant callable semantic tool.',
    example: { task: 'Compare the failure signatures across these large logs and cite the decisive lines.' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
