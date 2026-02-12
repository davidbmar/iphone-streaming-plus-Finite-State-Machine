/**
 * IndexedDB-backed cache for index artifacts.
 * On first load, artifacts are fetched via HTTP and stored in IDB.
 * On subsequent loads, artifacts are read directly from IDB (offline-capable).
 */

const DB_NAME = 'rag-artifact-cache';
const DB_VERSION = 1;
const STORE_NAME = 'artifacts';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFromIDB(db: IDBDatabase, key: string): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putToIDB(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface ArtifactSet {
  config: import('@shared/types').IndexConfig;
  metadata: import('@shared/types').ChunkMetadata[];
  embeddings: ArrayBuffer;   // contiguous Float32 buffer
  hnswIndex: ArrayBuffer;    // raw HNSW index bytes
}

/**
 * Load all artifacts, preferring IndexedDB cache.
 * Falls back to fetching from baseUrl.
 */
export async function loadArtifacts(
  baseUrl: string,
  onProgress?: (msg: string) => void
): Promise<ArtifactSet> {
  const db = await openDB();
  const cacheKey = `artifacts-v1`;

  // Check cache
  const cached = (await getFromIDB(db, cacheKey)) as ArtifactSet | undefined;
  if (cached) {
    onProgress?.('Loaded artifacts from IndexedDB cache');
    return cached;
  }

  onProgress?.('Fetching artifacts from server...');

  // Fetch all in parallel
  const [configResp, metaResp, embResp, idxResp] = await Promise.all([
    fetch(`${baseUrl}/config.json`),
    fetch(`${baseUrl}/metadata.json`),
    fetch(`${baseUrl}/embeddings.bin`),
    fetch(`${baseUrl}/hnsw.index`),
  ]);

  if (!configResp.ok || !metaResp.ok || !embResp.ok || !idxResp.ok) {
    throw new Error(
      `Failed to fetch artifacts. Ensure indexer has been run and artifacts are in public/artifacts/. ` +
      `Status: config=${configResp.status} meta=${metaResp.status} emb=${embResp.status} idx=${idxResp.status}`
    );
  }

  const artifacts: ArtifactSet = {
    config: await configResp.json(),
    metadata: await metaResp.json(),
    embeddings: await embResp.arrayBuffer(),
    hnswIndex: await idxResp.arrayBuffer(),
  };

  // Cache to IDB
  onProgress?.('Caching artifacts to IndexedDB...');
  await putToIDB(db, cacheKey, artifacts);

  onProgress?.('Artifacts ready');
  return artifacts;
}

/** Clear the IDB cache (useful for dev/refresh) */
export async function clearArtifactCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
