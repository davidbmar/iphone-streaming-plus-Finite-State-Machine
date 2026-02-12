/**
 * Type definitions for the Character Conversation Pack system.
 */

// ── Pack Item Types ──────────────────────────────────────────────────

export type PackKind = 'quip' | 'template' | 'explanation' | 'dialogue' | 'boundary';
export type Intent = 'question' | 'debug' | 'brainstorm' | 'vent' | 'decide' | 'smalltalk';
export type Tone = 'noir-dry' | 'warm' | 'blunt' | 'calm';
export type LengthBudget = '1line' | 'short' | 'medium';
export type Usage = 'verbatim_ok' | 'paraphrase' | 'structure_only';

export interface PackItem {
  id: string;
  kind: PackKind;
  intent: Intent[];
  tone: Tone[];
  length: LengthBudget;
  domain: string[];
  usage: Usage;
  text: string;
}

// ── Lane Types ───────────────────────────────────────────────────────

export type Lane = 'persona' | 'playbook' | 'knowledge' | 'lore';

export interface Persona {
  name: string;
  elevator_pitch: string;
  core_traits: string[];
  tone_sliders: { playful: number; technical: number; mysterious: number; warm: number };
  rules: string[];
  forbidden_behaviors: string[];
}

export interface PlaybookEntry {
  id: string;
  lane: 'playbook';
  intent: string;
  goal: string;
  response_shape: string[];
  example_lines: string[];
  tone_tags: string[];
}

export interface KnowledgeNugget {
  id: string;
  lane: 'knowledge';
  topic: string;
  summary: string;
  key_points: string[];
  tone_variant: string;
  follow_up_hook: string;
}

export interface LoreLine {
  id: string;
  lane: 'lore';
  category: string;
  line: string;
  tone_tags: string[];
}

// ── Conversation History ─────────────────────────────────────────────

export interface ConversationTurn {
  userText: string;
  irisText: string;
  intent: string;
  timestamp: number;
  usedItemIds: string[];
}

// ── State Gate ───────────────────────────────────────────────────────

export type SpecialRoute = 'greeting' | 'identity' | 'followup' | 'clarify' | 'echo' | 'meta' | null;

export interface ConversationState {
  intent: Intent;
  tone: Tone;
  length: LengthBudget;
  sensitive: boolean;
  keywords: string[];
  specialRoute: SpecialRoute;
  selectedLanes: Lane[];
}

// ── Retrieval ────────────────────────────────────────────────────────

export interface RetrievalCandidate {
  item: PackItem;
  vectorScore: number;
  lexicalScore: number;
  metadataBonus: number;
  repeatPenalty: number;
  finalScore: number;
}

// ── Compose ──────────────────────────────────────────────────────────

export interface ComposeResult {
  replyText: string;
  debug: ComposeDebug;
}

export interface ComposeDebug {
  state: ConversationState;
  candidates: CandidateDebug[];
  chosenOpener: string | null;
  chosenSubstance: string | null;
  latency: LatencyBreakdown;
  llmUsed?: boolean;
  /** Context snippets sent to the LLM (RAG-retrieved text) */
  contextSnippets?: string[];
}

export interface CandidateDebug {
  id: string;
  kind: PackKind;
  finalScore: number;
  vectorScore: number;
  lexicalScore: number;
}

export interface LatencyBreakdown {
  stateGateMs: number;
  retrieveMs: number;
  rerankMs: number;
  composeMs: number;
  totalMs: number;
}

// ── Pack Index ───────────────────────────────────────────────────────

export interface PackIndex {
  /** Style index: quips, templates, boundaries (used every turn) */
  styleItems: PackItem[];
  styleEmbeddings: Float32Array | null;
  /** Knowledge index: explanations, dialogues */
  knowledgeItems: PackItem[];
  knowledgeEmbeddings: Float32Array | null;
  /** All items by id for fast lookup */
  byId: Map<string, PackItem>;
  /** Dimension of embeddings (384 for MiniLM) */
  dim: number;
  /** Whether vector search is available */
  vectorReady: boolean;
}

// ── Worker Protocol Extensions ───────────────────────────────────────

export type PackWorkerRequest =
  | { type: 'embedBatch'; texts: string[]; requestId: string };

export type PackWorkerResponse =
  | { type: 'embedBatchResult'; embeddings: Float32Array; dim: number; requestId: string };
