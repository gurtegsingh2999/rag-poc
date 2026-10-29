import {
  CreateMLCEngine,
  type MLCEngine,
  type InitProgressReport,
  type InitProgressCallback,
} from '@mlc-ai/web-llm';
import { checkWebGPUSupport } from './gpuCheck';
import {
  assemblePrompt,
  formatRetrievalFallback,
  type RetrievedChunkMatch,
} from './promptAssembler';

export interface LLMModelOption {
  id: string;
  name: string;
  parameters: string;
  vramRequiredMB: number;
  description: string;
}

export const SUPPORTED_LLM_MODELS: LLMModelOption[] = [
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    name: 'Llama 3.2 1B Instruct (Default)',
    parameters: '1.2B',
    vramRequiredMB: 880,
    description: 'Meta flagship lightweight model. Fast generation, balanced reasoning, and low VRAM footprint.',
  },
  {
    id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    name: 'SmolLM2 1.7B Instruct',
    parameters: '1.7B',
    vramRequiredMB: 1100,
    description: 'HuggingFace high-performance small model. Strong instruction compliance and factual reasoning.',
  },
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen 2.5 0.5B Instruct',
    parameters: '0.5B',
    vramRequiredMB: 400,
    description: 'Ultra-lightweight model. Instant download, minimal memory, ideal for low-power mobile or laptop GPUs.',
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen 2.5 1.5B Instruct',
    parameters: '1.5B',
    vramRequiredMB: 1150,
    description: 'Alibaba flagship compact model with strong structured context extraction capabilities.',
  },
  {
    id: 'gemma-4-E2B-it-q4f16_1-MLC',
    name: 'Gemma 4 E2B Instruct',
    parameters: 'E2B',
    vramRequiredMB: 3387,
    description: 'Secondary Google model. About 3.4 GB VRAM and shader-f16. Stays unloaded until you select it and warm up.',
  },
];

export const DEFAULT_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

export interface WebLLMClientState {
  isInitializing: boolean;
  isReady: boolean;
  error?: string;
  progressReport?: InitProgressReport;
  selectedModel: string;
}

export type ProgressListener = (report: InitProgressReport) => void;

export class WebLLMClient {
  private engine: MLCEngine | null = null;
  private modelId: string;
  private listeners: Set<ProgressListener> = new Set();
  private state: WebLLMClientState;
  private initPromise: Promise<MLCEngine> | null = null;

  constructor(modelId: string = DEFAULT_MODEL_ID) {
    this.modelId = modelId;
    this.state = {
      isInitializing: false,
      isReady: false,
      selectedModel: modelId,
    };
  }

  public getState(): WebLLMClientState {
    return { ...this.state };
  }

  public getModelId(): string {
    return this.modelId;
  }

  public onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    if (this.state.progressReport) {
      listener(this.state.progressReport);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyProgress(report: InitProgressReport) {
    this.state.progressReport = report;
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch (err) {
        console.error('Error in WebLLM progress listener:', err);
      }
    }
  }

  /**
   * Switches the active LLM model. Unloads current engine from WebGPU memory and resets state.
   */
  public async switchModel(newModelId: string, autoWarmup = false): Promise<void> {
    if (this.modelId === newModelId && this.engine) {
      return;
    }

    if (this.engine) {
      try {
        // Discard / unload existing WebGPU engine
        await this.engine.unload();
      } catch (e) {
        console.warn('Failed to cleanly unload previous WebLLM engine:', e);
      }
      this.engine = null;
    }

    this.modelId = newModelId;
    this.initPromise = null;
    this.state = {
      isInitializing: false,
      isReady: false,
      selectedModel: newModelId,
      error: undefined,
      progressReport: undefined,
    };

    this.notifyProgress({
      progress: 0,
      timeElapsed: 0,
      text: `Selected ${newModelId}. Click Warmup to load weights into WebGPU.`,
    });

    if (autoWarmup) {
      await this.initialize();
    }
  }

