/**
 * Pack-only baseline test.
 * No model loaded — establishes response quality and latency from RAG pack alone.
 * Should complete in < 30 seconds (all responses < 50ms).
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
  llmUsed: false;
  intent: string;
  timestamp: number;
}

async function waitForRAGReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('status');
      return el && el.classList.contains('ready');
    },
    { timeout },
  );
}

async function sendPromptAndWait(page: Page, text: string, timeout = 10_000): Promise<{
  responseText: string;
  latencyMs: number | null;
}> {
  const beforeCount = await page.locator('.chat-msg.iris').count();

  await page.fill('#text-input', text);
  await page.click('#send-btn');

  // Wait for complete response (latency tag = iris-done fired)
  await page.waitForFunction(
    (expected: number) => {
      const msgs = document.querySelectorAll('.chat-msg.iris');
      if (msgs.length <= expected) return false;
      const latest = msgs[msgs.length - 1];
      const body = latest.querySelector('.msg-body');
      const hasContent = body && body.textContent!.trim().length > 0;
      const hasLatency = latest.querySelector('.latency-tag') !== null;
      return hasContent && hasLatency;
    },
    beforeCount,
    { timeout },
  );

  const latest = page.locator('.chat-msg.iris').last();
  const responseText = await latest.locator('.msg-body').textContent() ?? '';
  const latencyTag = await latest.locator('.latency-tag').textContent().catch(() => null);
  const latencyMs = latencyTag ? parseFloat(latencyTag.replace('ms', '')) : null;

  return { responseText: responseText.trim(), latencyMs };
}

async function extractDebugInfo(page: Page): Promise<{ intent: string }> {
  return page.evaluate(() => {
    const debugEl = document.getElementById('debug-content');
    if (!debugEl) return { intent: 'unknown' };
    const html = debugEl.innerHTML;
    const intentMatch = html.match(/intent=<b>(\w+)<\/b>/);
    return { intent: intentMatch ? intentMatch[1] : 'unknown' };
  });
}

test.describe('Pack-Only Baseline', () => {
  test('all prompts get responses without LLM', async ({ page }) => {
    // Shorter timeout for pack-only
    test.setTimeout(60_000);

    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    // Verify no model is loaded (default state)
    const llmStatus = await page.locator('#llm-status').textContent();
    expect(llmStatus).toContain('none');

    const results: PromptResult[] = [];

    for (const prompt of testData.prompts) {
      const { responseText, latencyMs } = await sendPromptAndWait(page, prompt.text);
      const debug = await extractDebugInfo(page);

      expect(responseText.length).toBeGreaterThan(0);

      // Pack-only should be fast
      if (latencyMs !== null) {
        expect(latencyMs).toBeLessThan(500);
      }

      results.push({
        promptId: prompt.id,
        promptText: prompt.text,
        category: prompt.category,
        responseText,
        latencyMs,
        llmUsed: false,
        intent: debug.intent,
        timestamp: Date.now(),
      });
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, 'pack-only-final.png'),
      fullPage: true,
    });

    // Save baseline results
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'pack-only-results.json'),
      JSON.stringify({
        modelId: 'pack-only',
        loadTimeMs: 0,
        prompts: results,
        avgLatencyMs: Math.round(
          results.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / results.length,
        ),
        llmUsageRate: 0,
      }, null, 2),
    );
  });
});
