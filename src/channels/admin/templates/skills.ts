import type { SkillEntry, SkillSkipRecord, SkillSnapshot } from '../../../skills/types.js';
import { escapeHtml } from './shared.js';

function renderRequires(entry: SkillEntry): string {
  const requirementParts: string[] = [];

  if (entry.requires.binaries.length > 0) {
    requirementParts.push(`bin:${entry.requires.binaries.join(',')}`);
  }
  if (entry.requires.env.length > 0) {
    requirementParts.push(`env:${entry.requires.env.join(',')}`);
  }
  if (entry.requires.config.length > 0) {
    requirementParts.push(`cfg:${entry.requires.config.join(',')}`);
  }

  if (requirementParts.length === 0) return '<span class="empty">none</span>';
  return `<code>${escapeHtml(requirementParts.join(' | '))}</code>`;
}

function renderIncludedRows(entries: SkillEntry[]): string {
  if (entries.length === 0) {
    return '<tr><td colspan="7" class="empty">No skills injected into runtime context.</td></tr>';
  }

  return entries
    .map(entry => `
      <tr>
        <td><strong>${escapeHtml(entry.name)}</strong></td>
        <td>${escapeHtml(entry.description)}</td>
        <td><code>${escapeHtml(entry.relativePath)}</code></td>
        <td>${escapeHtml(entry.source)}</td>
        <td>${entry.always ? 'yes' : 'no'}</td>
        <td>${renderRequires(entry)}</td>
        <td>${escapeHtml(String(entry.content.length))}</td>
      </tr>
    `)
    .join('');
}

function renderSkippedRows(skipped: SkillSkipRecord[]): string {
  if (skipped.length === 0) {
    return '<tr><td colspan="6" class="empty">No filtered skills.</td></tr>';
  }

  return skipped
    .map(item => `
      <tr>
        <td>${escapeHtml(item.kind)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td><code>${escapeHtml(item.relativePath)}</code></td>
        <td>${escapeHtml(item.source)}</td>
        <td>${escapeHtml(item.reason)}</td>
        <td>${escapeHtml((item.details ?? []).join('; '))}</td>
      </tr>
    `)
    .join('');
}

export function skillsPage(snapshot: SkillSnapshot): string {
  const directories = snapshot.directories
    .map(directory => `<li><code>${escapeHtml(directory.relativePath)}</code> (${escapeHtml(directory.source)})</li>`)
    .join('');

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Runtime Snapshot</h3>
      <table class="config-table">
        <tr><td>Generated At</td><td>${escapeHtml(snapshot.generatedAt)}</td></tr>
        <tr><td>Signature</td><td><code>${escapeHtml(snapshot.signature)}</code></td></tr>
        <tr><td>Runtime Enabled</td><td>${snapshot.configEnabled ? 'yes' : 'no'}</td></tr>
        <tr><td>Discovered Files</td><td>${escapeHtml(String(snapshot.scannedFiles))}</td></tr>
        <tr><td>Loaded Skills</td><td>${escapeHtml(String(snapshot.loadedSkills))}</td></tr>
        <tr><td>Injected Skills</td><td>${escapeHtml(String(snapshot.includedSkills.length))}</td></tr>
        <tr><td>Prompt XML Chars</td><td>${escapeHtml(String(snapshot.promptXml.length))}</td></tr>
        <tr><td>Budget</td><td><code>maxLoadedSkills=${escapeHtml(String(snapshot.budget.maxSkills))}</code>, <code>maxSkillChars=${escapeHtml(String(snapshot.budget.maxChars))}</code></td></tr>
      </table>
      <div style="margin-top:0.9rem">
        <strong>Discovery Order</strong>
        <ul style="margin:0.5rem 0 0 1.25rem">${directories}</ul>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Injected Skills</h3>
      <table class="config-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Path</th>
            <th>Source</th>
            <th>Always</th>
            <th>Requires</th>
            <th>Chars</th>
          </tr>
        </thead>
        <tbody>
          ${renderIncludedRows(snapshot.includedSkills)}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Filtered / Skipped</h3>
      <table class="config-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Name</th>
            <th>Path</th>
            <th>Source</th>
            <th>Reason</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${renderSkippedRows(snapshot.skipped)}
        </tbody>
      </table>
    </div>
  `;
}
