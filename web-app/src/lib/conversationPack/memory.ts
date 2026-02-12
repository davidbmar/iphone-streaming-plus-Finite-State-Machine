/**
 * Recently-used chunk tracking for anti-repeat penalty,
 * plus conversation history for context-aware retrieval.
 */
import type { ConversationTurn } from './types.js';

const DEFAULT_WINDOW = 20;
const MAX_HISTORY = 10;

/** Strip <think> and similar model reasoning tags before storing in history. */
function stripTagsForHistory(text: string): string {
  let clean = text.replace(/<(\w+)>([\s\S]*?)<\/\1>/g, '');
  clean = clean.replace(/<(\w+)>[\s\S]*$/, '');
  clean = clean.replace(/<\/?\w*$/, '');
  return clean.trim();
}

export class RecentMemory {
  private used: string[] = [];
  private window: number;
  private history: ConversationTurn[] = [];

  constructor(window: number = DEFAULT_WINDOW) {
    this.window = window;
  }

  // ── Chunk ID tracking (existing) ────────────────────────────────────

  /** Record a chunk id as used */
  record(id: string): void {
    this.used.push(id);
    if (this.used.length > this.window * 2) {
      this.used = this.used.slice(-this.window);
    }
  }

  /** Record multiple chunk ids */
  recordMany(ids: string[]): void {
    for (const id of ids) this.record(id);
  }

  /**
   * Get repeat penalty for a chunk id.
   * Returns 0 if not recently used, up to 1.0 for the most recent.
   */
  penalty(id: string): number {
    const lastIndex = this.used.lastIndexOf(id);
    if (lastIndex === -1) return 0;

    const recency = this.used.length - lastIndex;
    if (recency > this.window) return 0;

    // Linear decay: most recent = 1.0, oldest in window = 0.1
    return 0.1 + 0.9 * (1 - recency / this.window);
  }

  /** Get IDs used in the last N conversation turns (for hard exclusion) */
  getRecentTurnItemIds(n: number): Set<string> {
    const ids = new Set<string>();
    const recent = this.history.slice(-n);
    for (const turn of recent) {
      for (const id of turn.usedItemIds) ids.add(id);
    }
    return ids;
  }

  /** Get all recently used ids (for debug) */
  getRecent(): string[] {
    return this.used.slice(-this.window);
  }

  // ── Conversation history ────────────────────────────────────────────

  /** Record a full conversation turn */
  recordTurn(userText: string, irisText: string, intent: string, usedItemIds: string[]): void {
    this.history.push({
      userText,
      irisText: stripTagsForHistory(irisText),
      intent,
      timestamp: Date.now(),
      usedItemIds,
    });
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  /** Get full conversation history */
  getHistory(): ConversationTurn[] {
    return this.history;
  }

  /** Get the last conversation turn, or null if none */
  getLastTurn(): ConversationTurn | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /** Get the last N turns */
  getRecentN(n: number): ConversationTurn[] {
    return this.history.slice(-n);
  }

  /** Clear all memory */
  clear(): void {
    this.used = [];
    this.history = [];
  }
}
