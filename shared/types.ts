/** A single transcript chunk as stored in JSONL input */
export interface TranscriptChunk {
  id: string;
  text: string;
  doc_id: string;
  ts_start: number;
  ts_end: number;
  speaker: string;
}

/** Metadata aligned 1:1 with embedding rows */
export interface ChunkMetadata {
  id: string;
  doc_id: string;
  ts_start: number;
  ts_end: number;
  speaker: string;
  text: string;        // keep the text for display
  charCount: number;
}

/** Index build configuration persisted alongside artifacts */
export interface IndexConfig {
  model: string;
  dim: number;
  space: 'cosine' | 'l2' | 'ip';
  efConstruction: number;
  M: number;
  numElements: number;
  maxChars: number;
  createdAt: string;
}

/** A single search result returned to the UI */
export interface SearchResult {
  rank: number;
  score: number;         // cosine similarity (higher = better)
  id: string;
  doc_id: string;
  ts_start: number;
  ts_end: number;
  speaker: string;
  text: string;
}

/** Messages from main thread → search worker */
export type WorkerRequest =
  | { type: 'init'; artifactsUrl: string }
  | { type: 'search'; query: string; topK: number; requestId: string }
  | { type: 'embedBatch'; texts: string[]; requestId: string }
  | { type: 'embedQuery'; text: string; requestId: string };

/** Messages from search worker → main thread */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'results'; results: SearchResult[]; requestId: string; latency: { embedMs: number; searchMs: number } }
  | { type: 'error'; message: string; requestId?: string }
  | { type: 'progress'; message: string }
  | { type: 'embedBatchResult'; embeddings: ArrayBuffer; dim: number; count: number; requestId: string }
  | { type: 'embedQueryResult'; embedding: ArrayBuffer; dim: number; requestId: string };
