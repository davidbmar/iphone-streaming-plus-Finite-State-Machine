/**
 * Token-to-Sentence accumulator for streaming LLM output.
 * Accumulates tokens and emits complete sentences at boundary characters.
 */

/** Common abbreviations that end with a period but aren't sentence boundaries */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'dept', 'est', 'fig', 'gen', 'gov', 'inc', 'ltd', 'no', 'vol',
  'vs', 'etc', 'approx', 'dept', 'div', 'ext',
  'i.e', 'e.g', 'u.s', 'u.k',
]);

export class SentenceBuffer {
  private buffer = '';
  private onSentence: (sentence: string) => void;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  /** Push a token (or chunk of text) into the buffer. Emits sentences as they complete. */
  push(token: string): void {
    this.buffer += token;
    this.drain();
  }

  /** Force-emit any remaining text (call on stream end). */
  flush(): void {
    const text = this.buffer.trim();
    if (text) {
      this.onSentence(text);
    }
    this.buffer = '';
  }

  /** Reset without emitting. */
  clear(): void {
    this.buffer = '';
  }

  private drain(): void {
    // Scan for sentence-ending punctuation followed by whitespace or end
    // We look for: .!? followed by optional quote/paren then whitespace
    const pattern = /([.!?])(["')\]]?)(\s+)/g;
    let match: RegExpExecArray | null;
    let lastEmitEnd = 0;

    while ((match = pattern.exec(this.buffer)) !== null) {
      const boundaryIdx = match.index;
      const afterBoundary = match.index + match[0].length;

      // Check for abbreviation: get the word before the period
      if (match[1] === '.') {
        const before = this.buffer.substring(lastEmitEnd, boundaryIdx);
        const lastWord = before.split(/\s+/).pop()?.toLowerCase().replace(/\.$/, '') ?? '';

        // Skip if abbreviation
        if (ABBREVIATIONS.has(lastWord)) continue;

        // Skip if ellipsis (multiple dots)
        if (boundaryIdx > 0 && this.buffer[boundaryIdx - 1] === '.') continue;
        if (boundaryIdx < this.buffer.length - 1 && this.buffer[boundaryIdx + 1] === '.') continue;
      }

      // Emit the sentence
      const sentence = this.buffer.substring(lastEmitEnd, afterBoundary).trim();
      if (sentence) {
        this.onSentence(sentence);
      }
      lastEmitEnd = afterBoundary;
    }

    // Remove emitted text from buffer
    if (lastEmitEnd > 0) {
      this.buffer = this.buffer.substring(lastEmitEnd);
    }
  }
}
