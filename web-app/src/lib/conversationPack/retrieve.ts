/**
 * Dual-index retrieval: vector search + lexical boost + soft intent scoring.
 * Operates on the PackIndex structure.
 * Falls back to lexical-only when embeddings aren't ready.
 */
import type { PackItem, PackIndex, ConversationState } from './types.js';
import { lexicalScore } from './lexical.js';

export interface RawCandidate {
  item: PackItem;
  vectorScore: number;
  lexicalScore: number;
  intentBonus: number;
}

/**
 * Soft intent scoring: instead of hard-filtering, score items by relevance.
 * Returns a bonus multiplier for each item.
 */
function intentScore(item: PackItem, state: ConversationState): number {
  // Sensitive → hard-gate to boundary only
  if (state.sensitive) {
    return item.kind === 'boundary' ? 1.5 : 0;
  }

  let score = 0.2; // baseline for non-matching items (soft, not excluded)

  // Intent match → 1.0
  if (item.intent.includes(state.intent)) {
    score = 1.0;
  }

  // Special route + matching kind → 1.5
  if (state.specialRoute) {
    if (state.sensitive && item.kind === 'boundary') {
      score = 1.5;
    } else if (state.specialRoute === 'clarify' && item.kind === 'template') {
      score = 1.3;
    } else if (state.specialRoute === 'followup' && (item.kind === 'explanation' || item.kind === 'dialogue')) {
      score = 1.3;
    }
  }

  // Length mismatch → 0.3x multiplier (penalty, not exclusion)
  if (state.length === '1line' && item.length === 'medium') {
    score *= 0.3;
  } else if (state.length === 'medium' && item.length === '1line') {
    score *= 0.5;
  }

  return score;
}

/**
 * Brute-force vector search within a subset of embeddings.
 * Returns cosine similarity scores (embeddings are L2-normalized).
 */
function vectorSearch(
  queryVec: Float32Array,
  embeddings: Float32Array,
  dim: number,
  indices: number[]
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const idx of indices) {
    const offset = idx * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) {
      dot += queryVec[j] * embeddings[offset + j];
    }
    scores.set(idx, dot);
  }

  return scores;
}

/**
 * Retrieve candidates from a single index (style or knowledge).
 * Uses soft intent scoring instead of hard filtering.
 */
function retrieveFromIndex(
  query: string,
  queryVec: Float32Array | null,
  items: PackItem[],
  embeddings: Float32Array | null,
  dim: number,
  state: ConversationState,
  topK: number,
  excludeIds?: Set<string>,
): RawCandidate[] {
  if (items.length === 0) return [];

  // Build candidates for all items (soft scoring, no hard filter except sensitive)
  const validIndices: number[] = [];
  const intentScores: number[] = [];

  for (let i = 0; i < items.length; i++) {
    // Hard-exclude items used in recent turns
    if (excludeIds && excludeIds.has(items[i].id)) continue;

    const iScore = intentScore(items[i], state);
    // Only hard-exclude if sensitive and score is 0 (non-boundary)
    if (state.sensitive && iScore === 0) continue;

    validIndices.push(i);
    intentScores.push(iScore);
  }

  if (validIndices.length === 0) return [];

  // Vector scores (if available)
  let vectorScores = new Map<number, number>();
  if (queryVec && embeddings) {
    vectorScores = vectorSearch(queryVec, embeddings, dim, validIndices);
  }

  // Build candidates with all scores
  const candidates: RawCandidate[] = validIndices.map((origIdx, fi) => {
    return {
      item: items[origIdx],
      vectorScore: vectorScores.get(origIdx) ?? 0,
      lexicalScore: lexicalScore(query, items[origIdx].text),
      intentBonus: intentScores[fi],
    };
  });

  // Rough sort by combined score for top-K selection
  candidates.sort((a, b) => {
    const sa = a.vectorScore * 0.5 + a.lexicalScore * 0.2 + a.intentBonus * 0.3;
    const sb = b.vectorScore * 0.5 + b.lexicalScore * 0.2 + b.intentBonus * 0.3;
    return sb - sa;
  });

  return candidates.slice(0, topK);
}

/**
 * Main retrieval function: searches both style and knowledge indexes.
 * Accepts optional excludeIds for hard exclusion of recently-used items.
 */
export function retrieve(
  query: string,
  queryVec: Float32Array | null,
  packIndex: PackIndex,
  state: ConversationState,
  styleTopK: number = 10,
  knowledgeTopK: number = 5,
  excludeIds?: Set<string>,
): { styleCandidates: RawCandidate[]; knowledgeCandidates: RawCandidate[] } {
  const styleCandidates = retrieveFromIndex(
    query,
    queryVec,
    packIndex.styleItems,
    packIndex.styleEmbeddings,
    packIndex.dim,
    state,
    styleTopK,
    excludeIds,
  );

  const knowledgeCandidates = retrieveFromIndex(
    query,
    queryVec,
    packIndex.knowledgeItems,
    packIndex.knowledgeEmbeddings,
    packIndex.dim,
    state,
    knowledgeTopK,
    excludeIds,
  );

  return { styleCandidates, knowledgeCandidates };
}
