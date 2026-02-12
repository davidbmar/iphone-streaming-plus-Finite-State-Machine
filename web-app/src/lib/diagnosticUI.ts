/**
 * Diagnostic results UI — renders progress, results, history, and comparison.
 *
 * Security note: All dynamic content (prompts, flag details, timestamps, etc.)
 * is escaped via esc() which uses DOM textContent→innerHTML (same pattern as
 * escapeHtml in main.ts). This prevents XSS from model output or stored data.
 */
import type { TurnSnapshot, DiagnosticRun, DiagnosticFlag } from './diagnosticTypes.js';
import { FLAG_DESCRIPTIONS, loadAllRuns, deleteRun, clearAllRuns } from './diagnosticTypes.js';

// ── HTML escaping (DOM-based, same as main.ts escapeHtml) ────────────

function esc(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// ── Severity helpers ─────────────────────────────────────────────────

function severityColor(flags: DiagnosticFlag[]): 'success' | 'warning' | 'error' {
  if (flags.some(f => f.severity === 'error')) return 'error';
  if (flags.some(f => f.severity === 'warning')) return 'warning';
  return 'success';
}

function severityIcon(sev: 'success' | 'warning' | 'error'): string {
  if (sev === 'error') return 'X';
  if (sev === 'warning') return '!';
  return 'OK';
}

// ── Progress view (during run) ───────────────────────────────────────

export function renderRunProgress(
  container: HTMLElement,
  index: number,
  total: number,
  prompt: string,
  completedTurns: TurnSnapshot[],
): void {
  const lines: string[] = [];
  lines.push(`<div class="diag-progress-header">Running diagnostic suite... (${index + 1}/${total})</div>`);

  for (let i = 0; i < completedTurns.length; i++) {
    const t = completedTurns[i];
    const sev = severityColor(t.flags);
    const icon = severityIcon(sev);
    lines.push(
      `<div class="diag-progress-turn diag-${sev}">` +
      `<span class="diag-progress-icon">${icon}</span> ` +
      `#${i + 1} "${esc(t.prompt)}" ` +
      `<span class="diag-progress-latency">${t.debugInfo.latencyMs}ms</span>` +
      `${t.flags.length > 0 ? ` <span class="diag-flag-badge diag-badge-${sev}">${t.flags.length} flag${t.flags.length > 1 ? 's' : ''}</span>` : ''}` +
      `</div>`,
    );
  }

  // Current running turn
  if (index < total) {
    lines.push(
      `<div class="diag-progress-turn diag-running">` +
      `<span class="diag-progress-icon">...</span> ` +
      `#${completedTurns.length + 1} "${esc(prompt)}" ` +
      `<span class="diag-progress-latency">running...</span>` +
      `</div>`,
    );
  }

  container.innerHTML = lines.join('');
}

// ── Results view (after run completes) ───────────────────────────────

export function renderRunComplete(container: HTMLElement, run: DiagnosticRun): void {
  const lines: string[] = [];

  // Header
  const ts = new Date(run.timestamp).toLocaleString();
  lines.push(`<div class="diag-results-header">`);
  lines.push(`<div class="diag-results-meta">${esc(ts)} | ${esc(run.mode)} | ${run.turns.length} turns</div>`);
  lines.push(`<div class="diag-results-summary">`);
  if (run.summary.errorCount > 0) {
    lines.push(`<span class="diag-flag-badge diag-badge-error">${run.summary.errorCount} error${run.summary.errorCount > 1 ? 's' : ''}</span> `);
  }
  if (run.summary.warningCount > 0) {
    lines.push(`<span class="diag-flag-badge diag-badge-warning">${run.summary.warningCount} warning${run.summary.warningCount > 1 ? 's' : ''}</span> `);
  }
  if (run.summary.errorCount === 0 && run.summary.warningCount === 0) {
    lines.push(`<span class="diag-flag-badge diag-badge-success">All clear</span>`);
  }
  lines.push(`<span class="diag-avg-latency">avg ${run.summary.avgLatencyMs}ms</span>`);
  lines.push(`</div></div>`);

  // Turns list
  lines.push(`<div class="diag-turns-list">`);
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    const sev = severityColor(t.flags);
    const icon = severityIcon(sev);
    lines.push(
      `<div class="diag-turn diag-turn-${sev}" data-turn-index="${i}">` +
      `<div class="diag-turn-row">` +
      `<span class="diag-turn-icon">${icon}</span> ` +
      `<span class="diag-turn-prompt">#${i + 1} "${esc(t.prompt)}"</span>` +
      `<span class="diag-turn-info">` +
      `<span class="diag-turn-intent">${esc(t.debugInfo.intent)}</span> ` +
      `<span class="diag-turn-latency">${t.debugInfo.latencyMs}ms</span>` +
      `</span>` +
      `</div>` +
      renderTurnFlags(t.flags) +
      `<div class="diag-detail" style="display:none">${renderTurnDetail(t)}</div>` +
      `</div>`,
    );
  }
  lines.push(`</div>`);

  // Flag legend
  const usedTypes = new Set(run.turns.flatMap(t => t.flags.map(f => f.type)));
  if (usedTypes.size > 0) {
    lines.push(`<div class="diag-legend"><div class="diag-legend-title">Flag Legend</div>`);
    for (const type of usedTypes) {
      const desc = FLAG_DESCRIPTIONS[type];
      lines.push(
        `<div class="diag-legend-item">` +
        `<span class="diag-legend-label">${esc(desc.label)}</span>` +
        `<span class="diag-legend-desc">${esc(desc.description)}</span>` +
        `</div>`,
      );
    }
    lines.push(`</div>`);
  }

  // History / Compare buttons
  lines.push(`<div class="diag-actions">`);
  lines.push(`<button class="diag-action-btn" data-action="history">View History</button>`);
  const allRuns = loadAllRuns();
  if (allRuns.length > 1) {
    lines.push(`<button class="diag-action-btn" data-action="compare">Compare Runs</button>`);
  }
  lines.push(`</div>`);

  container.innerHTML = lines.join('');

  // Wire click-to-expand on turns
  container.querySelectorAll('.diag-turn').forEach(el => {
    el.addEventListener('click', () => {
      const detail = el.querySelector('.diag-detail') as HTMLElement;
      if (detail) {
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      }
    });
  });

  // Wire action buttons
  container.querySelectorAll('.diag-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'history') renderRunHistory(container);
      if (action === 'compare') renderComparisonPicker(container, run);
    });
  });
}

