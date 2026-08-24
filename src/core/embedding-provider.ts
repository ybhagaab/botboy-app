import type { EmbeddingConfig } from './types.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly providerName: string;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: 'ollama',
  model: 'qwen3-embedding:8b',
  endpoint: 'http://localhost:11434',
  dimensions: 4096,
};

export function createEmbeddingProvider(config?: Partial<EmbeddingConfig>): EmbeddingProvider {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let validated = false;

  async function validateModel(): Promise<void> {
    if (validated) return;
    try {
      const resp = await fetch(`${cfg.endpoint}/api/tags`);
      if (!resp.ok) throw new Error(`Ollama unreachable at ${cfg.endpoint}: ${resp.status}`);
      const data = await resp.json() as { models: { name: string }[] };
      const found = data.models.some(m => m.name === cfg.model || m.name.startsWith(cfg.model + ':'));
      if (!found) {
        const available = data.models.map(m => m.name).join(', ');
        throw new Error(`Ollama model '${cfg.model}' not found. Available: ${available}`);
      }
      validated = true;
      console.log(`[Embeddings] ✅ Ollama model validated: ${cfg.model} (${cfg.dimensions} dims)`);
    } catch (err: any) {
      if (err.message.includes('fetch failed') || err.cause?.code === 'ECONNREFUSED') {
        throw new Error(`Ollama server unreachable at ${cfg.endpoint}. Is Ollama running?`);
      }
      throw err;
    }
  }

  async function callOllama(text: string): Promise<number[]> {
    await validateModel();
    const resp = await fetch(`${cfg.endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Ollama embed failed: ${resp.status} ${body}`);
    }
    const data = await resp.json() as { embeddings: number[][] };
    if (!data.embeddings?.[0]) {
      throw new Error(`Ollama returned empty embeddings for model '${cfg.model}'`);
    }
    const vec = data.embeddings[0];
    if (vec.length !== cfg.dimensions) {
      console.warn(`[Embeddings] Dimension mismatch: expected ${cfg.dimensions}, got ${vec.length}`);
    }
    return vec;
  }

  return {
    get dimensions() { return cfg.dimensions; },
    get providerName() { return `ollama:${cfg.model}`; },

    async embed(text: string): Promise<number[]> {
      return callOllama(text);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      // Ollama /api/embed supports batch via array input
      const resp = await fetch(`${cfg.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, input: texts }),
      });
      if (!resp.ok) {
        throw new Error(`Ollama embed batch failed: ${resp.status} ${resp.statusText}`);
      }
      const data = await resp.json() as { embeddings: number[][] };
      return data.embeddings;
    },
  };
}

// ── Cosine similarity utility ──

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
