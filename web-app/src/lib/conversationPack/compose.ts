/**
 * Reply composer: lane-aware composition with persona, playbook, knowledge, and lore.
 * Supports two modes:
 *   - Pack-only (fast, <2ms): uses lane routing for structured replies
 *   - LLM-enhanced: feeds retrieved context + persona to local LLM
 */
import type {
  ConversationState,
  RetrievalCandidate,
  ComposeResult,
  ComposeDebug,
  CandidateDebug,
  LatencyBreakdown,
  Persona,
  PlaybookEntry,
  ConversationTurn,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Light noun injection: replace placeholder patterns with user nouns. */
function injectNouns(text: string, userNouns: string[]): string {
  let result = text;
  const placeholder = /\{topic\}|\[topic\]/gi;
  if (placeholder.test(result) && userNouns.length > 0) {
    result = result.replace(placeholder, userNouns[0]);
  }
  return result;
}

/** Extract likely nouns from user text. */
function extractNouns(userText: string): string[] {
  const common = new Set([
    'what', 'how', 'why', 'when', 'where', 'who', 'which', 'that', 'this',
    'about', 'with', 'from', 'they', 'them', 'have', 'been', 'were', 'will',
    'your', 'their', 'some', 'just', 'like', 'know', 'think', 'want', 'need',
    'help', 'mean', 'could', 'would', 'should', 'does', 'dont', 'cant',
  ]);

  return userText
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !common.has(w));
}

function toCandidateDebug(c: RetrievalCandidate): CandidateDebug {
  return {
    id: c.item.id,
    kind: c.item.kind,
    finalScore: Math.round(c.finalScore * 1000) / 1000,
    vectorScore: Math.round(c.vectorScore * 1000) / 1000,
    lexicalScore: Math.round(c.lexicalScore * 1000) / 1000,
  };
}

