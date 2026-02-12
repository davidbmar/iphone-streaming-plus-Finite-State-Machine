/**
 * Main entry point: wires up the conversation pipeline,
 * LLM model selection, STT, TTS, FSM, debug panel, test harness, and RAG search.
 */
import type { WorkerResponse, SearchResult } from '@shared/types';
import type { ComposeDebug } from './lib/conversationPack/types.js';
import { ConversationPipeline } from './lib/conversationPack/pipeline.js';
import { ConversationFSM } from './lib/conversationFSM.js';
import { SpeechToText } from './lib/stt.js';
import { initTTS, stop as stopTTS, setTTSCallbacks } from './lib/tts.js';
import {
  loadModel, unloadModel, isModelLoaded, getLoadedModelId, isLoading,
  MODEL_CATALOG, getRuntimeStats, TOKEN_CAP,
} from './lib/llm.js';
import { DiagnosticRunner } from './lib/diagnosticRunner.js';
import { renderRunProgress, renderRunComplete, renderRunHistory, updateDiagnosticBadge } from './lib/diagnosticUI.js';
import { loadAllRuns } from './lib/diagnosticTypes.js';

// ── DOM refs ──────────────────────────────────────────────────────────
const statusEl = document.getElementById('status')!;
const llmStatusEl = document.getElementById('llm-status')!;
const ttsStatusEl = document.getElementById('tts-status')!;
const sttStatusEl = document.getElementById('stt-status')!;
const chatLog = document.getElementById('chat-log')!;
const textInput = document.getElementById('text-input') as HTMLInputElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
const partialTextEl = document.getElementById('partial-text')!;
const ttsToggle = document.getElementById('tts-toggle') as HTMLInputElement;
const stopTtsBtn = document.getElementById('stop-tts-btn') as HTMLButtonElement;
const debugContent = document.getElementById('debug-content')!;

// LLM model bar
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const modelBarName = document.getElementById('model-bar-name')!;
const modelBarInfo = document.getElementById('model-bar-info')!;
const modelProgress = document.getElementById('model-progress')!;
const modelProgressBar = document.getElementById('model-progress-bar')!;
const modelProgressText = document.getElementById('model-progress-text')!;

// Metadata panel
const metadataPanel = document.getElementById('metadata-panel')!;
const metadataContent = document.getElementById('metadata-content')!;

// RAG context panel
const ragContextPanel = document.getElementById('rag-context-panel')! as HTMLDetailsElement;
const ragContextContent = document.getElementById('rag-context-content')!;

// Raw LLM output panel
const rawOutputPanel = document.getElementById('raw-output-panel')! as HTMLDetailsElement;
const rawOutputContent = document.getElementById('raw-output-content')!;

// Diagnostic runner
const runTestsBtn = document.getElementById('run-tests-btn') as HTMLButtonElement;
const diagnosticPanel = document.getElementById('diagnostic-results-panel') as HTMLDetailsElement;
const diagnosticContent = document.getElementById('diagnostic-results-content')!;
const diagnosticBadge = document.getElementById('diagnostic-badge')!;

// Original RAG search elements
const queryInput = document.getElementById('query-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const topkInput = document.getElementById('topk-input') as HTMLInputElement;
const latencyEl = document.getElementById('latency-display')!;
const resultsEl = document.getElementById('results')!;

// ── State ─────────────────────────────────────────────────────────────
const pipeline = new ConversationPipeline();
let workerReady = false;
let requestCounter = 0;

// ── FSM ───────────────────────────────────────────────────────────────
const fsm = new ConversationFSM(pipeline, () => ttsToggle.checked);

// Track the current Iris chat bubble for streaming updates
let currentIrisBody: HTMLElement | null = null;

// ── Search Worker ─────────────────────────────────────────────────────
const worker = new Worker(
  new URL('./workers/search.worker.ts', import.meta.url),
  { type: 'module' }
);

function setStatus(text: string, level: 'loading' | 'ready' | 'error') {
  statusEl.textContent = text;
  statusEl.className = `status ${level}`;
}
function setLLMStatus(text: string, level: 'loading' | 'ready' | 'error' | 'active') {
  llmStatusEl.textContent = text;
  llmStatusEl.className = `status ${level}`;
}
function setTTSStatus(text: string, level: 'loading' | 'ready' | 'error' | 'active') {
  ttsStatusEl.textContent = text;
  ttsStatusEl.className = `status ${level}`;
}
function setSTTStatus(text: string, level: 'loading' | 'ready' | 'error' | 'active') {
  sttStatusEl.textContent = text;
  sttStatusEl.className = `status ${level}`;
}

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data;
  if (pipeline.handleWorkerMessage(msg)) return;

  switch (msg.type) {
    case 'progress':
      setStatus(msg.message, 'loading');
      break;
    case 'ready':
      workerReady = true;
      setStatus('RAG Ready', 'ready');
      queryInput.disabled = false;
      searchBtn.disabled = false;
      pipeline.buildVectorIndex().then(() => {
        if (pipeline.hasVectorSearch) setStatus('RAG + Vector Ready', 'ready');
      });
      break;
    case 'results':
      renderSearchResults(msg.results, msg.latency);
      searchBtn.disabled = false;
      queryInput.disabled = false;
      break;
    case 'error':
      setStatus(`Error: ${msg.message}`, 'error');
      searchBtn.disabled = false;
      queryInput.disabled = false;
      break;
  }
};

