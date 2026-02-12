/**
 * Lightweight adaptive bias for conversation feel.
 *
 * 3 parameters (0-1 range), adjusted after each turn based on user behavior.
 * Decays 10% toward default (0.5) each turn to prevent "sticking."
 * No persistence — resets on page reload.
 */

export interface BiasParams {
  /** Controls max_tokens (40-120) and length budget preference */
  verbosity: number;
  /** High depth → always include knowledge lane; low → playbook-only */
  depth: number;
  /** High warmth → empathetic tone preference */
  warmth: number;
}

const DEFAULT = 0.5;
const DECAY_RATE = 0.1;

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class ConversationBias {
  private params: BiasParams = { verbosity: DEFAULT, depth: DEFAULT, warmth: DEFAULT };

  /** Current bias values (read-only snapshot) */
  get current(): Readonly<BiasParams> {
    return { ...this.params };
  }

  /** Map verbosity (0-1) to max_tokens (40-120) */
  get maxTokens(): number {
    return Math.round(40 + this.params.verbosity * 80);
  }

  /**
   * Observe a completed turn and adjust bias parameters.
   * Call this after each user message is processed.
   */
  observeTurn(userText: string, intent: string): void {
    const wordCount = userText.trim().split(/\s+/).length;

    // Short input → be more concise
    if (wordCount < 5) {
      this.params.verbosity = clamp(this.params.verbosity - 0.1);
    }

    // Long input → more detailed response
    if (wordCount > 20) {
      this.params.verbosity = clamp(this.params.verbosity + 0.1);
    }

    // Follow-up signals → go deeper
    const followUpPattern = /\b(tell me more|elaborate|explain|go on|details|what do you mean|more about)\b/i;
    if (followUpPattern.test(userText)) {
      this.params.depth = clamp(this.params.depth + 0.15);
    }

    // Venting → warmer tone
    if (intent === 'vent') {
      this.params.warmth = clamp(this.params.warmth + 0.2);
    }

    // Decay toward default after adjustments
    this.params.verbosity += (DEFAULT - this.params.verbosity) * DECAY_RATE;
    this.params.depth += (DEFAULT - this.params.depth) * DECAY_RATE;
    this.params.warmth += (DEFAULT - this.params.warmth) * DECAY_RATE;
  }

  /** Reset to defaults */
  reset(): void {
    this.params = { verbosity: DEFAULT, depth: DEFAULT, warmth: DEFAULT };
  }
}
