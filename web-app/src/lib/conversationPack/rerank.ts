/**
 * Reranker: scores candidates using relevance + metadata match + intent bonus + anti-repeat.
 */
import type { ConversationState, RetrievalCandidate } from './types.js';
import type { RawCandidate } from './retrieve.js';
import { RecentMemory } from './memory.js';

// ── Weight configuration ─────────────────────────────────────────────

const WEIGHTS = {
  vector: 0.40,
  lexical: 0.20,
  metadata: 0.15,
  intentBonus: 0.15,
  repeatPenalty: 0.50,
};

// ── Metadata scoring ─────────────────────────────────────────────────

function metadataBonus(candidate: RawCandidate, state: ConversationState): number {
  let bonus = 0;

  // Tone match bonus
  if (candidate.item.tone.includes(state.tone)) bonus += 0.4;

  // Length match bonus
  if (candidate.item.length === state.length) bonus += 0.3;

  // Domain keyword overlap bonus
  const domainLower = candidate.item.domain.map(d => d.toLowerCase());
  for (const kw of state.keywords) {
    if (domainLower.some(d => d.includes(kw) || kw.includes(d))) {
      bonus += 0.15;
    }
  }

  return Math.min(bonus, 1.0);
}

// ── Main rerank function ─────────────────────────────────────────────

export function rerank(
  candidates: RawCandidate[],
  state: ConversationState,
  memory: RecentMemory,
): RetrievalCandidate[] {
  const ranked: RetrievalCandidate[] = candidates.map(c => {
    const meta = metadataBonus(c, state);
    const repeat = memory.penalty(c.item.id);
    const intent = c.intentBonus ?? 0;

    const finalScore =
      WEIGHTS.vector * c.vectorScore +
      WEIGHTS.lexical * c.lexicalScore +
      WEIGHTS.metadata * meta +
      WEIGHTS.intentBonus * intent -
      WEIGHTS.repeatPenalty * repeat;

    return {
      item: c.item,
      vectorScore: c.vectorScore,
      lexicalScore: c.lexicalScore,
      metadataBonus: meta,
      repeatPenalty: repeat,
      finalScore,
    };
  });

  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked;
}