/** Pick a random example line from a playbook entry */
function pickPlaybookLine(entry: PlaybookEntry): string {
  const lines = entry.example_lines;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ── Persona compose (identity route) ─────────────────────────────────

function composePersonaReply(persona: Persona): string {
  // Short, in-character self-introduction
  return `Name's ${persona.name}. ${persona.elevator_pitch.split('.').slice(0, 2).join('.')}. What do you need?`;
}

// ── Playbook-aware compose ───────────────────────────────────────────

function findPlaybookEntry(
  playbook: PlaybookEntry[],
  state: ConversationState,
): PlaybookEntry | null {
  const route = state.specialRoute;

  // Map special routes to playbook intents
  const intentMap: Record<string, string> = {
    greeting: 'greeting',
    identity: 'ask_identity',
    followup: 'ask_for_more',
    clarify: 'confusion',
    echo: 'repetition_loop_breaker',
  };

  // Map state intents to playbook intents
  const stateIntentMap: Record<string, string> = {
    smalltalk: 'small_talk',
    vent: 'user_pushback',
  };

  // Try special route first
  if (route && intentMap[route]) {
    const match = playbook.find(p => p.intent === intentMap[route]);
    if (match) return match;
  }

  // Try greeting for short smalltalk
  if (state.intent === 'smalltalk' && state.length === '1line') {
    const greeting = playbook.find(p => p.intent === 'greeting');
    if (greeting) return greeting;
  }

  // Try state intent mapping
  const mappedIntent = stateIntentMap[state.intent];
  if (mappedIntent) {
    const match = playbook.find(p => p.intent === mappedIntent);
    if (match) return match;
  }

  return null;
}

// ── Pack-only compose (fast path) ────────────────────────────────────

export function compose(
  userText: string,
  state: ConversationState,
  styleCandidates: RetrievalCandidate[],
  knowledgeCandidates: RetrievalCandidate[],
  latency: Omit<LatencyBreakdown, 'composeMs' | 'totalMs'>,
  persona?: Persona | null,
  playbook?: PlaybookEntry[],
  lastTurn?: ConversationTurn | null,
): ComposeResult & { usedItemIds: string[] } {
  const t0 = performance.now();
  const userNouns = extractNouns(userText);

  // ── Persona lane: direct inject for identity route ──
  if (state.specialRoute === 'identity' && persona) {
    const replyText = composePersonaReply(persona);
    const composeMs = performance.now() - t0;
    return {
      ...buildResult(replyText, state, styleCandidates, knowledgeCandidates, null, null, latency, composeMs, false),
      usedItemIds: [],
    };
  }

  // ── Playbook match: use response shape + example lines ──
  const pbEntry = playbook ? findPlaybookEntry(playbook, state) : null;

  // ── Greeting route: use playbook directly ──
  if (state.specialRoute === 'greeting' && pbEntry) {
    const replyText = pickPlaybookLine(pbEntry);
    const composeMs = performance.now() - t0;
    return {
      ...buildResult(replyText, state, styleCandidates, knowledgeCandidates, null, null, latency, composeMs, false),
      usedItemIds: [],
    };
  }

  // ── Echo route: use playbook directly ──
  if (state.specialRoute === 'echo' && pbEntry) {
    const replyText = pickPlaybookLine(pbEntry);
    const composeMs = performance.now() - t0;
    return {
      ...buildResult(replyText, state, styleCandidates, knowledgeCandidates, null, null, latency, composeMs, false),
      usedItemIds: [],
    };
  }

  // ── Clarify route: use playbook, optionally reference previous topic ──
  if (state.specialRoute === 'clarify' && pbEntry) {
    const replyText = pickPlaybookLine(pbEntry);
    const composeMs = performance.now() - t0;
    return {
      ...buildResult(replyText, state, styleCandidates, knowledgeCandidates, null, null, latency, composeMs, false),
      usedItemIds: [],
    };
  }

  // ── Standard compose: opener + substance ──

  // Select opener (quip/boundary from style, or playbook line)
  let opener: RetrievalCandidate | null = null;
  for (const c of styleCandidates) {
    if (c.item.kind === 'boundary' && state.sensitive) { opener = c; break; }
    if (c.item.kind === 'quip' && !opener) { opener = c; }
  }
  if (!opener && styleCandidates.length > 0) opener = styleCandidates[0];

  // Select substance (explanation/template from knowledge or style)
  // NEVER use structure_only items verbatim (dialogues contain raw USER:/IRIS: transcripts)
  // Respect length budget: short budget → prefer short items, skip medium
  const lengthOk = (item: { length: string }) =>
    state.length === 'medium' || item.length !== 'medium';

  let substance: RetrievalCandidate | null = null;
  if (state.length !== '1line' || state.sensitive) {
    // From knowledge: skip structure_only (dialogue) items and length mismatches
    for (const c of knowledgeCandidates) {
      if (c.item.usage !== 'structure_only' && lengthOk(c.item)) { substance = c; break; }
    }
    // Relax length constraint if nothing found
    if (!substance) {
      for (const c of knowledgeCandidates) {
        if (c.item.usage !== 'structure_only') { substance = c; break; }
      }
    }
    // Fallback to style templates/explanations
    if (!substance) {
      for (const c of styleCandidates) {
        if ((c.item.kind === 'template' || c.item.kind === 'explanation')
            && c.item.usage !== 'structure_only'
            && c !== opener) {
          substance = c; break;
        }
      }
    }
  }

  // Build reply text
  let replyText = '';

  if (state.sensitive && opener?.item.kind === 'boundary') {
    replyText = injectNouns(opener.item.text, userNouns);
  } else if (state.specialRoute === 'followup' && pbEntry && substance) {
    // Followup: playbook opener + substance from knowledge
    replyText = `${pickPlaybookLine(pbEntry)} ${injectNouns(substance.item.text, userNouns)}`;
  } else if (opener && substance) {
    replyText = `${injectNouns(opener.item.text, userNouns)} ${injectNouns(substance.item.text, userNouns)}`;
  } else if (pbEntry && state.length === '1line') {
    // Use playbook line for short responses when no good opener found
    replyText = pickPlaybookLine(pbEntry);
  } else if (opener) {
    replyText = injectNouns(opener.item.text, userNouns);
  } else if (pbEntry) {
    // Fallback to playbook before hardcoded string
    replyText = pickPlaybookLine(pbEntry);
  } else {
    replyText = "Signal's noisy right now. Run that by me again?";
  }

  // Track used item ids (returned to pipeline for memory recording)
  const usedItemIds: string[] = [];
  if (opener) usedItemIds.push(opener.item.id);
  if (substance) usedItemIds.push(substance.item.id);

  const composeMs = performance.now() - t0;

  return {
    ...buildResult(replyText, state, styleCandidates, knowledgeCandidates, opener, substance, latency, composeMs, false),
    usedItemIds,
  };
}

// ── LLM-enhanced compose context builder ─────────────────────────────

/**
 * Build context snippets for the LLM from retrieved candidates + persona.
 * Returns the top snippets as strings the LLM can reference.
 */
export function buildLLMContext(
  state: ConversationState,
  styleCandidates: RetrievalCandidate[],
  knowledgeCandidates: RetrievalCandidate[],
  persona?: Persona | null,
  playbook?: PlaybookEntry[],
  history?: ConversationTurn[],
): { snippets: string[]; opener: RetrievalCandidate | null; substance: RetrievalCandidate | null; usedItemIds: string[] } {
  const snippets: string[] = [];

  // Inject persona as system context
  if (persona) {
    snippets.push(`[persona] ${persona.name}: ${persona.elevator_pitch}`);
  }

  // Inject playbook entry if matched
  if (playbook) {
    const pbEntry = findPlaybookEntry(playbook, state);
    if (pbEntry) {
      snippets.push(`[playbook/${pbEntry.intent}] Goal: ${pbEntry.goal}. Shape: ${pbEntry.response_shape.join(' → ')}`);
    }
  }

  // Inject conversation history for context
  if (history && history.length > 0) {
    const recent = history.slice(-3);
    const historyStr = recent.map(t => `User: ${t.userText}\nIris: ${t.irisText}`).join('\n');
    snippets.push(`[history]\n${historyStr}`);
  }

  // Select opener and substance same as pack-only
  let opener: RetrievalCandidate | null = null;
  for (const c of styleCandidates) {
    if (c.item.kind === 'boundary' && state.sensitive) { opener = c; break; }
    if (c.item.kind === 'quip' && !opener) { opener = c; }
  }
  if (!opener && styleCandidates.length > 0) opener = styleCandidates[0];

  let substance: RetrievalCandidate | null = null;
  if (state.length !== '1line' || state.sensitive) {
    // Skip structure_only (dialogue) items in LLM context too
    for (const c of knowledgeCandidates) {
      if (c.item.usage !== 'structure_only') { substance = c; break; }
    }
    if (!substance) {
      for (const c of styleCandidates) {
        if ((c.item.kind === 'template' || c.item.kind === 'explanation')
            && c.item.usage !== 'structure_only'
            && c !== opener) {
          substance = c; break;
        }
      }
    }
  }

  // Track used ids
  const usedItemIds: string[] = [];
  if (opener) {
    snippets.push(`[${opener.item.kind}] ${opener.item.text}`);
    usedItemIds.push(opener.item.id);
  }
  if (substance) {
    snippets.push(`[${substance.item.kind}] ${substance.item.text}`);
    usedItemIds.push(substance.item.id);
  }

  // Add a few more top candidates for richer context
  const seen = new Set(usedItemIds);
  for (const c of [...styleCandidates, ...knowledgeCandidates]) {
    if (snippets.length >= 6) break;
    if (!seen.has(c.item.id)) {
      snippets.push(`[${c.item.kind}] ${c.item.text}`);
      seen.add(c.item.id);
    }
  }

  return { snippets, opener, substance, usedItemIds };
}

/**
 * Wrap an LLM-generated reply with debug metadata.
 */
export function composeLLMResult(
  replyText: string,
  state: ConversationState,
  styleCandidates: RetrievalCandidate[],
  knowledgeCandidates: RetrievalCandidate[],
  opener: RetrievalCandidate | null,
  substance: RetrievalCandidate | null,
  latency: Omit<LatencyBreakdown, 'composeMs' | 'totalMs'>,
  composeMs: number,
  contextSnippets?: string[],
): ComposeResult {
  return buildResult(replyText, state, styleCandidates, knowledgeCandidates, opener, substance, latency, composeMs, true, contextSnippets);
}

// ── Shared debug builder ─────────────────────────────────────────────

function buildResult(
  replyText: string,
  state: ConversationState,
  styleCandidates: RetrievalCandidate[],
  knowledgeCandidates: RetrievalCandidate[],
  opener: RetrievalCandidate | null,
  substance: RetrievalCandidate | null,
  latency: Omit<LatencyBreakdown, 'composeMs' | 'totalMs'>,
  composeMs: number,
  llmUsed: boolean,
  contextSnippets?: string[],
): ComposeResult {
  const allCandidates = [
    ...styleCandidates.map(toCandidateDebug),
    ...knowledgeCandidates.map(toCandidateDebug),
  ];

  const fullLatency: LatencyBreakdown = {
    ...latency,
    composeMs: Math.round(composeMs * 100) / 100,
    totalMs: Math.round((latency.stateGateMs + latency.retrieveMs + latency.rerankMs + composeMs) * 100) / 100,
  };

  const debug: ComposeDebug = {
    state,
    candidates: allCandidates,
    chosenOpener: opener?.item.id ?? null,
    chosenSubstance: substance?.item.id ?? null,
    latency: fullLatency,
    llmUsed,
    contextSnippets,
  };

  return { replyText, debug };
}
