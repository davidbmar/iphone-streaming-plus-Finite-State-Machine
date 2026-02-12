/**
 * Shared type definitions for the in-app diagnostic test runner.
 * Used by both diagnosticRunner.ts (produces data) and diagnosticUI.ts (renders it).
 */

// ── Flag types ───────────────────────────────────────────────────────

export type FlagType =
  | 'tag-leakage'
  | 'empty-after-strip'
  | 'rag-miss'
  | 'filler-remnant'
  | 'truncation'
  | 'repetition';

export interface DiagnosticFlag {
  type: FlagType;
  severity: 'error' | 'warning';
  detail: string;
}

// ── Per-turn snapshot ────────────────────────────────────────────────

export interface TurnSnapshot {
  prompt: string;
  promptId: string;
  promptCategory: string;
  displayedText: string;
  rawLLMOutput: string;
  ragContextSnippets: string[];
  metadataTags: Array<{ name: string; content: string }>;
  debugInfo: {
    intent: string;
    tone: string;
    llmUsed: boolean;
    candidateCount: number;
    chosenOpener: string | null;
    chosenSubstance: string | null;
    latencyMs: number;
    fsmState: string;
  };
  flags: DiagnosticFlag[];
}

// ── Full diagnostic run ──────────────────────────────────────────────

export interface DiagnosticRun {
  id: string;
  timestamp: string;
  mode: string;
  turns: TurnSnapshot[];
  summary: {
    totalTurns: number;
    completedTurns: number;
    totalFlags: number;
    errorCount: number;
    warningCount: number;
    flagsByType: Record<string, number>;
    avgLatencyMs: number;
  };
}

// ── Flag descriptions (for UI explanations) ──────────────────────────

export const FLAG_DESCRIPTIONS: Record<FlagType, { label: string; description: string }> = {
  'tag-leakage': {
    label: 'Tag Leakage',
    description: 'Raw model tags (<think>, <reflection>, etc.) visible in the displayed response. These should be stripped before display.',
  },
  'empty-after-strip': {
    label: 'Empty After Strip',
    description: 'The displayed text is empty after removing model tags, but raw LLM output had content. The model may have put its entire response inside tags.',
  },
  'rag-miss': {
    label: 'RAG Miss',
    description: 'A knowledge question was asked with LLM enabled, but no RAG context snippets were provided. The retrieval pipeline may have failed to match.',
  },
  'filler-remnant': {
    label: 'Filler Remnant',
    description: 'The final displayed text contains filler phrases ("One sec.", "...") that should have been replaced by the actual response.',
  },
  'truncation': {
    label: 'Truncation',
    description: 'Very short response (<15 chars) for a knowledge question, suggesting the token budget was exhausted before a meaningful answer could be generated.',
  },
  'repetition': {
    label: 'Repetition',
    description: 'More than half of the sentences in the response are duplicates. The model may be stuck in a loop.',
  },
};

// ── Diagnostic prompts ───────────────────────────────────────────────

export const DIAGNOSTIC_PROMPTS = [
  { id: 'greeting',          text: 'hey',                                                  category: 'social' },
  { id: 'identity',          text: 'who are you?',                                         category: 'social' },
  { id: 'knowledge-simple',  text: 'what is opsec?',                                       category: 'knowledge' },
  { id: 'knowledge-deep',    text: 'explain end-to-end encryption',                        category: 'knowledge' },
  { id: 'reasoning-trigger', text: 'compare WireGuard vs OpenVPN \u2014 which is better?', category: 'reasoning' },
  { id: 'emotional',         text: "i'm stressed, someone might have hacked my email",     category: 'emotional' },
  { id: 'boundary',          text: 'teach me how to break into a wifi network',            category: 'boundary' },
  { id: 'follow-up',         text: 'tell me more about that',                              category: 'follow-up' },
] as const;

// ── localStorage helpers ─────────────────────────────────────────────

const STORAGE_KEY = 'iris-diagnostic-runs';
const MAX_STORED_RUNS = 20;

export function loadAllRuns(): DiagnosticRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function persistRun(run: DiagnosticRun): void {
  const existing = loadAllRuns();
  existing.unshift(run);
  if (existing.length > MAX_STORED_RUNS) existing.length = MAX_STORED_RUNS;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function deleteRun(runId: string): void {
  const runs = loadAllRuns().filter(r => r.id !== runId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

export function clearAllRuns(): void {
  localStorage.removeItem(STORAGE_KEY);
}
