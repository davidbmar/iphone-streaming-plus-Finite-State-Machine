/**
 * Pack loader: fetches JSONL, parses items, builds dual indexes.
 * Also loads persona.json and playbook.jsonl for lane-aware pipeline.
 *
 * Style index: quips, templates, boundaries
 * Knowledge index: explanations, dialogues
 */
import type { PackItem, PackIndex, Persona, PlaybookEntry } from './types.js';

/** Parse JSONL string into typed array */
export function parseJSONL<T = PackItem>(raw: string): T[] {
  const items: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      console.warn('Skipping invalid JSONL line:', trimmed.slice(0, 80));
    }
  }
  return items;
}

/** Load pack from URL, build index structure */
export async function loadPack(url: string): Promise<PackIndex> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load pack: ${resp.status}`);
  const raw = await resp.text();
  return buildPackIndex(parseJSONL<PackItem>(raw));
}

/** Load persona.json from URL */
export async function loadPersona(url: string): Promise<Persona> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load persona: ${resp.status}`);
  return resp.json() as Promise<Persona>;
}

/** Load playbook.jsonl from URL */
export async function loadPlaybook(url: string): Promise<PlaybookEntry[]> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load playbook: ${resp.status}`);
  const raw = await resp.text();
  return parseJSONL<PlaybookEntry>(raw);
}

/** Build pack index from items array (also usable for inline data) */
export function buildPackIndex(items: PackItem[]): PackIndex {
  const styleKinds = new Set(['quip', 'template', 'boundary']);
  const knowledgeKinds = new Set(['explanation', 'dialogue']);

  const styleItems: PackItem[] = [];
  const knowledgeItems: PackItem[] = [];
  const byId = new Map<string, PackItem>();

  for (const item of items) {
    byId.set(item.id, item);
    if (styleKinds.has(item.kind)) {
      styleItems.push(item);
    }
    if (knowledgeKinds.has(item.kind)) {
      knowledgeItems.push(item);
    }
  }

  return {
    styleItems,
    styleEmbeddings: null,
    knowledgeItems,
    knowledgeEmbeddings: null,
    byId,
    dim: 384,
    vectorReady: false,
  };
}

/**
 * Attach precomputed embeddings to a pack index.
 * Called after the worker returns embedBatch results.
 */
export function attachEmbeddings(
  index: PackIndex,
  styleEmbeddings: Float32Array,
  knowledgeEmbeddings: Float32Array,
  dim: number,
): void {
  index.styleEmbeddings = styleEmbeddings;
  index.knowledgeEmbeddings = knowledgeEmbeddings;
  index.dim = dim;
  index.vectorReady = true;
}
