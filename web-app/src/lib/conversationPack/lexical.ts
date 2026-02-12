/**
 * Lightweight lexical scorer: token overlap + character slang phrase boost.
 * BM25-ish but simplified for speed.
 */

// Character slang terms get extra weight
const SLANG_TERMS: string[] = [
  'black ice', 'ice', 'corpsec', 'mesh', 'sprawl', 'runner', 'deck',
  'opsec', 'ghost', 'phantom', 'wetware', 'chrome', 'jack in',
  'flatline', 'bricked', 'zero-day', 'exploit', 'payload',
  'shadownet', 'darkpool', 'dead drop', 'burn notice',
  'cipher', 'encrypt', 'decrypt', 'proxy', 'tunnel',
  'firewall', 'node', 'signal', 'noise', 'trace',
];

const SLANG_BOOST = 0.3;

// Stop words to ignore
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'to', 'of', 'in', 'and', 'or',
  'for', 'on', 'at', 'by', 'do', 'be', 'as', 'i', 'my', 'me',
  'we', 'us', 'so', 'no', 'not', 'but', 'if', 'up', 'out',
  'this', 'that', 'with', 'from', 'they', 'them', 'you', 'your',
  'was', 'are', 'has', 'had', 'have', 'will', 'can', 'just',
  'about', 'what', 'how', 'when', 'where', 'who', 'which',
]);

/** Tokenize and filter stop words */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Score a candidate text against a query.
 * Returns a score in [0, 1+] range.
 */
export function lexicalScore(query: string, candidateText: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const candidateLower = candidateText.toLowerCase();
  const candidateTokens = new Set(tokenize(candidateText));

  // Token overlap (Jaccard-ish)
  let overlapCount = 0;
  for (const qt of queryTokens) {
    if (candidateTokens.has(qt)) overlapCount++;
  }
  const overlap = overlapCount / queryTokens.length;

  // Slang phrase boost
  const queryLower = query.toLowerCase();
  let slangBoost = 0;
  for (const slang of SLANG_TERMS) {
    if (queryLower.includes(slang) && candidateLower.includes(slang)) {
      slangBoost += SLANG_BOOST;
    }
  }

  return Math.min(overlap + slangBoost, 2.0);
}

/**
 * Batch score multiple candidates against a query.
 * Returns array of scores aligned with input candidates.
 */
export function batchLexicalScore(query: string, texts: string[]): number[] {
  return texts.map(t => lexicalScore(query, t));
}
