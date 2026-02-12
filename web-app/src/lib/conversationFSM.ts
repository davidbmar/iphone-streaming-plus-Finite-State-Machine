/**
 * Conversation FSM — manages the turn lifecycle.
 *
 * States: IDLE → PROCESSING → SPEAKING → IDLE
 *         any state + userInput during busy → INTERRUPTED → PROCESSING
 *
 * The FSM owns the pipeline, SentenceBuffer, and SentenceSpeaker.
 * STT and send-button just submit events to it.
 */
import type { ComposeResult, ComposeDebug } from './conversationPack/types.js';
import type { ConversationPipeline } from './conversationPack/pipeline.js';
import { SentenceBuffer } from './sentenceBuffer.js';
import { SentenceSpeaker, isTTSReady } from './tts.js';
import { isModelLoaded } from './llm.js';
import { ConversationBias } from './bias.js';

// ── Types ────────────────────────────────────────────────────────────

export type FSMState = 'IDLE' | 'PROCESSING' | 'SPEAKING' | 'INTERRUPTED';

export interface FSMEvents {
  /** FSM state changed */
  'state-change': (state: FSMState) => void;
  /** A complete sentence from Iris (for streaming display + TTS) */
  'iris-sentence': (sentence: string, fullSoFar: string) => void;
  /** Iris turn fully complete */
  'iris-done': (result: ComposeResult) => void;
  /** Streaming token (for live text update) */
  'iris-token': (delta: string, fullText: string) => void;
  /** Filler phrase spoken while waiting for LLM (for display sync) */
  'iris-filler': (fillerText: string) => void;
  /** An error occurred */
  'error': (message: string) => void;
  /** TTS started speaking (mute mic) */
  'tts-start': () => void;
  /** TTS finished speaking (unmute mic) */
  'tts-end': () => void;
  /** Turn was interrupted */
  'interrupted': () => void;
}

type EventKey = keyof FSMEvents;

/**
 * Strip model tags for TTS — lightweight, no metadata extraction.
 * Removes complete <tag>content</tag> pairs and unclosed <tag>... to end.
 */
function stripTagsForTTS(text: string): string {
  // Remove complete <tag>content</tag> pairs
  let clean = text.replace(/<(\w+)>[\s\S]*?<\/\1>/g, '');
  // Remove unclosed <tag>... to end-of-string
  clean = clean.replace(/<(\w+)>[\s\S]*$/, '');
  // Remove dangling partial tag fragments
  clean = clean.replace(/<\/?\w*$/, '');
  return clean;
}

const STALE_THRESHOLD_MS = 8000; // queued input older than 8s is discarded
const FILLER_DELAY_MS = 500; // play filler if no sentence within this time

const FILLERS = [
  'One sec.',
  'Running a trace.',
  'Let me pull that up.',
  'Checking the mesh.',
];

// ── FSM ──────────────────────────────────────────────────────────────

export class ConversationFSM {
  private state: FSMState = 'IDLE';
  private pipeline: ConversationPipeline;
  private ttsEnabled: () => boolean;
  private _bias = new ConversationBias();

  // Turn management
  private abortController: AbortController | null = null;
  private queuedInput: { text: string; timestamp: number } | null = null;
  private lastUserText = ''; // for bias observation after turn completes

  // Streaming
  private sentenceBuffer: SentenceBuffer | null = null;
  private sentenceSpeaker: SentenceSpeaker | null = null;
  private fullStreamText = '';
  private lastCleanLength = 0; // for diff-based clean delta tracking
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private firstSentenceReceived = false;

  // Event listeners
  private listeners = new Map<EventKey, Set<Function>>();

  constructor(pipeline: ConversationPipeline, ttsEnabled: () => boolean) {
    this.pipeline = pipeline;
    this.ttsEnabled = ttsEnabled;
  }

  // ── Public API ───────────────────────────────────────────────────

