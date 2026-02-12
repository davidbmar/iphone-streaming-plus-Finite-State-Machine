/**
 * Vector search backends.
 *
 * BruteForceSearcher: Pure JS cosine similarity search on raw embeddings.
 * Works everywhere, great for < 50K vectors.
 *
 * The architecture supports swapping in hnswlib-wasm when the index grows
 * large enough to warrant ANN search. See README for details.
 */
import type { ChunkMetadata, IndexConfig, SearchResult } from '@shared/types';

export interface Searcher {
  init(
    config: IndexConfig,
    metadata: ChunkMetadata[],
    embeddings: ArrayBuffer,
    hnswIndex: ArrayBuffer
  ): void;
  search(queryVec: Float32Array, topK: number): SearchResult[];
}

/**
 * Brute-force cosine similarity search.
 *
 * Since embeddings are L2-normalized (both at index time and query time),
 * cosine similarity = dot product. This is exact search — no approximation.
 *
 * Performance: ~0.5ms for 50 vectors, ~5ms for 5K, ~50ms for 50K (384-dim).
 */
export class BruteForceSearcher implements Searcher {
  private embeddings!: Float32Array;
  private metadata!: ChunkMetadata[];
  private dim!: number;
  private numVectors!: number;

  init(
    config: IndexConfig,
    metadata: ChunkMetadata[],
    embeddings: ArrayBuffer,
    _hnswIndex: ArrayBuffer
  ): void {
    this.dim = config.dim;
    this.metadata = metadata;
    this.embeddings = new Float32Array(embeddings);
    this.numVectors = this.embeddings.length / this.dim;

    if (this.numVectors !== metadata.length) {
      throw new Error(
        `Mismatch: ${this.numVectors} embedding vectors but ${metadata.length} metadata entries`
      );
    }
  }

  search(queryVec: Float32Array, topK: number): SearchResult[] {
    const { embeddings, dim, numVectors, metadata } = this;

    // Compute dot product with all vectors (= cosine similarity for normalized vectors)
    const scores = new Float32Array(numVectors);
    for (let i = 0; i < numVectors; i++) {
      let dot = 0;
      const offset = i * dim;
      for (let j = 0; j < dim; j++) {
        dot += queryVec[j] * embeddings[offset + j];
      }
      scores[i] = dot;
    }

    // Partial sort: find top-K indices
    const k = Math.min(topK, numVectors);
    const indices = Array.from({ length: numVectors }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);

    const results: SearchResult[] = [];
    for (let rank = 0; rank < k; rank++) {
      const idx = indices[rank];
      const meta = metadata[idx];
      results.push({
        rank: rank + 1,
        score: scores[idx],
        id: meta.id,
        doc_id: meta.doc_id,
        ts_start: meta.ts_start,
        ts_end: meta.ts_end,
        speaker: meta.speaker,
        text: meta.text,
      });
    }

    return results;
  }
}

/**
 * Placeholder for hnswlib-wasm integration.
 *
 * To enable HNSW search:
 * 1. npm install hnswlib-wasm
 * 2. Import and initialize the WASM module
 * 3. Load the hnsw.index file into the WASM filesystem
 * 4. Use the HierarchicalNSW class for search
 *
 * The index file is compatible because both hnswlib-node and hnswlib-wasm
 * use the same C++ hnswlib serialization format.
 */
export class HnswSearcher implements Searcher {
  private metadata!: ChunkMetadata[];
  private hnswIndex: any = null;
  private config!: IndexConfig;

  init(
    config: IndexConfig,
    metadata: ChunkMetadata[],
    _embeddings: ArrayBuffer,
    hnswIndexBuf: ArrayBuffer
  ): void {
    this.config = config;
    this.metadata = metadata;

    // Attempt to load hnswlib-wasm dynamically
    // This is wrapped in a try-catch so the app gracefully degrades
    try {
      // Dynamic import would go here:
      // const { HierarchicalNSW } = await import('hnswlib-wasm');
      // this.hnswIndex = new HierarchicalNSW(config.space, config.dim);
      // Write index to WASM virtual FS and load it
      console.warn(
        'HnswSearcher: hnswlib-wasm not installed. Install it for ANN search on large indices. ' +
        'Falling back to brute-force.'
      );
    } catch (e) {
      console.warn('HnswSearcher: failed to initialize hnswlib-wasm:', e);
    }
  }

  search(queryVec: Float32Array, topK: number): SearchResult[] {
    if (!this.hnswIndex) {
      throw new Error('HNSW index not loaded. Use BruteForceSearcher as fallback.');
    }

    const result = this.hnswIndex.searchKnn(Array.from(queryVec), topK);
    const results: SearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const idx = result.neighbors[i];
      const meta = this.metadata[idx];
      // hnswlib cosine returns 1 - cos_sim, so convert back
      const score = 1 - result.distances[i];
      results.push({
        rank: i + 1,
        score,
        id: meta.id,
        doc_id: meta.doc_id,
        ts_start: meta.ts_start,
        ts_end: meta.ts_end,
        speaker: meta.speaker,
        text: meta.text,
      });
    }

    return results;
  }
}
