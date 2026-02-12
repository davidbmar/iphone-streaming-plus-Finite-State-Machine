/**
 * In-app diagnostic test runner.
 *
 * Sends diagnostic prompts through the FSM, captures ComposeResult
 * directly from iris-done events (no DOM scraping), runs flag checks,
 * and persists results to localStorage.
 */
import type { ComposeResult } from './conversationPack/types.js';
import type { ConversationFSM, FSMState } from './conversationFSM.js';
import type { TurnSnapshot, DiagnosticRun, DiagnosticFlag } from './diagnosticTypes.js';
import { DIAGNOSTIC_PROMPTS, persistRun } from './diagnosticTypes.js';
import { isModelLoaded, getLoadedModelId } from './llm.js';

// ── Types ────────────────────────────────────────────────────────────

export type RunnerStatus = 'idle' | 'running' | 'complete' | 'cancelled';

export interface RunnerCallbacks {
  onTurnStart: (index: number, total: number, prompt: string) => void;
  onTurnComplete: (index: number, snapshot: TurnSnapshot) => void;
  onRunComplete: (run: DiagnosticRun) => void;
  onStatusChange: (status: RunnerStatus) => void;
}

type StripTagsFn = (text: string) => {
  clean: string;
  tags: Array<{ name: string; content: string }>;
};

// ── Runner ───────────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 30_000;

export class DiagnosticRunner {
  private fsm: ConversationFSM;
  private submitFn: (text: string) => void;
  private stripTagsFn: StripTagsFn;
  private _status: RunnerStatus = 'idle';
  private aborted = false;

  constructor(
    fsm: ConversationFSM,
    submitFn: (text: string) => void,
    stripTagsFn: StripTagsFn,
  ) {
    this.fsm = fsm;
    this.submitFn = submitFn;
    this.stripTagsFn = stripTagsFn;
  }

  get status(): RunnerStatus {
    return this._status;
  }

  async run(callbacks: RunnerCallbacks): Promise<DiagnosticRun | null> {
    if (this._status === 'running') return null;
    this._status = 'running';
    this.aborted = false;
    callbacks.onStatusChange('running');

    const turns: TurnSnapshot[] = [];
    const mode = this.detectMode();
    const total = DIAGNOSTIC_PROMPTS.length;

    for (let i = 0; i < total; i++) {
      if (this.aborted) break;

      const prompt = DIAGNOSTIC_PROMPTS[i];
      callbacks.onTurnStart(i, total, prompt.text);

      // Wait for FSM to be idle before sending
      await this.waitForIdle();
      if (this.aborted) break;

      try {
        const result = await this.sendAndCapture(prompt.text);
        const snapshot = this.buildSnapshot(prompt, result);
        turns.push(snapshot);
        callbacks.onTurnComplete(i, snapshot);
      } catch (e) {
        // Timeout or error — record a failed turn
        const failedSnapshot: TurnSnapshot = {
          prompt: prompt.text,
          promptId: prompt.id,
          promptCategory: prompt.category,
          displayedText: '',
          rawLLMOutput: '',
          ragContextSnippets: [],
          metadataTags: [],
          debugInfo: {
            intent: 'unknown', tone: 'unknown', llmUsed: false,
            candidateCount: 0, chosenOpener: null, chosenSubstance: null,
            latencyMs: 0, fsmState: this.fsm.currentState,
          },
          flags: [{
            type: 'filler-remnant',
            severity: 'error',
            detail: `Turn failed: ${e instanceof Error ? e.message : String(e)}`,
          }],
        };
        turns.push(failedSnapshot);
        callbacks.onTurnComplete(i, failedSnapshot);
      }
    }

    const run = this.buildRun(mode, turns);
    persistRun(run);

    this._status = this.aborted ? 'cancelled' : 'complete';
    callbacks.onStatusChange(this._status);
    callbacks.onRunComplete(run);
    return run;
  }

