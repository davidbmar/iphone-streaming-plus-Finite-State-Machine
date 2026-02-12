/**
 * Automated model comparison test.
 * Loads each model from the subset, sends standard prompts, captures responses.
 * Results saved as JSON for report generation.
 *
 * NOTE: Models require real WebGPU (not swiftshader). If a model fails to load,
 * the test records the failure and continues to the next model.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import testData from './test-prompts.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'model-comparison');

interface PromptResult {
  promptId: string;
  promptText: string;
  category: string;
  responseText: string;
  latencyMs: number | null;
  llmUsed: boolean;
  intent: string;
  timestamp: number;
}

interface ModelResult {
  modelId: string;
  loadTimeMs: number;
  loadError: string | null;
  prompts: PromptResult[];
  avgLatencyMs: number;
  llmUsageRate: number;
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

/**
 * Wait for model to reach 'ready' or 'error' state.
 * Returns { loaded: true } or { loaded: false, error: string }.
 */
async function waitForModelSettled(page: Page, timeout = 5 * 60_000): Promise<{
  loaded: boolean;
  error: string | null;
  timeMs: number;
}> {
  const start = Date.now();

  const result = await page.waitForFunction(
    () => {
      const el = document.getElementById('llm-status');
      if (!el) return null;
      if (el.classList.contains('ready')) return 'ready';
      if (el.classList.contains('error')) return 'error';
      return null; // still loading
    },
    { timeout },
  ).then(handle => handle.jsonValue())
    .catch(() => 'timeout' as string);

  const timeMs = Date.now() - start;

  if (result === 'ready') {
    return { loaded: true, error: null, timeMs };
  }

  // Capture error details from console or status text
  const statusText = await page.locator('#llm-status').textContent().catch(() => 'unknown');
  const errorDetail = result === 'timeout'
    ? `Model load timed out after ${Math.round(timeMs / 1000)}s`
    : `Model load failed: ${statusText}`;

  return { loaded: false, error: errorDetail, timeMs };
}

async function sendPromptAndWait(page: Page, text: string, timeout = 3 * 60_000): Promise<{
  responseText: string;
  latencyMs: number | null;
}> {
  const beforeCount = await page.locator('.chat-msg.iris').count();

  await page.fill('#text-input', text);
  await page.click('#send-btn');

  // Wait for response to COMPLETE — latency tag appears only when iris-done fires.
  // This handles both pack-only (instant) and LLM streaming (waits for full response).
  await page.waitForFunction(
    (expected: number) => {
      const msgs = document.querySelectorAll('.chat-msg.iris');
      if (msgs.length <= expected) return false;
      const latest = msgs[msgs.length - 1];
      const body = latest.querySelector('.msg-body');
      const hasContent = body && body.textContent !== '...' && body.textContent!.trim().length > 0;
      const hasLatency = latest.querySelector('.latency-tag') !== null;
      return hasContent && hasLatency;
    },
    beforeCount,
    { timeout },
  );

  const irisMessages = page.locator('.chat-msg.iris');
  const latest = irisMessages.last();
  const responseText = await latest.locator('.msg-body').textContent() ?? '';
  const latencyTag = await latest.locator('.latency-tag').textContent().catch(() => null);
  const latencyMs = latencyTag ? parseFloat(latencyTag.replace('ms', '')) : null;

  return { responseText: responseText.trim(), latencyMs };
}

async function extractDebugInfo(page: Page): Promise<{ intent: string; llmUsed: boolean }> {
  return page.evaluate(() => {
    const debugEl = document.getElementById('debug-content');
    if (!debugEl) return { intent: 'unknown', llmUsed: false };

    const html = debugEl.innerHTML;
    const intentMatch = html.match(/intent=<b>(\w+)<\/b>/);
    const intent = intentMatch ? intentMatch[1] : 'unknown';
    const llmUsed = html.includes('LLM-enhanced');

    return { intent, llmUsed };
  });
}

function ensureResultsDir() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// ── Tests ───────────────────────────────────────────────────────────

const models = testData.modelSubset;

test.describe.serial('Model Comparison', () => {
  const allResults: ModelResult[] = [];

  for (const modelId of models) {
    test.describe(modelId, () => {
      test(`load and test ${modelId}`, async ({ page }) => {
        ensureResultsDir();

        // Capture console errors for diagnostics
        const consoleErrors: string[] = [];
        page.on('console', msg => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        // Navigate and wait for RAG
        await page.goto('/');
        await waitForRAGReady(page);

        // Select model from dropdown
        await page.selectOption('#model-select', modelId);

        // Wait for model to settle (ready OR error)
        const loadResult = await waitForModelSettled(page);

        await page.screenshot({
          path: path.join(RESULTS_DIR, `${modelId}-loaded.png`),
        });

        if (!loadResult.loaded) {
          // Record failure but don't fail the test — other models may work
          const failResult: ModelResult = {
            modelId,
            loadTimeMs: loadResult.timeMs,
            loadError: loadResult.error,
            prompts: [],
            avgLatencyMs: 0,
            llmUsageRate: 0,
          };
          allResults.push(failResult);

          fs.writeFileSync(
            path.join(RESULTS_DIR, `${modelId}-results.json`),
            JSON.stringify({
              ...failResult,
              consoleErrors: consoleErrors.slice(0, 10),
            }, null, 2),
          );

          console.log(`⚠ ${modelId}: ${loadResult.error}`);
          console.log(`  Console errors: ${consoleErrors.length}`);
          if (consoleErrors.length > 0) {
            console.log(`  First error: ${consoleErrors[0].slice(0, 200)}`);
          }

          // Skip prompts but don't fail — test framework continues to next model
          test.skip(true, `${modelId} failed to load: ${loadResult.error}`);
          return;
        }

        console.log(`✓ ${modelId} loaded in ${Math.round(loadResult.timeMs / 1000)}s`);

        // Run all prompts
        const promptResults: PromptResult[] = [];

        for (const prompt of testData.prompts) {
          const { responseText, latencyMs } = await sendPromptAndWait(page, prompt.text);
          const debug = await extractDebugInfo(page);

          promptResults.push({
            promptId: prompt.id,
            promptText: prompt.text,
            category: prompt.category,
            responseText,
            latencyMs,
            llmUsed: debug.llmUsed,
            intent: debug.intent,
            timestamp: Date.now(),
          });

          await page.screenshot({
            path: path.join(RESULTS_DIR, `${modelId}-${prompt.id}.png`),
          });
        }

        // Compute aggregates
        const latencies = promptResults
          .map(r => r.latencyMs)
          .filter((v): v is number => v !== null);
        const avgLatencyMs = latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : 0;
        const llmUsageRate = promptResults.filter(r => r.llmUsed).length / promptResults.length;

        const modelResult: ModelResult = {
          modelId,
          loadTimeMs: loadResult.timeMs,
          loadError: null,
          prompts: promptResults,
          avgLatencyMs,
          llmUsageRate,
        };

        allResults.push(modelResult);

        fs.writeFileSync(
          path.join(RESULTS_DIR, `${modelId}-results.json`),
          JSON.stringify(modelResult, null, 2),
        );
      });
    });
  }

  test.afterAll(() => {
    if (allResults.length > 0) {
      ensureResultsDir();
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'comparison.json'),
        JSON.stringify({ timestamp: Date.now(), models: allResults }, null, 2),
      );
    }
  });
});
