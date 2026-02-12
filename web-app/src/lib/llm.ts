/**
 * Local LLM engine wrapper using @mlc-ai/web-llm.
 * Manages model selection, loading, and chat completion via WebGPU.
 */
import * as webllm from '@mlc-ai/web-llm';

// ── Model catalog ────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  vramGB: number;
  tags: string[];
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Tiny (mobile-friendly)
  { id: 'SmolLM2-135M-Instruct-q0f16-MLC', name: 'SmolLM2 135M', size: '~80MB', vramGB: 0.3, tags: ['fast', 'mobile'] },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', name: 'SmolLM2 360M', size: '~200MB', vramGB: 0.5, tags: ['fast', 'mobile'] },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', name: 'Qwen3 0.6B', size: '~400MB', vramGB: 0.6, tags: ['fast', 'mobile', 'reasoning'] },
  // Small
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 1B', size: '~600MB', vramGB: 0.8, tags: ['fast', 'balanced'] },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 1.5B', size: '~900MB', vramGB: 1.0, tags: ['balanced'] },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', name: 'Qwen3 1.7B', size: '~1GB', vramGB: 1.2, tags: ['balanced', 'reasoning'] },
  { id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', name: 'SmolLM2 1.7B', size: '~1GB', vramGB: 1.2, tags: ['balanced'] },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', name: 'Gemma 2 2B', size: '~1.2GB', vramGB: 1.4, tags: ['balanced'] },
  // Medium
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 3B', size: '~1.8GB', vramGB: 2.0, tags: ['balanced', 'smart'] },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', name: 'Phi 3.5 Mini', size: '~2.2GB', vramGB: 2.5, tags: ['smart', 'balanced'] },
  { id: 'Qwen3-4B-q4f16_1-MLC', name: 'Qwen3 4B', size: '~2.5GB', vramGB: 2.8, tags: ['smart', 'reasoning'] },
  // Large
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 7B', size: '~4.5GB', vramGB: 4.5, tags: ['smart'] },
  { id: 'Qwen3-8B-q4f16_1-MLC', name: 'Qwen3 8B', size: '~5GB', vramGB: 5.0, tags: ['smart', 'reasoning'] },
  { id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', name: 'Llama 3.1 8B', size: '~5GB', vramGB: 5.0, tags: ['smart'] },
  // Specialized
  { id: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC', name: 'DeepSeek R1 7B', size: '~4.5GB', vramGB: 4.5, tags: ['reasoning', 'smart'] },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 Coder 1.5B', size: '~900MB', vramGB: 1.0, tags: ['code', 'balanced'] },
  { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 Coder 7B', size: '~4.5GB', vramGB: 4.5, tags: ['code', 'smart'] },
];

// ── System prompt ────────────────────────────────────────────────────

const IRIS_SYSTEM_PROMPT = `You are Iris Kade, a noir-cyberpunk security specialist in the mesh. You teach defense, not offense. You're a professional paranoid with a dry sense of humor and genuine care for the people you help.

Personality:
- Direct, protective, dry-humored, knowledgeable.
- Empathetic under the surface — you show warmth when someone is stressed.
- You use cyberpunk and noir metaphors naturally.
- You teach opsec, privacy, encryption, threat modeling.
- You refuse to help with offensive hacking, cracking, or unauthorized access.

Style rules:
- Keep replies 1-3 sentences for small talk. Go longer only for technical questions.
- Sound like a real person, not a chatbot. No bullet points, no numbered lists.
- Never say you're an AI, assistant, or language model.
- Match the person's energy: brief for brief, detailed for detailed.
- Use your own words. If given memory notes, incorporate them naturally — never copy them verbatim.`;

/** Check if a model has the 'reasoning' tag (e.g. DeepSeek R1) */
export function isReasoningModel(modelId?: string | null): boolean {
  const id = modelId ?? currentModelId;
  if (!id) return false;
  const info = MODEL_CATALOG.find(m => m.id === id);
  return info?.tags.includes('reasoning') ?? false;
}

/** Hard token cap for all models — prevents reasoning loops while allowing substantial output. */
export const TOKEN_CAP = 512;

// ── Engine state ─────────────────────────────────────────────────────

let engine: webllm.MLCEngineInterface | null = null;
let currentModelId: string | null = null;
let loading = false;

export type LoadProgressCallback = (progress: { text: string; pct: number }) => void;

// ── Public API ───────────────────────────────────────────────────────

export async function loadModel(
  modelId: string,
  onProgress?: LoadProgressCallback,
): Promise<void> {
  if (loading) throw new Error('Already loading a model');
  loading = true;

  try {
    // Unload previous engine if any
    if (engine) {
      await engine.unload();
      engine = null;
      currentModelId = null;
    }

    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (progress: webllm.InitProgressReport) => {
        const pct = progress.progress ? Math.round(progress.progress * 100) : 0;
        onProgress?.({ text: progress.text, pct });
      },
    });

    currentModelId = modelId;
  } finally {
    loading = false;
  }
}