  cancel(): void {
    this.aborted = true;
    this._status = 'cancelled';
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private sendAndCapture(text: string): Promise<ComposeResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fsm.off('iris-done', handler);
        reject(new Error(`Timeout waiting for response to "${text.slice(0, 30)}..."`));
      }, TURN_TIMEOUT_MS);

      const handler = (result: ComposeResult) => {
        clearTimeout(timeout);
        this.fsm.off('iris-done', handler);
        resolve(result);
      };

      this.fsm.on('iris-done', handler);
      this.submitFn(text);
    });
  }

  private waitForIdle(): Promise<void> {
    if (this.fsm.currentState === 'IDLE') return Promise.resolve();
    return new Promise((resolve) => {
      const check = (state: FSMState) => {
        if (state === 'IDLE') {
          this.fsm.off('state-change', check);
          resolve();
        }
      };
      this.fsm.on('state-change', check);
    });
  }

  private buildSnapshot(
    prompt: typeof DIAGNOSTIC_PROMPTS[number],
    result: ComposeResult,
  ): TurnSnapshot {
    const { clean, tags } = this.stripTagsFn(result.replyText);
    const debug = result.debug;

    const snapshot: TurnSnapshot = {
      prompt: prompt.text,
      promptId: prompt.id,
      promptCategory: prompt.category,
      displayedText: (clean.length < result.replyText.length)
        ? (clean || '[reasoning only]')
        : clean,
      rawLLMOutput: result.replyText,
      ragContextSnippets: debug.contextSnippets ?? [],
      metadataTags: tags,
      debugInfo: {
        intent: debug.state.intent,
        tone: debug.state.tone,
        llmUsed: debug.llmUsed ?? false,
        candidateCount: debug.candidates.length,
        chosenOpener: debug.chosenOpener,
        chosenSubstance: debug.chosenSubstance,
        latencyMs: debug.latency.totalMs,
        fsmState: this.fsm.currentState,
      },
      flags: [],
    };

    snapshot.flags = this.analyzeFlags(prompt, snapshot);
    return snapshot;
  }

  private analyzeFlags(
    prompt: typeof DIAGNOSTIC_PROMPTS[number],
    snapshot: TurnSnapshot,
  ): DiagnosticFlag[] {
    const flags: DiagnosticFlag[] = [];
    const { displayedText, rawLLMOutput, debugInfo, ragContextSnippets } = snapshot;

    // 1. Tag leakage
    if (/<\/?(?:think|reflection|reasoning|inner_monologue)>/i.test(displayedText)) {
      flags.push({
        type: 'tag-leakage',
        severity: 'error',
        detail: `Raw tags in displayed text: "${displayedText.slice(0, 100)}"`,
      });
    }

    // 2. Empty after strip
    if (displayedText.length === 0 && rawLLMOutput.length > 0) {
      flags.push({
        type: 'empty-after-strip',
        severity: 'error',
        detail: `Display empty but raw output has ${rawLLMOutput.length} chars`,
      });
    }

    // 3. RAG miss
    const isKnowledge = /\b(what|how|explain|compare|why)\b/i.test(prompt.text);
    if (isKnowledge && debugInfo.llmUsed && ragContextSnippets.length === 0) {
      flags.push({
        type: 'rag-miss',
        severity: 'warning',
        detail: `Knowledge question but no RAG context provided`,
      });
    }

    // 4. Filler remnant
    if (displayedText === '...' || /^(One sec|Running a trace|Checking the mesh|Let me pull)/i.test(displayedText)) {
      flags.push({
        type: 'filler-remnant',
        severity: 'error',
        detail: `Filler in final response: "${displayedText}"`,
      });
    }

    // 5. Truncation
    if (isKnowledge && displayedText.length > 0 && displayedText.length < 15) {
      flags.push({
        type: 'truncation',
        severity: 'warning',
        detail: `${displayedText.length} chars for knowledge question`,
      });
    }

    // 6. Repetition
    const sentences = displayedText
      .split(/[.!?]+/)
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 10);
    const unique = new Set(sentences);
    if (sentences.length > 2 && unique.size < sentences.length * 0.5) {
      flags.push({
        type: 'repetition',
        severity: 'warning',
        detail: `${unique.size} unique of ${sentences.length} sentences`,
      });
    }

    return flags;
  }

  private buildRun(mode: string, turns: TurnSnapshot[]): DiagnosticRun {
    const allFlags = turns.flatMap(t => t.flags);
    const flagsByType: Record<string, number> = {};
    for (const flag of allFlags) {
      flagsByType[flag.type] = (flagsByType[flag.type] ?? 0) + 1;
    }

    const latencies = turns.map(t => t.debugInfo.latencyMs).filter(l => l > 0);
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      mode,
      turns,
      summary: {
        totalTurns: DIAGNOSTIC_PROMPTS.length,
        completedTurns: turns.length,
        totalFlags: allFlags.length,
        errorCount: allFlags.filter(f => f.severity === 'error').length,
        warningCount: allFlags.filter(f => f.severity === 'warning').length,
        flagsByType,
        avgLatencyMs,
      },
    };
  }

  private detectMode(): string {
    if (isModelLoaded()) {
      return getLoadedModelId() ?? 'unknown-model';
    }
    return 'pack-only';
  }
}