// ── Initialize ────────────────────────────────────────────────────────
const artifactsUrl = `${window.location.origin}/artifacts`;
worker.postMessage({ type: 'init', artifactsUrl });

const packUrl = `${window.location.origin}/conversation_pack/iris_kade.pack.jsonl`;
pipeline.init(packUrl, worker).then(() => {
  console.log('Conversation pack loaded');
}).catch(err => {
  console.error('Failed to load conversation pack:', err);
});

// Init TTS
initTTS((msg) => setTTSStatus(msg, 'loading'))
  .then(() => setTTSStatus('TTS: ready', 'ready'))
  .catch(() => setTTSStatus('TTS: unavailable', 'error'));

// Track whether mic was on before TTS started, so we can resume after
let micWasListening = false;

// Legacy TTS callbacks (used for non-streaming pack-only speak)
setTTSCallbacks({
  onStart: () => {
    setTTSStatus('Speaking...', 'active');
    stopTtsBtn.disabled = false;
    if (stt.listening) {
      micWasListening = true;
      stt.stop();
      setSTTStatus('STT: muted (speaking)', 'loading');
    }
  },
  onEnd: () => {
    setTTSStatus('TTS: ready', 'ready');
    stopTtsBtn.disabled = true;
    if (micWasListening) {
      micWasListening = false;
      stt.start();
    }
  },
  onError: (err) => {
    console.warn(err);
    setTTSStatus('TTS: ready', 'ready');
    stopTtsBtn.disabled = true;
    if (micWasListening) {
      micWasListening = false;
      stt.start();
    }
  },
});

// ── FSM Event Wiring ──────────────────────────────────────────────────

/** Submit user input through the FSM */
function submitUserInput(text: string) {
  addChatMessage('user', text);
  textInput.value = '';

  // Create streaming placeholder for LLM mode
  const usingLLM = pipeline.useLLM && isModelLoaded();
  if (usingLLM) {
    currentIrisBody = addChatMessage('iris', '...');
  } else {
    currentIrisBody = null;
  }

  fsm.submitInput(text);
}

