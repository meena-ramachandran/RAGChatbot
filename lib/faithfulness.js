
import { pipeline } from '@xenova/transformers';

const embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

function norm(a) {
  return Math.sqrt(a.reduce((s, v) => s + v * v, 0));
}

function cosine(a, b) {
  const n = norm(a) * norm(b) + 1e-8;
  return dot(a, b) / n;
}

export async function getFaithfulnessScore(contextChunks, answer, { topK = 3 } = {}) {
  if (!answer || !contextChunks || contextChunks.length === 0) {
    return { score: 0, perChunk: [] };
  }

  const embedder = await embedderPromise;

  // Prepare texts
  const chunks = contextChunks.map((c) => (typeof c === 'string' ? c : c.chunk_text || ''));

  // Compute embeddings
  const answerT = await embedder(answer, { pooling: 'mean', normalize: true });
  const answerEmb = Array.from(answerT.data);

  const perChunk = [];
  for (const chunk of chunks) {
    try {
      const t = await embedder(chunk, { pooling: 'mean', normalize: true });
      const emb = Array.from(t.data);
      const sim = cosine(answerEmb, emb);
      perChunk.push({ chunk, score: sim });
    } catch (e) {
      perChunk.push({ chunk, score: 0 });
    }
  }

  // sort desc
  perChunk.sort((a, b) => b.score - a.score);

  // aggregate topK
  const top = perChunk.slice(0, topK);
  const avg = top.reduce((s, p) => s + p.score, 0) / Math.max(1, top.length);

  // Map cosine similarity (~0..1) to 0..100 percentage
  const score = Math.max(0, Math.min(100, Math.round(avg * 100)));

  return { score, perChunk };
}
