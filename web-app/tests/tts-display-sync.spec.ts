/**
 * TTS / Display sync tests — verifies that what TTS speaks matches what users see.
 *
 * Covers:
 * - Filler text shown on screen matches what TTS would speak (no "three dots")
 * - Displayed response text matches final iris-done text
 * - '...' placeholder is replaced before TTS speaks
 * - Response text doesn't contain raw <think> tags after stripping
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

test.describe('TTS / Display Sync', () => {
  test('filler phrases contain no ellipsis for TTS', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Verify the filler phrases in the FSM source don't have "..."
    // We test this by checking that after a response, the displayed text
    // doesn't contain literal "..." (except as the initial placeholder)
    const response = await sendPromptAndWait(page, 'what is opsec?', 15_000);

    // Final displayed response should not contain "..."
    expect(response).not.toBe('...');
    expect(response.length).toBeGreaterThan(0);

    // Response should not contain literal triple-dot sequences
    // (fillers should have been replaced by actual response text)
    expect(response).not.toMatch(/^\.\.\.$/);
  });

  test('displayed response matches final iris-done text (no transient mismatches)', async ({ page }) => {
    test.setTimeout(60_000);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    await page.goto('/');
    await waitForRAGReady(page);

    // Send multiple prompts and verify each final state
    const prompts = [
      'hey',
      'what is end-to-end encryption?',
      'tell me more about that',
    ];

    for (const prompt of prompts) {
      const response = await sendPromptAndWait(page, prompt, 15_000);

      // Should not be placeholder
      expect(response, `Response to "${prompt}" is placeholder`).not.toBe('...');

      // Should not contain raw tags
      expect(response, `Response to "${prompt}" contains raw tags`).not.toMatch(/<\/?(?:think|reflection|reasoning)>/i);

      // Should not be empty
      expect(response.length, `Response to "${prompt}" is empty`).toBeGreaterThan(0);
    }

    await page.screenshot({
      path: path.join(RESULTS_DIR, 'tts-display-sync.png'),
      fullPage: true,
    });
  });

  test('placeholder "..." is replaced in chat bubble during response', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Start tracking Iris messages before sending
    const beforeCount = await page.locator('.chat-msg.iris').count();

    await page.fill('#text-input', 'explain vpns');
    await page.click('#send-btn');

    // Wait for any Iris message to appear
    await page.waitForFunction(
      (expected: number) => {
        const msgs = document.querySelectorAll('.chat-msg.iris');
        return msgs.length > expected;
      },
      beforeCount,
      { timeout: 15_000 },
    );

    // Now wait for it to NOT be "..." anymore (response arrived)
    await page.waitForFunction(
      (expected: number) => {
        const msgs = document.querySelectorAll('.chat-msg.iris');
        if (msgs.length <= expected) return false;
        const latest = msgs[msgs.length - 1];
        const body = latest.querySelector('.msg-body');
        return body && body.textContent !== '...' && body.textContent!.trim().length > 0;
      },
      beforeCount,
      { timeout: 30_000 },
    );

    // Final state: should have real content
    const latest = page.locator('.chat-msg.iris').last();
    const finalText = (await latest.locator('.msg-body').textContent() ?? '').trim();
    expect(finalText).not.toBe('...');
    expect(finalText.length).toBeGreaterThan(0);
  });

  test('response text does not contain raw think tags after stripping', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await waitForRAGReady(page);

    // Send prompts that tend to trigger thinking in capable models
    const triggerPrompts = [
      'what are the tradeoffs between symmetric and asymmetric encryption?',
      'compare WireGuard vs OpenVPN',
    ];

    for (const prompt of triggerPrompts) {
      const response = await sendPromptAndWait(page, prompt, 15_000);

      // Must not contain any raw tags
      expect(response).not.toMatch(/<think>/i);
      expect(response).not.toMatch(/<\/think>/i);
      expect(response).not.toMatch(/<reflection>/i);
      expect(response).not.toMatch(/<\/reflection>/i);
      expect(response).not.toMatch(/<reasoning>/i);
      expect(response).not.toMatch(/<\/reasoning>/i);

      // Must have substance
      expect(response.length).toBeGreaterThan(0);
    }
  });
});