fsm.on('iris-token', (_delta, fullText) => {
  if (currentIrisBody) {
    const { clean } = stripModelTags(fullText);
    currentIrisBody.textContent = clean || '...';
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  renderRawOutput(fullText);
});

fsm.on('iris-done', (result) => {
  const { clean, tags } = stripModelTags(result.replyText);
  // If stripping removed content, don't fall back to raw text (would leak <think> tags).
  // Use distinct placeholder so it's not confused with the initial "..." filler.
  const wasStripped = clean.length < result.replyText.length;
  const displayText = wasStripped ? (clean || '[reasoning only — see metadata]') : clean;

  if (currentIrisBody) {
    currentIrisBody.textContent = displayText;
    updateLastIrisLatency(result.debug.latency.totalMs);
  } else {
    addChatMessage('iris', displayText, result.debug.latency.totalMs);
  }
  renderDebug(result.debug);
  renderMetadata(tags);
  renderRAGContext(result.debug);
  renderRawOutput(result.replyText);
});

fsm.on('tts-start', () => {
  setTTSStatus('Speaking...', 'active');
  stopTtsBtn.disabled = false;
  if (stt.listening) {
    micWasListening = true;
    stt.stop();
    setSTTStatus('STT: muted (speaking)', 'loading');
  }
});

fsm.on('tts-end', () => {
  setTTSStatus('TTS: ready', 'ready');
  stopTtsBtn.disabled = true;
  if (micWasListening) {
    micWasListening = false;
    stt.start();
  }
});

fsm.on('iris-filler', (fillerText) => {
  // Show filler text in the chat bubble so display matches what TTS speaks
  if (currentIrisBody && currentIrisBody.textContent === '...') {
    currentIrisBody.textContent = fillerText;
  }
});

fsm.on('interrupted', () => {
  // Mark current Iris message as interrupted
  if (currentIrisBody && currentIrisBody.textContent !== '...') {
    currentIrisBody.textContent += ' [interrupted]';
  }
});

fsm.on('state-change', (state) => {
  // Update debug with FSM state
  const fsmLine = document.getElementById('debug-fsm-state');
  if (fsmLine) fsmLine.textContent = `FSM: ${state}`;
});

fsm.on('error', (msg) => {
  console.warn('FSM error:', msg);
  if (!currentIrisBody) {
    addChatMessage('iris', "Signal's still warming up. Give me a sec.");
  } else if (currentIrisBody.textContent === '...') {
    currentIrisBody.textContent = "Signal's still warming up. Give me a sec.";
  }
});

// ── LLM Model Management ─────────────────────────────────────────────

function updateModelUI() {
  const loaded = isModelLoaded();
  const modelId = getLoadedModelId();

  if (loaded && modelId) {
    const info = MODEL_CATALOG.find(m => m.id === modelId);
    modelBarName.textContent = info?.name ?? modelId;
    modelBarInfo.textContent = `${info?.size ?? ''} | token cap: ${TOKEN_CAP}`;
    setLLMStatus(`LLM: ${info?.name ?? modelId}`, 'ready');
    pipeline.useLLM = true;
  } else {
    modelBarName.textContent = 'Pack only';
    modelBarInfo.textContent = 'Select a model to enable LLM';
    setLLMStatus('LLM: none', 'loading');
    pipeline.useLLM = false;
  }
}

/** Auto-load model when dropdown selection changes */
modelSelect.addEventListener('change', async () => {
  const modelId = modelSelect.value;

  // "Pack only" selected — unload current model
  if (!modelId) {
    if (isModelLoaded()) await unloadModel();
    updateModelUI();
    return;
  }

  // Already loading something — ignore
  if (isLoading()) return;

  // Same model already loaded — no-op
  if (modelId === getLoadedModelId()) return;

  modelSelect.disabled = true;
  modelProgress.style.display = 'block';
  modelProgressBar.style.width = '0%';
  modelProgressText.textContent = 'Starting...';
  setLLMStatus('LLM: loading...', 'loading');

  try {
    await loadModel(modelId, ({ text, pct }) => {
      modelProgressBar.style.width = `${pct}%`;
      modelProgressText.textContent = text;
    });

    modelProgress.style.display = 'none';
    modelSelect.disabled = false;
    updateModelUI();

    // Fetch runtime stats after a moment
    setTimeout(async () => {
      const stats = await getRuntimeStats();
      if (stats) modelBarInfo.textContent += ` | ${stats.split('\n')[0]}`;
    }, 500);
  } catch (e) {
    modelProgress.style.display = 'none';
    modelSelect.disabled = false;
    setLLMStatus(`LLM: error`, 'error');
    console.error('Model load failed:', e);
  }
});

// Init LLM status
setLLMStatus('LLM: none', 'loading');

// ── STT ───────────────────────────────────────────────────────────────
const stt = new SpeechToText({
  onPartial: (text) => { partialTextEl.textContent = text; },
  onFinal: (text) => {
    partialTextEl.textContent = '';
    if (text.trim()) submitUserInput(text.trim());
  },
  onError: (err) => { console.warn(err); setSTTStatus('STT: error', 'error'); },
  onStateChange: (listening) => {
    if (listening) {
      micBtn.classList.add('active');
      setSTTStatus('Listening...', 'active');
    } else {
      micBtn.classList.remove('active');
      setSTTStatus('STT: off', 'loading');
    }
  },
});

if (!stt.supported) {
  setSTTStatus('STT: unsupported', 'error');
  micBtn.disabled = true;
} else {
  setSTTStatus('STT: off', 'loading');
}

// ── Chat Functions ────────────────────────────────────────────────────

/** Create a chat message bubble and return the body element (for streaming updates) */
function addChatMessage(who: 'user' | 'iris', text: string, latencyMs?: number): HTMLElement {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${who}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = who === 'user' ? 'You' : 'Iris';
  msg.appendChild(label);

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  msg.appendChild(body);

  if (latencyMs !== undefined) {
    const tag = document.createElement('div');
    tag.className = 'latency-tag';
    tag.textContent = `${latencyMs}ms`;
    msg.appendChild(tag);
  }

  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return body;
}

/** Update the latency tag on the last Iris message */
function updateLastIrisLatency(ms: number) {
  const msgs = chatLog.querySelectorAll('.chat-msg.iris');
  const last = msgs[msgs.length - 1];
  if (!last) return;
  let tag = last.querySelector('.latency-tag');
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'latency-tag';
    last.appendChild(tag);
  }
  tag.textContent = `${ms}ms`;
}

