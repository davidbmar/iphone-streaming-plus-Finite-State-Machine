/**
 * Main conversation pipeline orchestrator.
 * Multi-lane RAG: persona → playbook → knowledge → lore.
 * Ties together: stateGate -> retrieve -> rerank -> compose (pack-only or LLM-enhanced)
 */
import type { PackIndex, ComposeResult, Persona, PlaybookEntry } from './types.js';
import type { WorkerResponse } from '@shared/types';
import { classifyState } from './stateGate.js';
import { retrieve } from './retrieve.js';
import { rerank } from './rerank.js';
import { compose, buildLLMContext, composeLLMResult } from './compose.js';
import { RecentMemory } from './memory.js';
import { loadPack, loadPersona, loadPlaybook, parseJSONL, attachEmbeddings } from './packIndex.js';
import { isModelLoaded, generateReply } from '../llm.js';

export class ConversationPipeline {
  private packIndex: PackIndex | null = null;
  private memory = new RecentMemory(20);
  private worker: Worker | null = null;
  private packReady = false;
  private vectorReady = false;
  private pendingCallbacks = new Map<string, (msg: WorkerResponse) => void>();
  private requestCounter = 0;
  private _useLLM = true; // Use LLM by default when available

  // Lane data (loaded at init)
  private persona: Persona | null = null;
  private playbook: PlaybookEntry[] = [];

  /**
   * Initialize the pipeline: load pack + persona + playbook.
   * Persona and playbook URLs are derived from the pack URL's directory.
   */
  async init(packUrl: string, worker?: Worker): Promise<void> {
    // Derive base path from pack URL
    const baseDir = packUrl.substring(0, packUrl.lastIndexOf('/') + 1);

    // Load all resources in parallel
    const [packIndex, persona, playbook] = await Promise.all([
      loadPack(packUrl),
      loadPersona(`${baseDir}persona.json`).catch(e => {
        console.warn('Persona load failed, using fallback:', e);
        return null;
      }),
      loadPlaybook(`${baseDir}playbook.jsonl`).catch(e => {
        console.warn('Playbook load failed, continuing without:', e);
        return [] as PlaybookEntry[];
      }),
    ]);

    this.packIndex = packIndex;
    this.persona = persona;
    this.playbook = playbook;

    // Load meta-knowledge (session docs, ADRs) if available
    try {
      const metaResp = await fetch(`${baseDir}meta_knowledge.jsonl`);
      if (metaResp.ok) {
        const metaRaw = await metaResp.text();
        const metaItems = parseJSONL(metaRaw);
        for (const item of metaItems) {
          packIndex.knowledgeItems.push(item);
          packIndex.byId.set(item.id, item);
        }
        console.log(`Loaded ${metaItems.length} meta-knowledge items`);
      }
    } catch {
      // meta_knowledge.jsonl is optional
    }

    this.packReady = true;

    if (worker) this.worker = worker;
  }

  /** Request pack embeddings from the worker (call after worker is ready) */
  async buildVectorIndex(): Promise<void> {
    if (!this.packIndex || !this.worker) return;

    const styleTexts = this.packIndex.styleItems.map(i => i.text);
    const knowledgeTexts = this.packIndex.knowledgeItems.map(i => i.text);

    try {
      const styleResult = await this.workerRequest({
        type: 'embedBatch',
        texts: styleTexts,
        requestId: `pack-style-${++this.requestCounter}`,
      });

      if (styleResult.type !== 'embedBatchResult') return;

      const knowledgeResult = await this.workerRequest({
        type: 'embedBatch',
        texts: knowledgeTexts,
        requestId: `pack-knowledge-${++this.requestCounter}`,
      });

      if (knowledgeResult.type !== 'embedBatchResult') return;

      attachEmbeddings(
        this.packIndex,
        new Float32Array(styleResult.embeddings),
        new Float32Array(knowledgeResult.embeddings),
        styleResult.dim,
      );

      this.vectorReady = true;
    } catch (e) {
      console.warn('Vector index build failed, continuing with lexical-only:', e);
    }
  }

