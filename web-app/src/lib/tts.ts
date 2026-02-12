/**
 * Text-to-Speech wrapper using @diffusionstudio/vits-web.
 * Runs VITS neural TTS fully in the browser via ONNX/WASM.
 */

let ttsModule: typeof import('@diffusionstudio/vits-web') | null = null;
let modelReady = false;
let currentAudio: HTMLAudioElement | null = null;

const VOICE_ID = 'en_US-hfc_female-medium';

export interface TTSCallbacks {
  onStart: () => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

let callbacks: TTSCallbacks = {
  onStart: () => {},
  onEnd: () => {},
  onError: () => {},
};

export function setTTSCallbacks(cb: Partial<TTSCallbacks>): void {
  callbacks = { ...callbacks, ...cb };
}

/** Initialize TTS: download model if needed */
export async function initTTS(onProgress?: (msg: string) => void): Promise<void> {
  try {
    onProgress?.('Loading TTS module...');
    ttsModule = await import('@diffusionstudio/vits-web');

    // Check if model is already cached
    const stored = await ttsModule.stored();
    const cached = stored.some(v => v === VOICE_ID);

    if (!cached) {
      onProgress?.('Downloading TTS voice model...');
      await ttsModule.download(VOICE_ID, (progress) => {
        const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
        onProgress?.(`Downloading voice: ${pct}%`);
      });
    }

    modelReady = true;
    onProgress?.('TTS ready');
  } catch (e) {
    const msg = `TTS init failed: ${e}`;
    onProgress?.(msg);
    console.warn(msg);
  }
}

/** Speak text aloud. Stops any current speech first. */
export async function speak(text: string): Promise<void> {
  if (!ttsModule || !modelReady) {
    console.warn('TTS not ready, skipping speech');
    return;
  }

  stop();

  try {
    callbacks.onStart();

    // Split into sentences for streaming-like behavior
    const sentences = text.match(/[^.!?]+[.!?]+["']?\s*/g) || [text];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      const blob = await ttsModule.predict({
        text: trimmed,
        voiceId: VOICE_ID,
      });

      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);

      await new Promise<void>((resolve, reject) => {
        currentAudio!.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        currentAudio!.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Audio playback error'));
        };
        currentAudio!.play().catch(reject);
      });
    }

    callbacks.onEnd();
  } catch (e) {
    callbacks.onError(`TTS error: ${e}`);
  }
}

/** Stop current speech */
export function stop(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

export function isTTSReady(): boolean {
  return modelReady;
}

// ── SentenceSpeaker: concurrent TTS generation + playback ───────────

interface QueuedAudio {
  blob: Blob;
  text: string;
}

/**
 * Streams sentences through TTS: generates audio for sentence N+1
 * while sentence N is playing. Max 2 sentences pre-generated (backpressure).
 */
export class SentenceSpeaker {
  private generateQueue: string[] = [];
  private playQueue: QueuedAudio[] = [];
  private generating = false;
  private playing = false;
  private aborted = false;
  private maxAhead = 2;
  private done = false; // no more sentences coming
  private currentAudioEl: HTMLAudioElement | null = null;

  onStart: () => void = () => {};
  onEnd: () => void = () => {};
  onSentenceStart: (text: string) => void = () => {};
  onError: (error: string) => void = () => {};

  /** Enqueue a sentence for TTS generation + playback */
  enqueueSentence(text: string): void {
    if (this.aborted) return;
    this.generateQueue.push(text);
    this.pumpGenerate();
  }

  /** Signal that no more sentences are coming */
  finish(): void {
    this.done = true;
  }

  /** Abort: stop current audio, clear queues */
  abort(): void {
    this.aborted = true;
    this.generateQueue = [];
    this.playQueue = [];
    this.done = true;
    if (this.currentAudioEl) {
      this.currentAudioEl.pause();
      this.currentAudioEl.src = '';
      this.currentAudioEl = null;
    }
  }

  /** True when everything is drained and nothing is playing */
  get idle(): boolean {
    return !this.generating && !this.playing &&
      this.generateQueue.length === 0 && this.playQueue.length === 0;
  }

  get queueDepth(): number {
    return this.generateQueue.length + this.playQueue.length;
  }

  private async pumpGenerate(): Promise<void> {
    if (this.generating || this.aborted) return;
    if (this.generateQueue.length === 0) return;
    // Backpressure: don't generate too far ahead of playback
    if (this.playQueue.length >= this.maxAhead) return;

    this.generating = true;
    const text = this.generateQueue.shift()!;

    try {
      if (!ttsModule || !modelReady) throw new Error('TTS not ready');

      const blob = await ttsModule.predict({
        text,
        voiceId: VOICE_ID,
      });

      if (!this.aborted) {
        this.playQueue.push({ blob, text });
        this.pumpPlayback();
      }
    } catch (e) {
      if (!this.aborted) {
        this.onError(`TTS generate error: ${e}`);
      }
    } finally {
      this.generating = false;
      // Continue generating if more in queue
      if (!this.aborted && this.generateQueue.length > 0) {
        this.pumpGenerate();
      }
      // Check if fully done
      this.checkComplete();
    }
  }

  private async pumpPlayback(): Promise<void> {
    if (this.playing || this.aborted) return;
    if (this.playQueue.length === 0) return;

    this.playing = true;
    const { blob, text } = this.playQueue.shift()!;

    // Fire onStart on very first sentence
    if (!this.aborted) {
      this.onSentenceStart(text);
    }

    const url = URL.createObjectURL(blob);
    this.currentAudioEl = new Audio(url);

    try {
      await new Promise<void>((resolve, reject) => {
        this.currentAudioEl!.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        this.currentAudioEl!.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Audio playback error'));
        };
        this.currentAudioEl!.play().catch(reject);
      });
    } catch (e) {
      if (!this.aborted) {
        this.onError(`TTS playback error: ${e}`);
      }
    } finally {
      this.currentAudioEl = null;
      this.playing = false;

      // Unblock generation (backpressure released)
      if (!this.aborted) {
        this.pumpGenerate();
        // Continue playing next sentence
        if (this.playQueue.length > 0) {
          this.pumpPlayback();
        } else {
          this.checkComplete();
        }
      }
    }
  }

  private checkComplete(): void {
    if (this.done && this.idle && !this.aborted) {
      this.onEnd();
    }
  }
}