// ── Debug Renderer ────────────────────────────────────────────────────
function renderDebug(debug: ComposeDebug) {
  const { state, candidates, chosenOpener, chosenSubstance, latency, llmUsed } = debug;

  const parts: string[] = [];

  // FSM state + sentence queue
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">FSM: </span>`);
  parts.push(`<span id="debug-fsm-state" class="debug-value">${escapeHtml(fsm.currentState)}</span>`);
  parts.push(`<span class="debug-value"> sentenceQueue: ${fsm.sentenceQueueDepth}</span>`);
  parts.push(`</div>`);

  // Bias
  const b = fsm.bias;
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">Bias: </span>`);
  parts.push(`<span class="debug-value">v=${b.verbosity.toFixed(2)} d=${b.depth.toFixed(2)} w=${b.warmth.toFixed(2)} maxTok=${fsm.biasMaxTokens}</span>`);
  parts.push(`</div>`);

  // Mode
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">Mode: </span>`);
  parts.push(`<span class="debug-value">${llmUsed ? '<b>LLM-enhanced</b>' : 'Pack-only (fast)'}</span>`);
  parts.push(`</div>`);

  // State
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">State: </span>`);
  let stateStr = `intent=<b>${escapeHtml(state.intent)}</b> tone=<b>${escapeHtml(state.tone)}</b> len=<b>${escapeHtml(state.length)}</b>`;
  if (state.specialRoute) stateStr += ` route=<b>${escapeHtml(state.specialRoute)}</b>`;
  if (state.selectedLanes) stateStr += ` lanes=<b>${escapeHtml(state.selectedLanes.join(','))}</b>`;
  if (state.sensitive) stateStr += ` <span class="debug-warning">[SENSITIVE]</span>`;
  parts.push(`<span class="debug-value">${stateStr}</span></div>`);

  // Latency
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">Latency: </span>`);
  parts.push(`<span class="debug-latency">gate=${latency.stateGateMs}ms ret=${latency.retrieveMs}ms rank=${latency.rerankMs}ms `);
  parts.push(`compose=${latency.composeMs}ms <b>total=${latency.totalMs}ms</b></span>`);
  parts.push(`</div>`);

  // Chosen
  parts.push(`<div class="debug-section">`);
  parts.push(`<span class="debug-label">Chosen: </span>`);
  parts.push(`<span class="debug-value">opener=<b>${escapeHtml(chosenOpener ?? 'none')}</b> substance=<b>${escapeHtml(chosenSubstance ?? 'none')}</b></span>`);
  parts.push(`</div>`);

  // Candidates
  if (candidates.length > 0) {
    parts.push(`<div class="debug-section">`);
    parts.push(`<span class="debug-label">Candidates (${candidates.length}):</span>`);
    parts.push(`<div class="debug-candidates">`);
    for (const c of candidates.slice(0, 8)) {
      const chosen = c.id === chosenOpener || c.id === chosenSubstance;
      parts.push(`<div class="debug-candidate">`);
      parts.push(`<span class="debug-value">${chosen ? '&gt;' : '&nbsp;'} ${escapeHtml(c.id)}</span> `);
      parts.push(`<span class="debug-score">[${escapeHtml(c.kind)}] v=${c.vectorScore} l=${c.lexicalScore} f=${c.finalScore}</span>`);
      parts.push(`</div>`);
    }
    parts.push(`</div></div>`);
  }

  debugContent.innerHTML = parts.join('');
}

