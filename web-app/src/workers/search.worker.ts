/**
 * Web Worker for embedding + search.
 * Keeps the main thread completely free during heavy computation.
 *
 * Flow:
 *   1. Main sends 'init' → worker loads artifacts, model, and search index
 *   2. Main sends 'search' → worker computes embedding → runs ANN search → returns results
 */
import type { WorkerRequest, WorkerResponse, IndexConfig, ChunkMetadata } from '@shared/types';
import { initEmbedder, embedQuery, getDevice } from '../lib/embedder.js';
import { BruteForceSearcher, type Searcher } from '../lib/searcher.js';

let searcher: Searcher | null = null;

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

async function handleInit(artifactsUrl: string) {
  try {
    post({ type: 'progress', message: 'Fetching artifacts...' });

    // Fetch artifacts (the worker fetches directly; IDB caching is on main thread)
    const [configResp, metaResp, embResp, idxResp] = await Promise.all([
      fetch(`${artifactsUrl}/config.json`),
      fetch(`${artifactsUrl}/metadata.json`),
      fetch(`${artifactsUrl}/embeddings.bin`),
      fetch(`${artifactsUrl}/hnsw.index`),
    ]);

    if (!configResp.ok || !metaResp.ok || !embResp.ok || !idxResp.ok) {
      throw new Error(
        `Failed to fetch artifacts. Status: config=${configResp.status} meta=${metaResp.status} emb=${embResp.status} idx=${idxResp.status}`
      );
    }

    const config: IndexConfig = await configResp.json();
    const metadata: ChunkMetadata[] = await metaResp.json();
    const embeddings = await embResp.arrayBuffer();
    const hnswIndex = await idxResp.arrayBuffer();

    post({ type: 'progress', message: `Loaded ${metadata.length} chunks (dim=${config.dim})` });

    // Init searcher (brute-force; swap to HnswSearcher when hnswlib-wasm is available)
    searcher = new BruteForceSearcher();
    searcher.init(config, metadata, embeddings, hnswIndex);

    post({ type: 'progress', message: 'Initializing embedding model...' });

    // Init embedder
    const device = await initEmbedder(config.model, (msg) => {
      post({ type: 'progress', message: msg });
    });

    post({ type: 'progress', message: `Ready — device: ${device}, ${metadata.length} chunks indexed` });
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'error', message: `Init failed: ${(err as Error).message}` });
  }
}

async function handleSearch(query: string, topK: number, requestId: string) {
  if (!searcher) {
    post({ type: 'error', message: 'Worker not initialized', requestId });
    return;
  }

  try {
    // 1. Embed query
    const t0 = performance.now();
    const queryVec = await embedQuery(query);
    const embedMs = performance.now() - t0;

    // 2. Search
    const t1 = performance.now();
    const results = searcher.search(queryVec, topK);
    const searchMs = performance.now() - t1;

    post({
      type: 'results',
      results,
      requestId,
      latency: { embedMs: Math.round(embedMs), searchMs: Math.round(searchMs * 100) / 100 },
    });
  } catch (err) {
    post({ type: 'error', message: `Search failed: ${(err as Error).message}`, requestId });
  }
}

async function handleEmbedBatch(texts: string[], requestId: string) {
  try {
    const dim = 384;
    const buffer = new Float32Array(texts.length * dim);

    for (let i = 0; i < texts.length; i++) {
      const vec = await embedQuery(texts[i]);
      buffer.set(vec, i * dim);
    }

    post({
      type: 'embedBatchResult',
      embeddings: buffer.buffer,
      dim,
      count: texts.length,
      requestId,
    } as WorkerResponse);
  } catch (err) {
    post({ type: 'error', message: `Embed batch failed: ${(err as Error).message}`, requestId });
  }
}

async function handleEmbedQuery(text: string, requestId: string) {
  try {
    const vec = await embedQuery(text);
    post({
      type: 'embedQueryResult',
      embedding: vec.buffer,
      dim: vec.length,
      requestId,
    } as WorkerResponse);
  } catch (err) {
    post({ type: 'error', message: `Embed query failed: ${(err as Error).message}`, requestId });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      handleInit(msg.artifactsUrl);
      break;
    case 'search':
      handleSearch(msg.query, msg.topK, msg.requestId);
      break;
    case 'embedBatch':
      handleEmbedBatch(msg.texts, msg.requestId);
      break;
    case 'embedQuery':
      handleEmbedQuery(msg.text, msg.requestId);
      break;
  }
};