  /**
   * Initializes the MLC Engine with download & cache progress tracking.
   */
  public async initialize(customProgressCallback?: InitProgressCallback): Promise<MLCEngine> {
    if (this.engine) {
      return this.engine;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.state.isInitializing = true;
    this.state.error = undefined;

    const gpuSupport = await checkWebGPUSupport();
    if (!gpuSupport.supported) {
      const err = new Error(gpuSupport.reason || 'WebGPU is not supported in this browser.');
      this.state.isInitializing = false;
      this.state.error = err.message;
      throw err;
    }

    this.initPromise = (async () => {
      try {
        const engine = await CreateMLCEngine(this.modelId, {
          initProgressCallback: (report: InitProgressReport) => {
            this.notifyProgress(report);
            if (customProgressCallback) {
              customProgressCallback(report);
            }
          },
        });
        this.engine = engine;
        this.state.isInitializing = false;
        this.state.isReady = true;
        this.state.error = undefined;
        this.notifyProgress({
          progress: 1.0,
          timeElapsed: 0,
          text: `Model engine ready in WebGPU (${this.modelId})`,
        });
        return engine;
      } catch (error) {
        this.state.isInitializing = false;
        this.state.isReady = false;
        const msg = error instanceof Error ? error.message : String(error);
        this.state.error = msg;
        this.initPromise = null;
        this.notifyProgress({
          progress: 0,
          timeElapsed: 0,
          text: `Engine error: ${msg}`,
        });
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Streams generation from the active WebLLM instance token-by-token.
   */
  public async generateAnswerStream(
    assembled: { systemPrompt: string; userPrompt: string },
    onToken?: (token: string) => void
  ): Promise<string> {
    if (!this.engine) {
      await this.initialize();
    }

    if (!this.engine) {
      throw new Error('WebLLM engine could not be initialized.');
    }

    const messages = [
      { role: 'system' as const, content: assembled.systemPrompt },
      { role: 'user' as const, content: assembled.userPrompt },
    ];

    const asyncChunks = await this.engine.chatCompletion({
      stream: true,
      messages,
      temperature: 0.2,
      max_tokens: 512,
    });

    let fullAnswer = '';

    for await (const chunk of asyncChunks) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullAnswer += delta;
        if (onToken) {
          onToken(delta);
        }
      }
    }

    return fullAnswer;
  }

  /**
   * Full end-to-end RAG answering pipeline with automatic fallback handling.
   */
  public async answerQuery(
    query: string,
    retrievedChunks: RetrievedChunkMatch[],
    onToken?: (token: string) => void,
    similarityThreshold = 0.05
  ): Promise<{ text: string; mode: 'llm' | 'retrieval-fallback'; citations: RetrievedChunkMatch[] }> {
    const assembled = assemblePrompt(query, retrievedChunks, { similarityThreshold });

    if (!assembled.hasRelevantContext) {
      const refusal = 'The provided Northstar operational documentation does not contain this information.';
      if (onToken) onToken(refusal);
      return {
        text: refusal,
        mode: 'llm',
        citations: [],
      };
    }

    const gpuSupport = await checkWebGPUSupport();
    if (!gpuSupport.supported) {
      console.warn('[WebLLM] WebGPU not supported:', gpuSupport.reason);
      const fallback = formatRetrievalFallback(query, retrievedChunks, gpuSupport.reason);
      if (onToken) onToken(fallback);
      return {
        text: fallback,
        mode: 'retrieval-fallback',
        citations: assembled.includedChunks,
      };
    }

    try {
      console.log('[WebLLM] Starting generation with model:', this.modelId);
      const answer = await this.generateAnswerStream(assembled, onToken);
      return {
        text: answer,
        mode: 'llm',
        citations: assembled.includedChunks,
      };
    } catch (err) {
      console.warn('[WebLLM] WebLLM generation failed, falling back to retrieval view:', err);
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = formatRetrievalFallback(query, retrievedChunks, reason);
      if (onToken) onToken(fallback);
      return {
        text: fallback,
        mode: 'retrieval-fallback',
        citations: assembled.includedChunks,
      };
    }
  }
}

// Singleton helper instance for convenient app-wide use
let clientSingleton: WebLLMClient | null = null;

export function getWebLLMClient(modelId?: string): WebLLMClient {
  if (!clientSingleton) {
    clientSingleton = new WebLLMClient(modelId);
  }
  return clientSingleton;
}