// ── Metadata Renderer ────────────────────────────────────────────────
function renderMetadata(tags: ExtractedTag[]) {
  if (tags.length === 0) {
    (metadataPanel as HTMLDetailsElement).open = false;
    metadataContent.innerHTML = '<div class="debug-placeholder">No metadata tags detected</div>';
    return;
  }

  // Auto-open when tags are found
  (metadataPanel as HTMLDetailsElement).open = true;
  const parts: string[] = [];
  for (const tag of tags) {
    parts.push(`<div class="debug-section">`);
    parts.push(`<span class="debug-label">&lt;${escapeHtml(tag.name)}&gt;</span>`);
    parts.push(`<pre class="metadata-pre">${escapeHtml(tag.content)}</pre>`);
    parts.push(`</div>`);
  }
  metadataContent.innerHTML = parts.join('');
}

// ── RAG Context Renderer ──────────────────────────────────────────────

/** Render RAG context snippets that were fed to the LLM */
function renderRAGContext(debug: ComposeDebug): void {
  const snippets = debug.contextSnippets;
  if (!snippets || snippets.length === 0) {
    ragContextContent.textContent = 'No RAG context (pack-only mode)';
    return;
  }

  ragContextPanel.open = true;

  const parts: string[] = [];
  for (const snippet of snippets) {
    // Parse the [label] prefix if present
    const labelMatch = snippet.match(/^\[([^\]]+)\]\s*/);
    const label = labelMatch ? labelMatch[1] : 'context';
    const text = labelMatch ? snippet.slice(labelMatch[0].length) : snippet;

    parts.push(`<div class="rag-snippet">`);
    parts.push(`<span class="rag-snippet-label">${escapeHtml(label)}</span>`);
    parts.push(`<div class="rag-snippet-text">${escapeHtml(text)}</div>`);
    parts.push(`</div>`);
  }

  ragContextContent.innerHTML = parts.join('');
}

// ── Raw LLM Output Renderer ───────────────────────────────────────────

/**
 * Render raw LLM text with tag regions highlighted.
 * Security: rawText is first escaped via escapeHtml() (DOM-based textContent→innerHTML)
 * before being used in the template. All user/model content is sanitized.
 */
function renderRawOutput(rawText: string): void {
  if (!rawText) {
    rawOutputContent.textContent = 'No LLM output yet';
    return;
  }

  // escapeHtml uses DOM textContent setter — safe against injection
  const escaped = escapeHtml(rawText);
  // Highlight complete <tag>content</tag> pairs (on already-escaped text)
  const highlighted = escaped.replace(
    /&lt;(\w+)&gt;([\s\S]*?)&lt;\/\1&gt;/g,
    '<span class="raw-tag-highlight">&lt;$1&gt;$2&lt;/$1&gt;</span>',
  );
  // Highlight unclosed tags at end of stream
  const withUnclosed = highlighted.replace(
    /&lt;(\w+)&gt;([\s\S]*)$/,
    '<span class="raw-tag-highlight">&lt;$1&gt;$2</span>',
  );

  rawOutputContent.innerHTML = withUnclosed;

  // Auto-open panel when tags are detected
  if (/<\w+>/.test(rawText)) {
    rawOutputPanel.open = true;
  }

  rawOutputContent.scrollTop = rawOutputContent.scrollHeight;
}

// ── Event Handlers ────────────────────────────────────────────────────

sendBtn.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (text) submitUserInput(text);
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = textInput.value.trim();
    if (text) submitUserInput(text);
  }
});

micBtn.addEventListener('click', () => stt.toggle());

stopTtsBtn.addEventListener('click', () => {
  stopTTS();
  // Also interrupt FSM if speaking
  if (fsm.currentState === 'SPEAKING') {
    fsm.submitInput(''); // triggers interrupt cleanup
  }
  stopTtsBtn.disabled = true;
  setTTSStatus('TTS: ready', 'ready');
});

document.querySelectorAll('.test-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const text = (btn as HTMLElement).dataset.text;
    if (text) submitUserInput(text);
  });
});