// ── Turn detail (expanded) ──────────────────────────────────────────

function renderTurnFlags(flags: DiagnosticFlag[]): string {
  if (flags.length === 0) return '';
  return `<div class="diag-turn-flags">${flags.map(f =>
    `<span class="diag-flag-badge diag-badge-${f.severity}" title="${esc(f.detail)}">${esc(FLAG_DESCRIPTIONS[f.type].label)}</span>`
  ).join(' ')}</div>`;
}

function renderTurnDetail(t: TurnSnapshot): string {
  const lines: string[] = [];

  lines.push(`<div class="diag-detail-section">`);
  lines.push(`<div class="diag-detail-label">Prompt</div>`);
  lines.push(`<div class="diag-detail-value">${esc(t.prompt)}</div>`);
  lines.push(`</div>`);

  lines.push(`<div class="diag-detail-section">`);
  lines.push(`<div class="diag-detail-label">Pipeline</div>`);
  lines.push(`<div class="diag-detail-value">intent=${esc(t.debugInfo.intent)} tone=${esc(t.debugInfo.tone)} llm=${t.debugInfo.llmUsed} candidates=${t.debugInfo.candidateCount}</div>`);
  lines.push(`</div>`);

  if (t.debugInfo.chosenOpener || t.debugInfo.chosenSubstance) {
    lines.push(`<div class="diag-detail-section">`);
    lines.push(`<div class="diag-detail-label">Chosen</div>`);
    lines.push(`<div class="diag-detail-value">opener=${esc(t.debugInfo.chosenOpener ?? 'none')} substance=${esc(t.debugInfo.chosenSubstance ?? 'none')}</div>`);
    lines.push(`</div>`);
  }

  lines.push(`<div class="diag-detail-section">`);
  lines.push(`<div class="diag-detail-label">Displayed Text</div>`);
  lines.push(`<pre class="diag-detail-pre">${esc(t.displayedText || '(empty)')}</pre>`);
  lines.push(`</div>`);

  if (t.rawLLMOutput && t.rawLLMOutput !== t.displayedText) {
    lines.push(`<div class="diag-detail-section">`);
    lines.push(`<div class="diag-detail-label">Raw LLM Output</div>`);
    lines.push(`<pre class="diag-detail-pre">${esc(t.rawLLMOutput)}</pre>`);
    lines.push(`</div>`);
  }

  if (t.ragContextSnippets.length > 0) {
    lines.push(`<div class="diag-detail-section">`);
    lines.push(`<div class="diag-detail-label">RAG Context (${t.ragContextSnippets.length})</div>`);
    for (const s of t.ragContextSnippets) {
      lines.push(`<pre class="diag-detail-pre diag-detail-snippet">${esc(s)}</pre>`);
    }
    lines.push(`</div>`);
  }

  if (t.metadataTags.length > 0) {
    lines.push(`<div class="diag-detail-section">`);
    lines.push(`<div class="diag-detail-label">Metadata Tags (${t.metadataTags.length})</div>`);
    for (const tag of t.metadataTags) {
      lines.push(`<div class="diag-detail-value">&lt;${esc(tag.name)}&gt; ${esc(tag.content.slice(0, 200))}</div>`);
    }
    lines.push(`</div>`);
  }

  if (t.flags.length > 0) {
    lines.push(`<div class="diag-detail-section">`);
    lines.push(`<div class="diag-detail-label">Flags</div>`);
    for (const f of t.flags) {
      const desc = FLAG_DESCRIPTIONS[f.type];
      lines.push(
        `<div class="diag-detail-flag diag-detail-flag-${f.severity}">` +
        `<strong>${esc(desc.label)}</strong> (${f.severity}): ${esc(f.detail)}` +
        `<div class="diag-detail-flag-explain">${esc(desc.description)}</div>` +
        `</div>`,
      );
    }
    lines.push(`</div>`);
  }

  return lines.join('');
}

