import type {
  CharacterCardHistoryEntry,
} from '../../../identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import {
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
} from '../../../context-budget.js';
import { escapeHtml } from './shared.js';

const CARD_DIFF_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'first_mes', label: 'First Message' },
  { key: 'mes_example', label: 'Message Example' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History Instructions' },
  { key: 'tags', label: 'Tags' },
  { key: 'creator', label: 'Creator' },
  { key: 'creator_notes', label: 'Creator Notes' },
] as const;

type CardDiffFieldKey = (typeof CARD_DIFF_FIELDS)[number]['key'];

export interface IdentityPageOptions {
  version?: number;
  checksum?: string;
  history?: CharacterCardHistoryEntry[];
  intakeReview?: IdentityIntakeReviewState | null;
}

export interface IdentityCardDiffMeta {
  fromVersion: number;
  toVersion: number;
  updatedBy: string;
  timestamp: string;
  reason?: string;
}

export type IdentityIntakeItemStatus = 'pending' | 'committed' | 'rejected' | 'failed';
export type IdentityIntakeStageStatus = 'pending' | 'partially_committed' | 'committed' | 'rejected';
export type IdentityIntakeSourceKind = 'card' | 'chat' | 'lorebook' | 'memory';

export interface IdentityIntakeSourceSummary {
  kind: IdentityIntakeSourceKind;
  path: string;
  itemCount: number;
  note?: string;
}

export interface IdentityIntakeCardMutationRow {
  field: string;
  previous: string;
  next: string;
  changed: boolean;
}

export interface IdentityIntakeCardMutation {
  sourcePath: string;
  containerFormat: string;
  spec: string;
  warnings: string[];
  status: IdentityIntakeItemStatus;
  rows: IdentityIntakeCardMutationRow[];
}

export interface IdentityIntakeChatChunk {
  id: string;
  index: number;
  startMessage: number;
  endMessage: number;
  messageCount: number;
  estimatedTokens: number;
  status: IdentityIntakeItemStatus;
  error?: string;
}

export interface IdentityIntakeChatProposal {
  channelId: string;
  totalMessages: number;
  chunkTargetTokens: number;
  chunks: IdentityIntakeChatChunk[];
}

export interface IdentityIntakeMemoryItem {
  id: string;
  source: 'lorebook' | 'memory';
  textPreview: string;
  type: string;
  importance: number;
  salience: number;
  criticality?: number;
  mergeDecision: 'create' | 'merge';
  mergeTargetId?: string;
  existingSalience?: number;
  proposedSalience?: number;
  provenanceRefs?: string[];
  relationshipTypeHint?: string;
  relationshipUpdatePlanned?: string;
  relationshipUpdateApplied?: string;
  status: IdentityIntakeItemStatus;
  error?: string;
}

export interface IdentityIntakeReviewState {
  stageId: string;
  createdAt: number;
  updatedAt: number;
  status: IdentityIntakeStageStatus;
  sources: IdentityIntakeSourceSummary[];
  cardMutation?: IdentityIntakeCardMutation;
  chatProposal?: IdentityIntakeChatProposal;
  memoryItems: IdentityIntakeMemoryItem[];
}

export interface IdentityIntakeFlash {
  kind: 'success' | 'error';
  message: string;
}

function cardFieldValue(card: CharacterCardV2, key: CardDiffFieldKey): string {
  if (key === 'tags') return card.data.tags.join(', ');
  const value = card.data[key as keyof CharacterCardV2['data']];
  return typeof value === 'string' ? value : '';
}

export function identityImportResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}

export function identityCardVersionResult(success: boolean, message: string): string {
  return success
    ? `<div class="form-success">${escapeHtml(message)}</div>`
    : `<div class="form-error">${escapeHtml(message)}</div>`;
}