  /**
   * Process a user turn through the full multi-lane pipeline.
   * If an LLM is loaded and useLLM is enabled, uses LLM for reply generation.
   * Otherwise falls back to pack-only compose.
   *
   * @param onToken — streaming callback for LLM tokens (delta, fullText)
   */
  async processUserTurn(
    userText: string,
    onToken?: (delta: string, fullText: string) => void,
    options?: { signal?: AbortSignal },
  ): Promise<ComposeResult | null> {
    if (!this.packIndex || !this.packReady) return null;

    // Step A: Retrieval Controller (state gate + special routes + lane selection)
    const t0 = performance.now();
    const lastTurn = this.memory.getLastTurn();
    const state = classifyState(userText, lastTurn);
    const stateGateMs = performance.now() - t0;

    // ── Persona lane: direct inject, no retrieval needed ──
    if (state.specialRoute === 'identity' && this.persona) {
      const baseLat = {
        stateGateMs: Math.round(stateGateMs * 100) / 100,
        retrieveMs: 0,
        rerankMs: 0,
      };
      const result = compose(
        userText, state, [], [], baseLat,
        this.persona, this.playbook, lastTurn,
      );
      // Record turn in conversation history
      this.memory.recordTurn(userText, result.replyText, state.intent, result.usedItemIds);
      this.memory.recordMany(result.usedItemIds);
      return result;
    }

    // ── Greeting/Echo/Clarify lanes: playbook only, minimal retrieval ──
    if ((state.specialRoute === 'greeting' || state.specialRoute === 'echo' || state.specialRoute === 'clarify') && this.playbook.length > 0) {
      const baseLat = {
        stateGateMs: Math.round(stateGateMs * 100) / 100,
        retrieveMs: 0,
        rerankMs: 0,
      };
      const result = compose(
        userText, state, [], [], baseLat,
        this.persona, this.playbook, lastTurn,
      );
      this.memory.recordTurn(userText, result.replyText, state.intent, result.usedItemIds);
      this.memory.recordMany(result.usedItemIds);
      return result;
    }

    // Step B: Get query embedding if vector search is available
    let queryVec: Float32Array | null = null;
    if (this.vectorReady && this.worker) {
      try {
        const embedResult = await this.workerRequest({
          type: 'embedQuery',
          text: userText,
          requestId: `query-${++this.requestCounter}`,
        });
        if (embedResult.type === 'embedQueryResult') {
          queryVec = new Float32Array(embedResult.embedding);
        }
      } catch { /* fall back to lexical */ }
    }

    // Step C: Retrieve (with hard exclusion of items from last 3 turns)
    const t1 = performance.now();
    const excludeIds = this.memory.getRecentTurnItemIds(3);
    const { styleCandidates, knowledgeCandidates } = retrieve(
      userText, queryVec, this.packIndex, state,
      10, 5, excludeIds,
    );
    const retrieveMs = performance.now() - t1;

    // Step D: Rerank
    const t2 = performance.now();
    const rankedStyle = rerank(styleCandidates, state, this.memory);
    const rankedKnowledge = rerank(knowledgeCandidates, state, this.memory);
    const rerankMs = performance.now() - t2;

    const baseLat = {
      stateGateMs: Math.round(stateGateMs * 100) / 100,
      retrieveMs: Math.round(retrieveMs * 100) / 100,
      rerankMs: Math.round(rerankMs * 100) / 100,
    };

    // Step E: Compose — LLM or pack-only
    let result: ComposeResult & { usedItemIds?: string[] };

    if (this._useLLM && isModelLoaded()) {
      result = await this.composeLLM(userText, state, rankedStyle, rankedKnowledge, baseLat, onToken, options);
    } else {
      result = compose(
        userText, state, rankedStyle, rankedKnowledge, baseLat,
        this.persona, this.playbook, lastTurn,
      );
    }

    // Step F: Record turn in conversation history
    const usedIds = (result as any).usedItemIds ?? [];
    this.memory.recordMany(usedIds);
    this.memory.recordTurn(userText, result.replyText, state.intent, usedIds);

    return result;
  }

  /** LLM-enhanced compose: feed retrieved context + persona + history to local LLM */
  private async composeLLM(
    userText: string,
    state: any,
    rankedStyle: any[],
    rankedKnowledge: any[],
    baseLat: any,
    onToken?: (delta: string, fullText: string) => void,
    options?: { signal?: AbortSignal },
  ): Promise<ComposeResult & { usedItemIds: string[] }> {
    const t0 = performance.now();

    const { snippets, opener, substance, usedItemIds } = buildLLMContext(
      state, rankedStyle, rankedKnowledge,
      this.persona, this.playbook, this.memory.getHistory(),
    );

    try {
      const replyText = await generateReply(userText, snippets, onToken, {
        signal: options?.signal,
      });
      const composeMs = performance.now() - t0;

      return {
        ...composeLLMResult(
          replyText, state, rankedStyle, rankedKnowledge,
          opener, substance, baseLat, composeMs, snippets,
        ),
        usedItemIds,
      };
    } catch (e) {
      console.warn('LLM generation failed, falling back to pack-only:', e);
      const lastTurn = this.memory.getLastTurn();
      return compose(
        userText, state, rankedStyle, rankedKnowledge, baseLat,
        this.persona, this.playbook, lastTurn,
      );
    }
  }

  /** Send a request to the worker and wait for matching response */
  private workerRequest(msg: any): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error('No worker'));

      const requestId = msg.requestId;
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(requestId);
        reject(new Error(`Worker request ${requestId} timed out`));
      }, 30000);

      this.pendingCallbacks.set(requestId, (response) => {
        clearTimeout(timeout);
        this.pendingCallbacks.delete(requestId);
        resolve(response);
      });

      this.worker.postMessage(msg);
    });
  }

  /** Route pack-related worker responses */
  handleWorkerMessage(msg: WorkerResponse): boolean {
    const requestId = (msg as any).requestId;
    if (requestId && this.pendingCallbacks.has(requestId)) {
      this.pendingCallbacks.get(requestId)!(msg);
      return true;
    }
    return false;
  }

  get isReady(): boolean { return this.packReady; }
  get hasVectorSearch(): boolean { return this.vectorReady; }
  get useLLM(): boolean { return this._useLLM; }
  set useLLM(v: boolean) { this._useLLM = v; }

  getRecentlyUsed(): string[] { return this.memory.getRecent(); }
  clearMemory(): void { this.memory.clear(); }
}