// ── History view ─────────────────────────────────────────────────────

export function renderRunHistory(container: HTMLElement): void {
  const runs = loadAllRuns();

  if (runs.length === 0) {
    container.innerHTML = '<div class="debug-placeholder">No diagnostic runs yet. Click "Run Tests" to start.</div>';
    return;
  }

  const lines: string[] = [];
  lines.push(`<div class="diag-history-header">Diagnostic History (${runs.length} run${runs.length > 1 ? 's' : ''})</div>`);

  for (const run of runs) {
    const ts = new Date(run.timestamp).toLocaleString();
    const sev = run.summary.errorCount > 0 ? 'error' : run.summary.warningCount > 0 ? 'warning' : 'success';
    lines.push(
      `<div class="diag-history-row diag-turn-${sev}" data-run-id="${esc(run.id)}">` +
      `<span class="diag-history-date">${esc(ts)}</span> ` +
      `<span class="diag-history-mode">${esc(run.mode)}</span> ` +
      `<span class="diag-history-stats">` +
      `${run.summary.errorCount} error${run.summary.errorCount !== 1 ? 's' : ''} ` +
      `${run.summary.warningCount} warning${run.summary.warningCount !== 1 ? 's' : ''}` +
      `</span>` +
      `<span class="diag-history-actions">` +
      `<button class="diag-history-btn" data-action="view" data-run-id="${esc(run.id)}">View</button>` +
      `<button class="diag-history-btn diag-history-btn-del" data-action="delete" data-run-id="${esc(run.id)}">Del</button>` +
      `</span>` +
      `</div>`,
    );
  }

  lines.push(`<div class="diag-actions">`);
  lines.push(`<button class="diag-action-btn diag-action-btn-danger" data-action="clear-all">Clear All</button>`);
  lines.push(`</div>`);

  container.innerHTML = lines.join('');

  // Wire buttons
  container.querySelectorAll('.diag-history-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      const runId = (btn as HTMLElement).dataset.runId;
      if (!runId) return;

      if (action === 'view') {
        const run = runs.find(r => r.id === runId);
        if (run) renderRunComplete(container, run);
      }
      if (action === 'delete') {
        deleteRun(runId);
        renderRunHistory(container);
      }
    });
  });

  container.querySelector('[data-action="clear-all"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearAllRuns();
    renderRunHistory(container);
  });
}

// ── Comparison picker ────────────────────────────────────────────────

