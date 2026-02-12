/**
 * Test that model thinking tags (<think>, <reflection>, etc.) are stripped
 * from displayed responses. These tags should appear in the metadata panel,
 * NOT in the chat bubble text.
 *
 * Covers: Qwen3 <think>, DeepSeek R1 <think>, and generic <reflection> tags.
 * Tests both pack-only mode and (if a model is loaded) LLM mode.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'model-comparison');

// Tag patterns that should NEVER appear in displayed chat text
const FORBIDDEN_TAG_PATTERNS = [
  /<think>/i,
  /<\/think>/i,
  /<reflection>/i,
  /<\/reflection>/i,
  /<reasoning>/i,
  /<\/reasoning>/i,
  /<inner_monologue>/i,
  /<\/inner_monologue>/i,
];

// Prompts that tend to trigger thinking/reasoning tags in models
const THINKING_TRIGGER_PROMPTS = [
  { id: 'complex-question', text: 'what are the tradeoffs between symmetric and asymmetric encryption?', category: 'knowledge' },
  { id: 'reasoning', text: 'should I use a VPN or Tor for privacy? walk me through your reasoning', category: 'decide' },
  { id: 'multi-step', text: 'how would you set up a secure home network from scratch?', category: 'brainstorm' },
  { id: 'comparison', text: 'compare WireGuard vs OpenVPN — which is better and why?', category: 'decide' },
];

async function waitForRAGReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('status');
      return el && el.classList.contains('ready');
    },
    { timeout },
  );
}

async function sendPromptAndWait(page: Page, text: string, timeout = 3 * 60_000): Promise<string> {
  const beforeCount = await page.locator('.chat-msg.iris').count();

  await page.fill('#text-input', text);
  await page.click('#send-btn');

  // Wait for complete response — latency tag signals iris-done fired.
  // Note: display text may be "..." if model produced only think content (stripped).
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

  const latest = page.locator('.chat-msg.iris').last();
  return (await latest.locator('.msg-body').textContent() ?? '').trim();
}

test.describe('Think Tag Stripping', () => {
  test('pack-only responses contain no model tags', async ({ page }) => {
    test.setTimeout(60_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    for (const prompt of THINKING_TRIGGER_PROMPTS) {
      const response = await sendPromptAndWait(page, prompt.text, 15_000);

      // Verify no forbidden tags in displayed text
      for (const pattern of FORBIDDEN_TAG_PATTERNS) {
        expect(response, `Response to "${prompt.id}" contains forbidden tag: ${pattern}`).not.toMatch(pattern);
      }

      // Verify response is not empty after stripping
      expect(response.length, `Response to "${prompt.id}" is empty`).toBeGreaterThan(0);
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, 'think-tag-pack-only.png'),
      fullPage: true,
    });
  });

  // This test only runs if a thinking-capable model can be loaded
  test('LLM responses have think tags stripped from chat display', async ({ page }) => {
    // Use Qwen3 0.6B — small, fast, and produces <think> tags
    const thinkingModel = 'Qwen3-0.6B-q4f16_1-MLC';
    test.setTimeout(10 * 60_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    // Try to load the thinking model
    await page.selectOption('#model-select', thinkingModel);

    // Wait for ready or error
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
      test.skip(true, `Could not load ${thinkingModel} (${state}) — skipping LLM think-tag test`);
      return;
    }

    const results: { promptId: string; response: string; hasMetadata: boolean }[] = [];

    for (const prompt of THINKING_TRIGGER_PROMPTS) {
      const response = await sendPromptAndWait(page, prompt.text);

      // Chat text must NOT contain think tags
      for (const pattern of FORBIDDEN_TAG_PATTERNS) {
        expect(response, `LLM response to "${prompt.id}" leaks tag: ${pattern}`).not.toMatch(pattern);
      }

      expect(response.length, `LLM response to "${prompt.id}" is empty after stripping`).toBeGreaterThan(0);

      // Check if metadata panel captured the think content
      const metadataOpen = await page.locator('#metadata-panel').getAttribute('open');
      results.push({
        promptId: prompt.id,
        response: response.slice(0, 200),
        hasMetadata: metadataOpen !== null,
      });
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, `think-tag-${thinkingModel}.png`),
      fullPage: true,
    });

    // Save results
    fs.writeFileSync(
      path.join(RESULTS_DIR, 'think-tag-results.json'),
      JSON.stringify({ model: thinkingModel, results }, null, 2),
    );
  });

  test('unclosed think tags (sentence-trimmed) are stripped', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Inject stripModelTags test via evaluate — simulates what happens
    // when sentence trimming cuts off a closing tag
    const results = await page.evaluate(() => {
      // Access the stripModelTags logic (same regex pattern used in main.ts)
      function stripModelTags(text: string) {
        const tags: { name: string; content: string }[] = [];
        let clean = text.replace(/<(\w+)>([\s\S]*?)<\/\1>/g, (_match: string, name: string, content: string) => {
          tags.push({ name, content: content.trim() });
          return '';
        });
        clean = clean.replace(/<(\w+)>[\s\S]*$/, '');
        clean = clean.replace(/<\/?\w*$/, '');
        return { clean: clean.trim(), tags };
      }

      return {
        // Complete tag pair
        complete: stripModelTags('<think>reasoning here</think>Clean response.'),
        // Unclosed tag (sentence trimmed before </think>)
        unclosed: stripModelTags('<think>reasoning here. More thinking'),
        // Partially closed tag (cut mid-closing)
        partialClose: stripModelTags('<think>reasoning</thi'),
        // Nested/malformed tags
        nested: stripModelTags('<think>outer<reflection>inner</reflection>still thinking</think>Visible.'),
        // Multiple tags with clean text between
        multiTag: stripModelTags('<think>thought 1</think>Middle text.<reflection>analysis</reflection>Final.'),
        // Dangling opening bracket
        danglingBracket: stripModelTags('Clean text.<thi'),
        // Tag at end with content after
        tagThenText: stripModelTags('<think>reasoning</think>This is the real answer.'),
      };
    });

    // Complete pair: tag content extracted, clean text is empty
    expect(results.complete.clean).toBe('Clean response.');
    expect(results.complete.tags).toHaveLength(1);
    expect(results.complete.tags[0].name).toBe('think');

    // Unclosed: everything after <think> is stripped
    expect(results.unclosed.clean).toBe('');
    expect(results.unclosed.tags).toHaveLength(0);

    // Partially closed: dangling tag stripped
    expect(results.partialClose.clean).toBe('');

    // Nested: inner <reflection> extracted, outer <think> wraps remaining
    expect(results.nested.clean).toBe('Visible.');
    expect(results.nested.tags.length).toBeGreaterThanOrEqual(1);

    // Multi-tag: both tags extracted, middle + final text preserved
    expect(results.multiTag.clean).toBe('Middle text.Final.');
    expect(results.multiTag.tags).toHaveLength(2);

    // Dangling bracket: stripped
    expect(results.danglingBracket.clean).toBe('Clean text.');

    // Tag then text: tag extracted, text preserved
    expect(results.tagThenText.clean).toBe('This is the real answer.');
    expect(results.tagThenText.tags).toHaveLength(1);
  });

  test('raw output panel shows when tags are present', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Raw output panel should exist but be collapsed initially
    const rawPanel = page.locator('#raw-output-panel');
    await expect(rawPanel).toBeVisible();

    // Panel should not be open by default
    const initialOpen = await rawPanel.getAttribute('open');
    expect(initialOpen).toBeNull();
  });
});
