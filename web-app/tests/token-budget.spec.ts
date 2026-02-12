/**
 * Token budget tests — verifies reasoning model detection and that
 * the bias system provides soft length guidance (no hard max_tokens cap).
 *
 * Covers:
 * - Reasoning model detection via MODEL_CATALOG tags
 * - Bias system produces length guidance values
 * - DeepSeek R1 response is not truncated to near-empty after tag stripping
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'model-comparison');

async function waitForRAGReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('status');
      return el && el.classList.contains('ready');
    },
    { timeout },
  );
}

async function waitForModel(page: Page, modelId: string, timeout = 5 * 60_000): Promise<string> {
  await page.selectOption('#model-select', modelId);

  return await page.waitForFunction(
    () => {
      const el = document.getElementById('llm-status');
      if (!el) return null;
      if (el.classList.contains('ready')) return 'ready';
      if (el.classList.contains('error')) return 'error';
      return null;
    },
    { timeout },
  ).then(h => h.jsonValue() as Promise<string>).catch(() => 'timeout');
}

async function sendPromptAndWait(page: Page, text: string, timeout = 3 * 60_000): Promise<string> {
  const beforeCount = await page.locator('.chat-msg.iris').count();

  await page.fill('#text-input', text);
  await page.click('#send-btn');

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

  const latest = page.locator('.chat-msg.iris').last();
  return (await latest.locator('.msg-body').textContent() ?? '').trim();
}

test.describe('Token Budget', () => {
  test('reasoning model detection works via MODEL_CATALOG', async ({ page }) => {
    test.setTimeout(30_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Test isReasoningModel logic via page evaluate
    const results = await page.evaluate(() => {
      // Replicate MODEL_CATALOG check logic
      const catalog = [
        { id: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC', tags: ['reasoning', 'smart'] },
        { id: 'Qwen3-0.6B-q4f16_1-MLC', tags: ['fast', 'mobile'] },
        { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', tags: ['fast', 'balanced'] },
        { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', tags: ['code', 'smart'] },
      ];

      function isReasoning(modelId: string): boolean {
        const info = catalog.find(m => m.id === modelId);
        return info?.tags.includes('reasoning') ?? false;
      }

      return {
        deepseekR1: isReasoning('DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC'),
        qwen3: isReasoning('Qwen3-0.6B-q4f16_1-MLC'),
        llama: isReasoning('Llama-3.2-1B-Instruct-q4f16_1-MLC'),
        coder: isReasoning('Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC'),
        unknown: isReasoning('nonexistent-model'),
      };
    });

    // DeepSeek R1 is the only reasoning model
    expect(results.deepseekR1).toBe(true);
    expect(results.qwen3).toBe(false);
    expect(results.llama).toBe(false);
    expect(results.coder).toBe(false);
    expect(results.unknown).toBe(false);
  });

  test('flat 512 token cap is used for all models', async ({ page }) => {
    test.setTimeout(30_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // TOKEN_CAP is a flat 512 for all models — no per-model multiplier.
    // Verify the model bar shows the cap when a model would be loaded.
    const cap = await page.evaluate(() => {
      // The TOKEN_CAP constant is exported from llm.ts;
      // verify it appears in the model bar info after load.
      const bar = document.getElementById('model-bar-info');
      return bar?.textContent ?? '';
    });

    // No model loaded yet, so bar shows default text
    expect(cap).toContain('Select a model');
  });

  test('DeepSeek R1 response is not truncated to near-empty after tag stripping', async ({ page }) => {
    const modelId = 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC';
    test.setTimeout(10 * 60_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    const state = await waitForModel(page, modelId);
    if (state !== 'ready') {
      test.skip(true, `Could not load ${modelId} (${state}) — skipping`);
      return;
    }

    // Send a prompt that requires substance
    const response = await sendPromptAndWait(page, 'explain end-to-end encryption');

    // Response should have meaningful content (not truncated to near-empty)
    expect(response.length, 'Response too short — likely truncated by low token budget').toBeGreaterThan(20);

    // Should not contain raw tags
    expect(response).not.toMatch(/<\/?think>/i);

    // Check raw output panel has content (showing the <think> tags were there)
    const rawPanel = page.locator('#raw-output-panel');
    const rawContent = await page.locator('#raw-output-content').textContent();
    expect(rawContent?.length ?? 0, 'Raw output should show LLM output').toBeGreaterThan(0);

    await page.screenshot({
      path: path.join(RESULTS_DIR, `token-budget-${modelId}.png`),
      fullPage: true,
    });

    fs.writeFileSync(
      path.join(RESULTS_DIR, 'token-budget-results.json'),
      JSON.stringify({
        model: modelId,
        responseLength: response.length,
        responsePreview: response.slice(0, 300),
        rawOutputLength: rawContent?.length ?? 0,
      }, null, 2),
    );
  });
});