  /** Submit user input. If busy, queues it (newest-wins) and interrupts. */
  submitInput(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.state === 'IDLE') {
      this.startTurn(trimmed);
    } else {
      // Queue input (newest-wins) and interrupt current turn
      this.queuedInput = { text: trimmed, timestamp: Date.now() };
      this.interrupt();
    }
  }

  get currentState(): FSMState { return this.state; }
  get bias() { return this._bias.current; }
  get biasMaxTokens() { return this._bias.maxTokens; }
  get sentenceQueueDepth() { return this.sentenceSpeaker?.queueDepth ?? 0; }

  // ── Event system ─────────────────────────────────────────────────

  on<K extends EventKey>(event: K, handler: FSMEvents[K]): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off<K extends EventKey>(event: K, handler: FSMEvents[K]): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit<K extends EventKey>(event: K, ...args: Parameters<FSMEvents[K]>): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { (h as Function)(...args); } catch (e) { console.error('FSM event handler error:', e); }
    }
  }

  // ── State transitions ────────────────────────────────────────────

  private setState(next: FSMState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', next);
  }

  // ── Turn lifecycle ───────────────────────────────────────────────

  private async startTurn(text: string): Promise<void> {
    this.setState('PROCESSING');
    this.abortController = new AbortController();
    this.fullStreamText = '';
    this.lastCleanLength = 0;
    this.lastUserText = text;

    const usingLLM = this.pipeline.useLLM && isModelLoaded();
    this.firstSentenceReceived = false;

    // Set up sentence buffer + speaker for streaming TTS
    if (usingLLM && this.ttsEnabled() && isTTSReady()) {
      this.sentenceSpeaker = new SentenceSpeaker();
      this.sentenceSpeaker.onEnd = () => {
        this.emit('tts-end');
        if (this.state === 'SPEAKING') {
          this.setState('IDLE');
          this.processQueue();
        }
      };
      this.sentenceSpeaker.onSentenceStart = (sentenceText) => {
        // Fire tts-start on the very first sentence (mutes mic)
        if (!this.firstSentenceReceived) {
          this.firstSentenceReceived = true;
          this.clearFillerTimer();
          this.emit('tts-start');
        }
      };
      this.sentenceSpeaker.onError = (err) => this.emit('error', err);

      let sentencesSoFar = '';
      this.sentenceBuffer = new SentenceBuffer((sentence) => {
        sentencesSoFar += (sentencesSoFar ? ' ' : '') + sentence;
        this.emit('iris-sentence', sentence, sentencesSoFar);
        this.sentenceSpeaker!.enqueueSentence(sentence);
      });

      // Filler timer: if no sentence arrives within 500ms, play a filler
      this.fillerTimer = setTimeout(() => {
        if (!this.firstSentenceReceived && !this.abortController?.signal.aborted) {
          const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
          this.sentenceSpeaker!.enqueueSentence(filler);
          this.emit('iris-filler', filler);
        }
      }, FILLER_DELAY_MS);
    } else {
      this.sentenceBuffer = null;
      this.sentenceSpeaker = null;
    }

    try {
      const signal = this.abortController.signal;

      const result = await this.pipeline.processUserTurn(
        text,
        // onToken callback: feed clean deltas into sentence buffer, raw to UI
        (delta, fullText) => {
          if (signal.aborted) return;
          this.fullStreamText = fullText;
          this.emit('iris-token', delta, fullText);

          // Strip tags from full text, diff to find new clean content
          const cleanFull = stripTagsForTTS(fullText);
          const newClean = cleanFull.slice(this.lastCleanLength);
          this.lastCleanLength = cleanFull.length;
          if (newClean) this.sentenceBuffer?.push(newClean);
        },
        { signal },
      );

      // Aborted mid-generation
      if (signal.aborted) return;

      // Flush remaining text in sentence buffer
      this.sentenceBuffer?.flush();

      if (result) {
        // Observe turn for adaptive bias (use intent from pipeline result)
        this._bias.observeTurn(text, result.debug.state.intent);

        this.emit('iris-done', result);

        // If we have a sentence speaker running, transition to SPEAKING
        if (this.sentenceSpeaker && !this.sentenceSpeaker.idle) {
          this.sentenceSpeaker.finish();
          this.setState('SPEAKING');
        } else if (this.sentenceSpeaker) {
          // All sentences already played (very short response)
          this.sentenceSpeaker.finish();
          this.setState('IDLE');
          this.processQueue();
        } else {
          // No streaming TTS — speak the full result with legacy speak()
          if (this.ttsEnabled() && isTTSReady() && !signal.aborted) {
            // Import dynamically to avoid circular ref
            const { speak } = await import('./tts.js');
            this.setState('SPEAKING');
            this.emit('tts-start');
            try {
              await speak(result.replyText);
            } finally {
              this.emit('tts-end');
              if (this.state === 'SPEAKING') {
                this.setState('IDLE');
                this.processQueue();
              }
            }
          } else {
            this.setState('IDLE');
            this.processQueue();
          }
        }
      } else {
        // Pipeline returned null (not ready)
        this.emit('error', 'Pipeline not ready');
        this.setState('IDLE');
        this.processQueue();
      }
    } catch (e) {
      if (!this.abortController?.signal.aborted) {
        this.emit('error', `Turn error: ${e}`);
      }
      this.setState('IDLE');
      this.processQueue();
    }
  }

  private clearFillerTimer(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
  }

  private interrupt(): void {
    if (this.state === 'IDLE') return;

    // Abort current LLM generation
    this.abortController?.abort();

    // Stop current TTS playback
    this.clearFillerTimer();
    this.sentenceSpeaker?.abort();
    this.sentenceBuffer?.clear();

    this.emit('interrupted');
    this.setState('INTERRUPTED');

    // Immediately process queued input
    this.processQueue();
  }

  private processQueue(): void {
    if (!this.queuedInput) return;

    const { text, timestamp } = this.queuedInput;
    this.queuedInput = null;

    // Discard stale input
    if (Date.now() - timestamp > STALE_THRESHOLD_MS) {
      this.setState('IDLE');
      return;
    }

    this.startTurn(text);
  }
}
