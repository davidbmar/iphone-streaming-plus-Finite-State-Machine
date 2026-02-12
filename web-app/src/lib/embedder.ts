/**
 * Browser-side embedding using Transformers.js (v3).
 * Prefers WebGPU when available, falls back to WASM/CPU.
 */
import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

let extractor: FeatureExtractionPipeline | null = null;
let currentDevice: string = 'unknown';

/** Detect the best available backend */
async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // WebGPU not usable
    }
  }
  return 'wasm';
}

/** Initialize the embedding pipeline */
export async function initEmbedder(
  modelName: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  // Don't use local model files
  env.allowLocalModels = false;

  const device = await detectDevice();
  currentDevice = device;
  onProgress?.(`Using device: ${device}`);
  onProgress?.(`Loading model: ${modelName}...`);

  const pipelineFn = pipeline as any;
  extractor = await pipelineFn('feature-extraction', modelName, {
    device,
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
  });

  onProgress?.('Embedding model ready');
  return device;
}

/**
 * Compute a normalized embedding for a single query string.
 * Returns Float32Array of length `dim`.
 */
export async function embedQuery(text: string): Promise<Float32Array> {
  if (!extractor) throw new Error('Embedder not initialized');

  const output = await extractor(text, {
    pooling: 'mean',
    normalize: true,
  });

  // output is a Tensor; extract the flat data
  const data = output.data as Float32Array;
  const dim = output.dims[output.dims.length - 1];

  // Return a copy (the tensor may be reused)
  return new Float32Array(data.buffer, data.byteOffset, dim).slice();
}

export function getDevice(): string {
  return currentDevice;
}