export async function unloadModel(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    currentModelId = null;
  }
}

export function isModelLoaded(): boolean {
  return engine !== null && currentModelId !== null;
}

export function getLoadedModelId(): string | null {
  return currentModelId;
}

export function isLoading(): boolean {
  return loading;
}

/**
 * Generate a reply using the loaded LLM.
 * Takes user message + optional context snippets from the conversation pack.
 * Returns the full generated text.
 */
export async function generateReply(
  userMessage: string,
  contextSnippets: string[] = [],
  onToken?: (token: string, fullText: string) => void,
  options?: { signal?: AbortSignal },
): Promise<string> {
  if (!engine) throw new Error('No model loaded');

  const signal = options?.signal;

  // Build messages — web-llm only allows ONE system message, so merge context into it
  let systemContent = IRIS_SYSTEM_PROMPT;
  if (contextSnippets.length > 0) {
    systemContent += `\n\nMemory notes (optional background — use only if relevant, never copy verbatim):\n${contextSnippets.join('\n')}`;
  }

  const messages: webllm.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage },
  ];

  // Check abort before starting
  if (signal?.aborted) return '';

  // Flat token cap prevents reasoning models from looping in <think> forever.
  // Soft length guidance comes from the compose system's len hint in the prompt.
  const chunks = await engine.chat.completions.create({
    messages,
    temperature: 0.7,
    max_tokens: TOKEN_CAP,
    top_p: 0.95,
    stream: true,
  });

  let fullText = '';
  for await (const chunk of chunks) {
    // Break out on abort
    if (signal?.aborted) break;

    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      fullText += delta;
      onToken?.(delta, fullText);
    }
  }

  // Trim to last complete sentence so we never cut off mid-word.
  // But skip trimming if text ends inside an unclosed tag — let stripModelTags handle it.
  let result = fullText.trim();
  const lastOpen = result.lastIndexOf('<');
  const lastClose = result.lastIndexOf('>');
  const insideTag = lastOpen > lastClose; // unclosed '<' after last '>'

  if (!insideTag) {
    const lastEnd = Math.max(result.lastIndexOf('.'), result.lastIndexOf('!'), result.lastIndexOf('?'));
    if (lastEnd > 0) {
      result = result.slice(0, lastEnd + 1);
    }
  }
  return result;
}

/**
 * Check if WebGPU is available.
 */
export async function checkWebGPU(): Promise<{ supported: boolean; gpuName: string; vramGB: number }> {
  if (!(navigator as any).gpu) {
    return { supported: false, gpuName: 'N/A', vramGB: 0 };
  }

  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) return { supported: false, gpuName: 'N/A', vramGB: 0 };

    let gpuName = 'Unknown GPU';
    try {
      if (adapter.info) {
        gpuName = adapter.info.device || adapter.info.description || adapter.info.vendor || gpuName;
      }
    } catch { /* ignore */ }

    // Estimate VRAM from maxBufferSize
    const device = await adapter.requestDevice();
    const maxBuffer = device.limits.maxBufferSize || 0;
    const vramGB = Math.round((maxBuffer / (1024 ** 3)) * 10) / 10;
    device.destroy();

    return { supported: true, gpuName, vramGB };
  } catch {
    return { supported: false, gpuName: 'N/A', vramGB: 0 };
  }
}

/**
 * Get runtime stats from the loaded engine.
 */
export async function getRuntimeStats(): Promise<string | null> {
  if (!engine) return null;
  try {
    return await engine.runtimeStatsText();
  } catch {
    return null;
  }
}