function renderComparisonPicker(container: HTMLElement, currentRun: DiagnosticRun): void {
  const runs = loadAllRuns().filter(r => r.id !== currentRun.id);
  if (runs.length === 0) return;

  const lines: string[] = [];
  lines.push(`<div class="diag-compare-picker">`);
  lines.push(`<div class="diag-compare-title">Compare "${esc(currentRun.mode)}" with:</div>`);
  lines.push(`<select class="diag-compare-select">`);
  for (const r of runs) {
    const ts = new Date(r.timestamp).toLocaleString();
    lines.push(`<option value="${esc(r.id)}">${esc(ts)} — ${esc(r.mode)}</option>`);
  }
  lines.push(`</select>`);
  lines.push(`<button class="diag-action-btn" data-action="do-compare">Compare</button>`);
  lines.push(`<button class="diag-action-btn" data-action="back-to-results">Back</button>`);
  lines.push(`</div>`);

  container.innerHTML = lines.join('');

  container.querySelector('[data-action="do-compare"]')?.addEventListener('click', () => {
    const select = container.querySelector('.diag-compare-select') as HTMLSelectElement;
    const otherId = select.value;
    const otherRun = loadAllRuns().find(r => r.id === otherId);
    if (otherRun) renderComparison(container, currentRun, otherRun);
  });

  container.querySelector('[data-action="back-to-results"]')?.addEventListener('click', () => {
    renderRunComplete(container, currentRun);
  });
}

// ── Comparison view ──────────────────────────────────────────────────

export function renderComparison(
  container: HTMLElement,
  runA: DiagnosticRun,
  runB: DiagnosticRun,
): void {
  const lines: string[] = [];
  const tsA = new Date(runA.timestamp).toLocaleString();
  const tsB = new Date(runB.timestamp).toLocaleString();

  lines.push(`<div class="diag-compare-header">`);
  lines.push(`<div class="diag-compare-col-header">A: ${esc(runA.mode)} (${esc(tsA)})</div>`);
  lines.push(`<div class="diag-compare-col-header">B: ${esc(runB.mode)} (${esc(tsB)})</div>`);
  lines.push(`</div>`);

  lines.push(`<table class="diag-comparison-table"><thead><tr>`);
  lines.push(`<th>Prompt</th><th>A</th><th>B</th>`);
  lines.push(`</tr></thead><tbody>`);

  // Match turns by promptId
  const turnsA = new Map(runA.turns.map(t => [t.promptId, t]));
  const turnsB = new Map(runB.turns.map(t => [t.promptId, t]));
  const allIds = [...new Set([...turnsA.keys(), ...turnsB.keys()])];

  for (const id of allIds) {
    const tA = turnsA.get(id);
    const tB = turnsB.get(id);
    const prompt = tA?.prompt ?? tB?.prompt ?? id;
    const sevA = tA ? severityColor(tA.flags) : 'error';
    const sevB = tB ? severityColor(tB.flags) : 'error';

    lines.push(`<tr>`);
    lines.push(`<td class="diag-compare-prompt">${esc(prompt)}</td>`);
    lines.push(`<td class="diag-compare-cell diag-cell-${sevA}">${tA ? `${severityIcon(sevA)} ${tA.debugInfo.latencyMs}ms` : 'N/A'}</td>`);
    lines.push(`<td class="diag-compare-cell diag-cell-${sevB}">${tB ? `${severityIcon(sevB)} ${tB.debugInfo.latencyMs}ms` : 'N/A'}</td>`);
    lines.push(`</tr>`);
  }

  lines.push(`</tbody></table>`);

  lines.push(`<div class="diag-actions">`);
  lines.push(`<button class="diag-action-btn" data-action="back-a">View Run A</button>`);
  lines.push(`<button class="diag-action-btn" data-action="back-b">View Run B</button>`);
  lines.push(`<button class="diag-action-btn" data-action="history">History</button>`);
  lines.push(`</div>`);

  container.innerHTML = lines.join('');

  container.querySelector('[data-action="back-a"]')?.addEventListener('click', () => renderRunComplete(container, runA));
  container.querySelector('[data-action="back-b"]')?.addEventListener('click', () => renderRunComplete(container, runB));
  container.querySelector('[data-action="history"]')?.addEventListener('click', () => renderRunHistory(container));
}

// ── Badge updater ────────────────────────────────────────────────────

export function updateDiagnosticBadge(badgeEl: HTMLElement, run: DiagnosticRun | null): void {
  if (!run) {
    badgeEl.style.display = 'none';
    return;
  }

  badgeEl.style.display = 'inline';
  if (run.summary.errorCount > 0) {
    badgeEl.textContent = `${run.summary.errorCount}E`;
    badgeEl.className = 'diagnostic-badge diag-badge-error';
  } else if (run.summary.warningCount > 0) {
    badgeEl.textContent = `${run.summary.warningCount}W`;
    badgeEl.className = 'diagnostic-badge diag-badge-warning';
  } else {
    badgeEl.textContent = 'OK';
    badgeEl.className = 'diagnostic-badge diag-badge-success';
  }
}
