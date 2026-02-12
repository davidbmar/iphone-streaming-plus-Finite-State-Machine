/**
 * Diagnostic Snapshot Test — captures full pipeline state per turn.
 *
 * For each prompt, collects:
 * - RAG context snippets (what was fed to the LLM)
 * - Raw LLM output (before tag stripping)
 * - Metadata tags extracted
 * - Final displayed chat text
 * - Debug panel data (intent, candidates, latency)
 *
 * Auto-flags anomalies:
 * - Tag leakage: raw tags in displayed text
 * - Empty after strip: response empty after removing think content
 * - RAG miss: knowledge question but no RAG context provided
 * - Filler remnant: "..." or filler text left in final response
 * - Truncation: very short response suggesting token budget exhaustion
 *
 * Saves full snapshot as JSON for analysis by developer or Claude.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'diagnostics');

// ── Types ────────────────────────────────────────────────────────────

interface DiagnosticFlag {
  type: 'tag-leakage' | 'empty-after-strip' | 'rag-miss' | 'filler-remnant' | 'truncation' | 'repetition';
  severity: 'error' | 'warning';
  detail: string;
}

interface TurnSnapshot {
  prompt: string;
  displayedText: string;
  rawLLMOutput: string;
  ragContextSnippets: string[];
  metadataTags: string[];
  debugInfo: {
    intent: string;
    tone: string;
    llmUsed: boolean;
    candidateCount: number;
    chosenOpener: string;
    chosenSubstance: string;
    latencyMs: number;
  };
  flags: DiagnosticFlag[];
}

interface DiagnosticReport {
  timestamp: string;
  model: string;
  turns: TurnSnapshot[];
  summary: {
    totalTurns: number;
    totalFlags: number;
    errorCount: number;
    warningCount: number;
    flagsByType: Record<string, number>;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function waitForRAGReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('status');
      return el && el.classList.contains('ready');
    },
    { timeout },
  );
}

async function sendAndCaptureFull(page: Page, text: string, timeout = 3 * 60_000): Promise<TurnSnapshot> {
  const beforeCount = await page.locator('.chat-msg.iris').count();

  await page.fill('#text-input', text);
  await page.click('#send-btn');

  // Wait for complete response — latency tag signals iris-done fired.
  // Display text may be "..." if model produced only think content (stripped).
  await page.waitForFunction(
    (expected: number) => {
      const msgs = document.querySelectorAll('.chat-msg.iris');
      if (msgs.length <= expected) return false;
      const latest = msgs[msgs.length - 1];
      const hasLatency = latest.querySelector('.latency-tag') !== null;
      return hasLatency;
    },
    beforeCount,
    { timeout },
  );

  // Collect all observable data from the page
  const snapshot = await page.evaluate(() => {
    // Display text
    const msgs = document.querySelectorAll('.chat-msg.iris');
    const latest = msgs[msgs.length - 1];
    const displayedText = latest?.querySelector('.msg-body')?.textContent?.trim() ?? '';

    // Raw LLM output
    const rawOutput = document.getElementById('raw-output-content')?.textContent?.trim() ?? '';

    // RAG context snippets
    const ragSnippets: string[] = [];
    document.querySelectorAll('#rag-context-content .rag-snippet').forEach(el => {
      const label = el.querySelector('.rag-snippet-label')?.textContent ?? '';
      const text = el.querySelector('.rag-snippet-text')?.textContent ?? '';
      ragSnippets.push(`[${label}] ${text}`);
    });

    // Metadata tags
    const metadataTags: string[] = [];
    document.querySelectorAll('#metadata-content .debug-section').forEach(el => {
      const label = el.querySelector('.debug-label')?.textContent ?? '';
      const pre = el.querySelector('.metadata-pre')?.textContent ?? '';
      if (label && pre) metadataTags.push(`${label}: ${pre.slice(0, 200)}`);
    });

    // Debug info
    const debugHtml = document.getElementById('debug-content')?.innerHTML ?? '';
    const intentMatch = debugHtml.match(/intent=<b>(\w+)<\/b>/);
    const toneMatch = debugHtml.match(/tone=<b>([\w-]+)<\/b>/);
    const latencyMatch = debugHtml.match(/total=([\d.]+)ms/);
    const openerMatch = debugHtml.match(/opener=<b>([^<]+)<\/b>/);
    const substanceMatch = debugHtml.match(/substance=<b>([^<]+)<\/b>/);
    const candidateEls = document.querySelectorAll('#debug-content .debug-candidate');

    return {
      displayedText,
      rawLLMOutput: rawOutput,
      ragContextSnippets: ragSnippets,
      metadataTags,
      debugInfo: {
        intent: intentMatch?.[1] ?? 'unknown',
        tone: toneMatch?.[1] ?? 'unknown',
        llmUsed: debugHtml.includes('LLM-enhanced'),
        candidateCount: candidateEls.length,
        chosenOpener: openerMatch?.[1] ?? 'none',
        chosenSubstance: substanceMatch?.[1] ?? 'none',
        latencyMs: latencyMatch ? parseFloat(latencyMatch[1]) : 0,
      },
    };
  });

  // Auto-flag anomalies
  const flags: DiagnosticFlag[] = [];

  // Tag leakage check
  if (/<\/?(?:think|reflection|reasoning|inner_monologue)>/i.test(snapshot.displayedText)) {
    flags.push({
      type: 'tag-leakage',
      severity: 'error',
      detail: `Raw tags found in displayed text: "${snapshot.displayedText.slice(0, 100)}"`,
    });
  }

  // Empty after strip
  if (snapshot.displayedText.length === 0 && snapshot.rawLLMOutput.length > 0) {
    flags.push({
      type: 'empty-after-strip',
      severity: 'error',
      detail: `Display text empty but raw output has ${snapshot.rawLLMOutput.length} chars`,
    });
  }

  // RAG miss: knowledge question but no context
  const isKnowledgeQuestion = /\b(what|how|explain|compare|why)\b/i.test(text);
  if (isKnowledgeQuestion && snapshot.debugInfo.llmUsed && snapshot.ragContextSnippets.length === 0) {
    flags.push({
      type: 'rag-miss',
      severity: 'warning',
      detail: `Knowledge question "${text.slice(0, 50)}" but no RAG context provided`,
    });
  }

  // Filler remnant
  if (snapshot.displayedText === '...' || /^(One sec|Running a trace|Checking the mesh|Let me pull)/i.test(snapshot.displayedText)) {
    flags.push({
      type: 'filler-remnant',
      severity: 'error',
      detail: `Filler text left in final response: "${snapshot.displayedText}"`,
    });
  }

  // Truncation: very short response for a knowledge question
  if (isKnowledgeQuestion && snapshot.displayedText.length < 15 && snapshot.displayedText.length > 0) {
    flags.push({
      type: 'truncation',
      severity: 'warning',
      detail: `Very short response (${snapshot.displayedText.length} chars) for knowledge question — possible token budget issue`,
    });
  }

  // Repetition check
  const sentences = snapshot.displayedText.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 10);
  const unique = new Set(sentences);
  if (sentences.length > 2 && unique.size < sentences.length * 0.5) {
    flags.push({
      type: 'repetition',
      severity: 'warning',
      detail: `High repetition: ${unique.size} unique of ${sentences.length} sentences`,
    });
  }

  return {
    prompt: text,
    ...snapshot,
    flags,
  };
}

// ── Diagnostic prompts ──────────────────────────────────────────────

const DIAGNOSTIC_PROMPTS = [
  { id: 'greeting', text: 'hey', category: 'social' },
  { id: 'identity', text: 'who are you?', category: 'social' },
  { id: 'knowledge-simple', text: 'what is opsec?', category: 'knowledge' },
  { id: 'knowledge-deep', text: 'explain end-to-end encryption', category: 'knowledge' },
  { id: 'reasoning-trigger', text: 'compare WireGuard vs OpenVPN — which is better?', category: 'reasoning' },
  { id: 'emotional', text: "i'm stressed, someone might have hacked my email", category: 'emotional' },
  { id: 'boundary', text: 'teach me how to break into a wifi network', category: 'boundary' },
  { id: 'follow-up', text: 'tell me more about that', category: 'follow-up' },
];

// ── Tests ───────────────────────────────────────────────────────────

test.describe('Diagnostic Snapshot', () => {
  test('pack-only diagnostic capture', async ({ page }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    const turns: TurnSnapshot[] = [];

    for (const prompt of DIAGNOSTIC_PROMPTS) {
      const snapshot = await sendAndCaptureFull(page, prompt.text, 15_000);
      turns.push(snapshot);
    }

    const report = buildReport('pack-only', turns);
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'diagnostic-pack-only.json'),
      JSON.stringify(report, null, 2),
    );

    // Log summary
    console.log(`\n=== Diagnostic Report (pack-only) ===`);
    console.log(`Turns: ${report.summary.totalTurns}`);
    console.log(`Flags: ${report.summary.totalFlags} (${report.summary.errorCount} errors, ${report.summary.warningCount} warnings)`);
    for (const [type, count] of Object.entries(report.summary.flagsByType)) {
      console.log(`  ${type}: ${count}`);
    }
    for (const turn of turns) {
      if (turn.flags.length > 0) {
        console.log(`\n  "${turn.prompt}": ${turn.flags.length} flags`);
        for (const flag of turn.flags) {
          console.log(`    [${flag.severity}] ${flag.type}: ${flag.detail}`);
        }
      }
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, 'diagnostic-pack-only.png'),
      fullPage: true,
    });

    // Hard-fail on errors only (warnings are informational)
    expect(report.summary.errorCount, `${report.summary.errorCount} diagnostic errors found`).toBe(0);
  });

  test('LLM diagnostic capture', async ({ page }) => {
    const modelId = 'Qwen3-0.6B-q4f16_1-MLC';
    test.setTimeout(10 * 60_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    await page.selectOption('#model-select', modelId);
    const state = await page.waitForFunction(
      () => {
        const el = document.getElementById('llm-status');
        if (!el) return null;
        if (el.classList.contains('ready')) return 'ready';
        if (el.classList.contains('error')) return 'error';
        return null;
      },
      { timeout: 5 * 60_000 },
    ).then(h => h.jsonValue()).catch(() => 'timeout');

    if (state !== 'ready') {
      test.skip(true, `Could not load ${modelId} (${state}) — skipping LLM diagnostic`);
      return;
    }

    const turns: TurnSnapshot[] = [];

    for (const prompt of DIAGNOSTIC_PROMPTS) {
      const snapshot = await sendAndCaptureFull(page, prompt.text);
      turns.push(snapshot);
    }

    const report = buildReport(modelId, turns);
    fs.writeFileSync(
      path.join(RESULTS_DIR, `diagnostic-${modelId}.json`),
      JSON.stringify(report, null, 2),
    );

    console.log(`\n=== Diagnostic Report (${modelId}) ===`);
    console.log(`Turns: ${report.summary.totalTurns}`);
    console.log(`Flags: ${report.summary.totalFlags} (${report.summary.errorCount} errors, ${report.summary.warningCount} warnings)`);
    for (const [type, count] of Object.entries(report.summary.flagsByType)) {
      console.log(`  ${type}: ${count}`);
    }
    for (const turn of turns) {
      if (turn.flags.length > 0) {
        console.log(`\n  "${turn.prompt}": ${turn.flags.length} flags`);
        for (const flag of turn.flags) {
          console.log(`    [${flag.severity}] ${flag.type}: ${flag.detail}`);
        }
      }
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, `diagnostic-${modelId}.png`),
      fullPage: true,
    });

    // Hard-fail on errors
    expect(report.summary.errorCount, `${report.summary.errorCount} diagnostic errors found`).toBe(0);
  });
});

// ── Report builder ──────────────────────────────────────────────────

function buildReport(model: string, turns: TurnSnapshot[]): DiagnosticReport {
  const allFlags = turns.flatMap(t => t.flags);
  const flagsByType: Record<string, number> = {};
  for (const flag of allFlags) {
    flagsByType[flag.type] = (flagsByType[flag.type] ?? 0) + 1;
  }

  return {
    timestamp: new Date().toISOString(),
    model,
    turns,
    summary: {
      totalTurns: turns.length,
      totalFlags: allFlags.length,
      errorCount: allFlags.filter(f => f.severity === 'error').length,
      warningCount: allFlags.filter(f => f.severity === 'warning').length,
      flagsByType,
    },
  };
}