export function identityCardDiffFragment(
  previousCard: CharacterCardV2,
  nextCard: CharacterCardV2,
  meta: IdentityCardDiffMeta,
): string {
  const rows = CARD_DIFF_FIELDS.map(({ key, label }) => {
    const previous = cardFieldValue(previousCard, key);
    const next = cardFieldValue(nextCard, key);
    const changed = previous !== next;
    const cellStyle = changed
      ? 'background:#FFF9E6;border-color:#E8C766'
      : 'background:#FAFAF7;border-color:var(--border)';

    return `
      <tr>
        <td style="vertical-align:top;font-weight:600">${escapeHtml(label)}</td>
        <td style="vertical-align:top;border:1px solid var(--border);${cellStyle};padding:0.5rem">
          <div style="white-space:pre-wrap;font-family:monospace;font-size:0.85rem">${escapeHtml(previous)}</div>
        </td>
        <td style="vertical-align:top;border:1px solid var(--border);${cellStyle};padding:0.5rem">
          <div style="white-space:pre-wrap;font-family:monospace;font-size:0.85rem">${escapeHtml(next)}</div>
        </td>
      </tr>
    `;
  }).join('');

  const reasonSuffix = meta.reason ? ` &middot; ${escapeHtml(meta.reason)}` : '';

  return `
    <div class="card" style="margin-top:1rem">
      <h3 style="margin-bottom:0.5rem">Character Card Diff (v${meta.fromVersion} &rarr; v${meta.toVersion})</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        Updated ${new Date(meta.timestamp).toLocaleString()} by ${escapeHtml(meta.updatedBy)}${reasonSuffix}
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Previous</th>
            <th>Next</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function intakeStatusLabel(status: IdentityIntakeItemStatus): string {
  if (status === 'committed') return 'Committed';
  if (status === 'rejected') return 'Rejected';
  if (status === 'failed') return 'Failed';
  return 'Pending';
}

function intakeStatusChip(status: IdentityIntakeItemStatus): string {
  if (status === 'committed') {
    return '<span style="color:#1E4D2D;background:#E8F3EC;border:1px solid #9CC9A9;border-radius:999px;padding:0.1rem 0.45rem;font-size:0.72rem">Committed</span>';
  }
  if (status === 'rejected') {
    return '<span style="color:#7A1E1E;background:#FFF0F0;border:1px solid #E0A1A1;border-radius:999px;padding:0.1rem 0.45rem;font-size:0.72rem">Rejected</span>';
  }
  if (status === 'failed') {
    return '<span style="color:#8A2F2F;background:#FDEFF2;border:1px solid #E3B6BF;border-radius:999px;padding:0.1rem 0.45rem;font-size:0.72rem">Failed</span>';
  }
  return '<span style="color:#5D4A33;background:#F4F1EA;border:1px solid #C7BBA7;border-radius:999px;padding:0.1rem 0.45rem;font-size:0.72rem">Pending</span>';
}

function intakeStageStatusLabel(status: IdentityIntakeStageStatus): string {
  if (status === 'committed') return 'Committed';
  if (status === 'partially_committed') return 'Partially committed';
  if (status === 'rejected') return 'Rejected';
  return 'Pending review';
}

function escapeFloat(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function sourceKindLabel(kind: IdentityIntakeSourceKind): string {
  if (kind === 'card') return 'Card';
  if (kind === 'chat') return 'Chat';
  if (kind === 'lorebook') return 'Lorebook';
  return 'Memory';
}

export function identityIntakeReviewFragment(
  state: IdentityIntakeReviewState | null,
  flash?: IdentityIntakeFlash,
): string {
  const flashHtml = flash
    ? `<div class="${flash.kind === 'success' ? 'form-success' : 'form-error'}" style="margin-bottom:0.7rem">${escapeHtml(flash.message)}</div>`
    : '';

  if (!state) {
    return `${flashHtml}<div class="crm-notes">No staged intake bundle yet. Upload one or more sources to begin review.</div>`;
  }

  const sourceRows = state.sources.map(source => `
    <tr>
      <td>${escapeHtml(sourceKindLabel(source.kind))}</td>
      <td><code>${escapeHtml(source.path)}</code></td>
      <td>${formatInteger(source.itemCount)}</td>
      <td>${source.note ? escapeHtml(source.note) : '<span class="crm-notes">-</span>'}</td>
    </tr>
  `).join('');

  const changedCardRows = state.cardMutation
    ? state.cardMutation.rows.filter(row => row.changed)
    : [];
  const cardRows = changedCardRows.map(row => `
    <tr>
      <td>${escapeHtml(row.field)}</td>
      <td style="font-family:monospace;white-space:pre-wrap">${escapeHtml(row.previous)}</td>
      <td style="font-family:monospace;white-space:pre-wrap">${escapeHtml(row.next)}</td>
    </tr>
  `).join('');

  const chatChunks = state.chatProposal?.chunks ?? [];
  const pendingChatChunks = chatChunks.filter(chunk => chunk.status === 'pending');
  const committedChatChunks = chatChunks.filter(chunk => chunk.status === 'committed');
  const chatRows = chatChunks.map(chunk => `
    <tr>
      <td>${chunk.status === 'pending'
        ? `<input type="checkbox" name="chatChunkId" value="${escapeHtml(chunk.id)}" checked>`
        : ''}</td>
      <td>Chunk ${chunk.index}</td>
      <td>${chunk.startMessage}-${chunk.endMessage}</td>
      <td>${formatInteger(chunk.messageCount)}</td>
      <td>${formatInteger(chunk.estimatedTokens)}</td>
      <td>${intakeStatusChip(chunk.status)}</td>
      <td>${chunk.error ? escapeHtml(chunk.error) : ''}</td>
    </tr>
  `).join('');

  const pendingMemoryItems = state.memoryItems.filter(item => item.status === 'pending');
  const committedMemoryItems = state.memoryItems.filter(item => item.status === 'committed');
  const memoryRows = state.memoryItems.map(item => {
    const mergeSummary = item.mergeDecision === 'merge'
      ? `Merge into ${escapeHtml(item.mergeTargetId ?? 'existing')} (${escapeFloat(item.existingSalience ?? 0)} -> ${escapeFloat(item.proposedSalience ?? item.salience)})`
      : 'Create new memory';
    const salienceSummary = item.mergeDecision === 'merge'
      ? `Merged salience ${escapeFloat(item.proposedSalience ?? item.salience)}`
      : `Initialized salience ${escapeFloat(item.salience)} (criticality ${escapeFloat(item.criticality ?? 0)})`;
    const provenanceSummary = `${item.provenanceRefs?.length ?? 0} provenance refs`;
    const relationshipSummary = item.relationshipUpdateApplied
      ? `Relationship applied: ${escapeHtml(item.relationshipUpdateApplied)}`
      : item.relationshipUpdatePlanned
        ? `Relationship planned: ${escapeHtml(item.relationshipUpdatePlanned)}`
        : item.relationshipTypeHint
          ? `Relationship signal: ${escapeHtml(item.relationshipTypeHint)}`
          : 'No relationship update';
    const mergeDetails = [mergeSummary, salienceSummary, provenanceSummary, relationshipSummary].join(' • ');

    return `
      <tr>
        <td>${item.status === 'pending'
          ? `<input type="checkbox" name="memoryItemId" value="${escapeHtml(item.id)}" checked>`
          : ''}</td>
        <td>${escapeHtml(item.source)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td style="white-space:pre-wrap">${escapeHtml(item.textPreview)}</td>
        <td>${escapeFloat(item.importance)}</td>
        <td>${escapeFloat(item.salience)}</td>
        <td>${escapeHtml(mergeDetails)}</td>
        <td>${intakeStatusChip(item.status)}</td>
      </tr>
      ${item.error ? `
        <tr>
          <td></td>
          <td colspan="7" class="form-error" style="font-size:0.78rem">${escapeHtml(item.error)}</td>
        </tr>
      ` : ''}
    `;
  }).join('');

  const pendingCard = state.cardMutation?.status === 'pending';
  const hasPending = pendingCard || pendingChatChunks.length > 0 || pendingMemoryItems.length > 0;

  return `
    ${flashHtml}
    <div class="card" style="margin-top:0.65rem">
      <h4 style="margin-bottom:0.5rem">Staged Intake Bundle</h4>
      <div class="crm-notes" style="margin-bottom:0.55rem">
        Stage ID <code>${escapeHtml(state.stageId)}</code> &middot;
        Created ${new Date(state.createdAt).toLocaleString()} &middot;
        Updated ${new Date(state.updatedAt).toLocaleString()} &middot;
        Status: <strong>${escapeHtml(intakeStageStatusLabel(state.status))}</strong>
      </div>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Path</th>
            <th>Items</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${sourceRows}</tbody>
      </table>
    </div>

    ${state.cardMutation ? `
      <div class="card">
        <h4 style="margin-bottom:0.5rem">Proposed Identity Mutations</h4>
        <div class="crm-notes" style="margin-bottom:0.55rem">
          Source <code>${escapeHtml(state.cardMutation.sourcePath)}</code> (${escapeHtml(state.cardMutation.containerFormat)} / ${escapeHtml(state.cardMutation.spec)})
          &middot; ${intakeStatusLabel(state.cardMutation.status)}
        </div>
        ${state.cardMutation.warnings.length > 0 ? `
          <div class="form-error" style="margin-bottom:0.65rem;font-size:0.8rem">
            ${escapeHtml(state.cardMutation.warnings.join('; '))}
          </div>
        ` : ''}
        ${cardRows
          ? `
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Current</th>
                  <th>Proposed</th>
                </tr>
              </thead>
              <tbody>${cardRows}</tbody>
            </table>
          `
          : '<div class="crm-notes">No changed card fields detected.</div>'}
      </div>
    ` : ''}

    ${state.chatProposal ? `
      <div class="card">
        <h4 style="margin-bottom:0.5rem">Proposed L0 Chat Mutations</h4>
        <div class="crm-notes" style="margin-bottom:0.55rem">
          Channel <code>${escapeHtml(state.chatProposal.channelId)}</code> &middot;
          ${formatInteger(state.chatProposal.totalMessages)} messages &middot;
          chunk target ${formatInteger(state.chatProposal.chunkTargetTokens)} tokens &middot;
          committed ${formatInteger(committedChatChunks.length)} / ${formatInteger(chatChunks.length)} chunks
        </div>
        ${chatChunks.length > 0 ? `
          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th>Chunk</th>
                <th>Message Range</th>
                <th>Messages</th>
                <th>Est. Tokens</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>${chatRows}</tbody>
          </table>
        ` : '<div class="crm-notes">No staged chat messages.</div>'}
      </div>
    ` : ''}

    ${state.memoryItems.length > 0 ? `
      <div class="card">
        <h4 style="margin-bottom:0.5rem">Proposed L2 Memory Mutations</h4>
        <div class="crm-notes" style="margin-bottom:0.55rem">
          ${formatInteger(committedMemoryItems.length)} / ${formatInteger(state.memoryItems.length)} items committed.
          Merge and salience decisions are shown per item.
        </div>
        <table>
          <thead>
            <tr>
              <th>Select</th>
              <th>Source</th>
              <th>Type</th>
              <th>Text</th>
              <th>Importance</th>
              <th>Salience</th>
              <th>Merge Decision</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${memoryRows}</tbody>
        </table>
      </div>
    ` : ''}

    <div class="card">
      <h4 style="margin-bottom:0.5rem">Review Decisions</h4>
      ${hasPending ? `
        <form hx-post="/api/identity/intake/commit" hx-target="#identity-intake-review" hx-swap="innerHTML">
          <input type="hidden" name="stageId" value="${escapeHtml(state.stageId)}">
          <div class="form-group">
            <label for="identity-intake-reason">Operator Note</label>
            <input id="identity-intake-reason" name="reason" type="text" placeholder="Optional audit note">
          </div>
          ${pendingCard ? `
            <div class="form-group" style="display:flex;align-items:center;gap:0.5rem">
              <input id="identity-intake-apply-card" type="checkbox" name="applyCard" value="true" checked>
              <label for="identity-intake-apply-card" style="margin:0;text-transform:none;letter-spacing:0;font-size:0.85rem;color:var(--text)">Include staged character card update</label>
            </div>
          ` : ''}
          <div class="form-actions">
            <button type="submit" class="btn" name="decision" value="partial">Commit Selected</button>
            <button type="submit" class="btn" name="decision" value="approve">Approve All Pending</button>
            <button type="submit" class="btn btn-danger" name="decision" value="reject">Reject Pending</button>
          </div>
        </form>
      ` : `
        <div class="crm-notes">No pending staged changes remain for this bundle.</div>
      `}
    </div>
  `;
}

export function identityPage(card: CharacterCardV2, config: SubstrateConfig, options: IdentityPageOptions = {}): string {
  const d = card.data;
  const sessionBudgetPct = resolveSessionHistoryBudgetPct(config);
  const retrievalBudgetPct = resolveMemoryRetrievalBudgetPct(config);
  const history = options.history ?? [];
  const historyRows = [...history].reverse().slice(0, 20).map(entry => `
    <tr>
      <td>v${entry.version} &rarr; v${entry.version + 1}</td>
      <td>${escapeHtml(entry.updatedBy)}</td>
      <td>${new Date(entry.timestamp).toLocaleString()}</td>
      <td><code>${escapeHtml(entry.previousChecksum)}</code></td>
      <td>
        <form hx-post="/api/identity/card/diff" hx-target="#identity-card-diff" hx-swap="innerHTML" style="display:inline">
          <input type="hidden" name="version" value="${entry.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Diff</button>
        </form>
        <form hx-post="/api/identity/card/rollback" hx-target="#identity-card-result" hx-swap="innerHTML" style="display:inline;margin-left:0.35rem">
          <input type="hidden" name="version" value="${entry.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
        </form>
      </td>
    </tr>
  `).join('');

  const configRows = Object.entries({
    'Primary Model': config.primaryModel,
    'Extraction Model': config.extractionModel,
    'Discord Bot ID': config.discordBotId,
    'Data Dir': config.dataDir,
    'Character Card Path': config.characterCardPath,
    'Session History Budget %': String(sessionBudgetPct),
    'Session Message Hard Override': config.sessionMessageLimit ? String(config.sessionMessageLimit) : 'auto',
    'Memory Retrieval Budget %': String(retrievalBudgetPct),
    'Memory Retrieval Hard Override': config.memoryRetrievalLimit ? String(config.memoryRetrievalLimit) : 'auto',
  })
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  const version = options.version ?? 1;
  const checksum = options.checksum;

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">${escapeHtml(d.name)}</h3>
      <table class="config-table">
        <tr><td>Creator</td><td>${escapeHtml(d.creator)}</td></tr>
        <tr><td>Tags</td><td>${d.tags.map(t => escapeHtml(t)).join(', ')}</td></tr>
      </table>
      <p style="margin-top:1rem;white-space:pre-wrap">${escapeHtml(d.personality.slice(0, 500))}${d.personality.length > 500 ? '...' : ''}</p>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Character Card Versioning</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        Current version: <strong>v${version}</strong>
        ${checksum ? ` &middot; Checksum: <code>${escapeHtml(checksum)}</code>` : ''}
      </p>
      <h4 style="margin:0 0 0.6rem 0">Card Version History</h4>
      <div id="identity-card-result"></div>
      ${history.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Changed By</th>
              <th>Timestamp</th>
              <th>Previous Checksum</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${historyRows}</tbody>
        </table>
      ` : '<p class="empty">No card history yet.</p>'}
      <div id="identity-card-diff"></div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Runtime Configuration</h3>
      <table class="config-table">${configRows}</table>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Import Character Card</h3>
      <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
        Import from JSON, PNG, or CharX using a local filesystem path.
      </p>
      <form hx-post="/api/identity/import" hx-target="#identity-import-result" hx-swap="innerHTML">
        <div class="form-group">
          <label for="identity-import-path">Source Path</label>
          <input id="identity-import-path" name="path" type="text" placeholder="/path/to/character-card.png" required>
        </div>
        <div class="form-group">
          <label for="identity-import-target">Import Destination</label>
          <input
            id="identity-import-target"
            type="text"
            value="${escapeHtml(config.characterCardPath)}"
            readonly
            aria-readonly="true"
          >
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Import Character</button>
          <span id="identity-import-result"></span>
        </div>
      </form>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Staged Intake (Card + L0 + L2)</h3>
      <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
        Stage card, chat, lorebook, and memory sources. Review proposed identity/L0/L2 writes before approval.
      </p>
      <form hx-post="/api/identity/intake/stage" hx-target="#identity-intake-review" hx-swap="innerHTML">
        <div class="form-row">
          <div class="form-group">
            <label for="identity-stage-card-path">Card Source Path</label>
            <input id="identity-stage-card-path" name="cardPath" type="text" placeholder="/path/to/character-card.png">
          </div>
          <div class="form-group">
            <label for="identity-stage-chat-path">Chat Source Path</label>
            <input id="identity-stage-chat-path" name="chatPath" type="text" placeholder="/path/to/chat-export.json">
          </div>
          <div class="form-group">
            <label for="identity-stage-lorebook-path">Lorebook Source Path</label>
            <input id="identity-stage-lorebook-path" name="lorebookPath" type="text" placeholder="/path/to/lorebook.json">
          </div>
          <div class="form-group">
            <label for="identity-stage-memory-path">Memory Source Path</label>
            <input id="identity-stage-memory-path" name="memoryPath" type="text" placeholder="/path/to/memory-export.json">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="identity-stage-chat-channel">L0 Target Channel</label>
            <input id="identity-stage-chat-channel" name="chatChannelId" type="text" value="import:staged">
          </div>
          <div class="form-group">
            <label for="identity-stage-chat-chunk">Chat Chunk Target Tokens</label>
            <input id="identity-stage-chat-chunk" name="chatChunkTargetTokens" type="number" min="1000" max="200000" value="50000">
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Stage Sources</button>
        </div>
      </form>
      <div id="identity-intake-review" style="margin-top:0.9rem">
        ${identityIntakeReviewFragment(options.intakeReview ?? null)}
      </div>
    </div>`;
}
