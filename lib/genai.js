
import { GoogleGenAI } from '@google/genai'; // official SDK
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// get embeddings for an array of texts
export async function getEmbeddings(texts) {
  // method names vary slightly by SDK version — consult the SDK docs; typical pattern:
  const resp = await client.models.embedContent({
    model: 'gemini-embedding-001',
    contents: texts
  });
  // resp will contain embeddings per item — adapt to the SDK return shape
  // Example: resp.data.map(d => d.embedding)
  return resp.data.map(d => d.embedding);
}