// ── Original RAG Search ───────────────────────────────────────────────
function doSearch() {
  const query = queryInput.value.trim();
  if (!query || !workerReady) return;
  const topK = parseInt(topkInput.value, 10) || 8;
  const requestId = `req-${++requestCounter}`;
  resultsEl.innerHTML = '<div class="result-card" style="text-align:center;color:var(--text-dim)">Searching...</div>';
  searchBtn.disabled = true;
  worker.postMessage({ type: 'search', query, topK, requestId });
}

searchBtn.addEventListener('click', doSearch);
queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

function renderSearchResults(results: SearchResult[], latency: { embedMs: number; searchMs: number }) {
  latencyEl.textContent = `embed: ${latency.embedMs}ms | search: ${latency.searchMs}ms`;
  if (results.length === 0) {
    resultsEl.innerHTML = '<div class="result-card" style="color:var(--text-dim)">No results found.</div>';
    return;
  }
  resultsEl.innerHTML = results
    .map((r) => `
    <div class="result-card">
      <div class="result-header">
        <div class="result-meta">
          <span>${escapeHtml(r.speaker)}</span>
          <span>${escapeHtml(r.doc_id)}</span>
          <span>${formatTimestamp(r.ts_start)}-${formatTimestamp(r.ts_end)}</span>
        </div>
        <span class="result-score">#${r.rank} ${r.score.toFixed(4)}</span>
      </div>
      <div class="result-text">${escapeHtml(r.text)}</div>
    </div>`)
    .join('');
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// ── Model Tag Stripping ──────────────────────────────────────────────

interface ExtractedTag { name: string; content: string; }

/**
 * Strip XML-like model tags (<think>, <reflection>, etc.) from LLM output.
 * Returns clean display text + extracted tag metadata.
 * Also strips incomplete opening tags at end of streaming text.
 */
function stripModelTags(text: string): { clean: string; tags: ExtractedTag[] } {
  const tags: ExtractedTag[] = [];

  // Pass 1: Extract complete <tag>content</tag> pairs
  let clean = text.replace(/<(\w+)>([\s\S]*?)<\/\1>/g, (_match, name, content) => {
    tags.push({ name, content: content.trim() });
    return '';
  });

  // Pass 2: Strip unclosed <tag>... to end-of-string (e.g. "<think>reasoning without close")
  clean = clean.replace(/<(\w+)>[\s\S]*$/, '');

  // Pass 3: Strip dangling partial tag like "<thi" or "</thi" at end
  clean = clean.replace(/<\/?\w*$/, '');

  return { clean: clean.trim(), tags };
}

// ── Diagnostic Runner Wiring ─────────────────────────────────────────

// Show history on page load
{
  const pastRuns = loadAllRuns();
  if (pastRuns.length > 0) {
    renderRunHistory(diagnosticContent);
    updateDiagnosticBadge(diagnosticBadge, pastRuns[0]);
  }
}

let activeRunner: DiagnosticRunner | null = null;

runTestsBtn.addEventListener('click', () => {
  // Cancel if already running
  if (activeRunner && activeRunner.status === 'running') {
    activeRunner.cancel();
    runTestsBtn.textContent = 'Run Tests';
    runTestsBtn.classList.remove('running');
    return;
  }

  // Save TTS state, disable during run
  const ttsWasChecked = ttsToggle.checked;
  ttsToggle.checked = false;

  const runner = new DiagnosticRunner(fsm, submitUserInput, stripModelTags);
  activeRunner = runner;

  const completedTurns: import('./lib/diagnosticTypes.js').TurnSnapshot[] = [];

  diagnosticPanel.open = true;
  runTestsBtn.textContent = 'Cancel';
  runTestsBtn.classList.add('running');

  runner.run({
    onTurnStart: (index, total, prompt) => {
      renderRunProgress(diagnosticContent, index, total, prompt, completedTurns);
    },
    onTurnComplete: (_index, snapshot) => {
      completedTurns.push(snapshot);
    },
    onRunComplete: (run) => {
      renderRunComplete(diagnosticContent, run);
      updateDiagnosticBadge(diagnosticBadge, run);
    },
    onStatusChange: (status) => {
      if (status !== 'running') {
        runTestsBtn.textContent = 'Run Tests';
        runTestsBtn.classList.remove('running');
        ttsToggle.checked = ttsWasChecked;
        activeRunner = null;
      }
    },
  });
});
