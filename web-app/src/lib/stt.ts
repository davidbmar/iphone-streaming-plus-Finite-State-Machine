/**
 * Speech-to-Text wrapper using the Web Speech API.
 * Uses SpeechRecognition (Chrome/Edge) for continuous real-time transcription.
 */

// Web Speech API types (not in all TS libs)
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export interface STTCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: string) => void;
  onStateChange: (listening: boolean) => void;
}

export class SpeechToText {
  private recognition: any = null;
  private callbacks: STTCallbacks;
  private _listening = false;

  constructor(callbacks: STTCallbacks) {
    this.callbacks = callbacks;
  }

  get listening(): boolean {
    return this._listening;
  }

  get supported(): boolean {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(): void {
    if (this._listening) return;

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      this.callbacks.onError('Web Speech API not supported in this browser. Use Chrome or Edge.');
      return;
    }

    this.recognition = new SpeechRecognitionClass();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onstart = () => {
      this._listening = true;
      this.callbacks.onStateChange(true);
    };

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this.callbacks.onFinal(transcript.trim());
        } else {
          this.callbacks.onPartial(transcript);
        }
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted') return;
      this.callbacks.onError(`Speech recognition error: ${event.error}`);
    };

    this.recognition.onend = () => {
      if (this._listening) {
        try {
          this.recognition?.start();
        } catch {
          this._listening = false;
          this.callbacks.onStateChange(false);
        }
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
      this.callbacks.onError(`Failed to start speech recognition: ${e}`);
    }
  }

  stop(): void {
    this._listening = false;
    this.recognition?.stop();
    this.recognition = null;
    this.callbacks.onStateChange(false);
  }

  toggle(): void {
    if (this._listening) {
      this.stop();
    } else {
      this.start();
    }
  }
}
