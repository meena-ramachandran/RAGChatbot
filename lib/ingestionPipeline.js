import { pipeline } from "@xenova/transformers";

import natural from "natural";

import nlp from "compromise";

import pLimit from "p-limit";

import { v4 as uuidv4 } from "uuid";

import { semanticChunkDocument } from './semanticChunker';


 
// CONCURRENCY
const limit = pLimit(3);
 
// MODELS
 const embedderPromise =
    pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2"
    );

const summarizerPromise =
    pipeline(
        "summarization",
        "Xenova/distilbart-cnn-12-6"
    );


// PII PATTERNS
const PII_PATTERNS = {
    CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g, 
    EMAIL: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    PHONE:  /\+?\d[\d\s()-]{7,}\d/g,
    JWT: /\beyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g,
    API_KEY: /\b(sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9]+\b/g,
    AWS_KEY: /\bAKIA[0-9A-Z]{16}\b/g,
    PASSWORD: /password\s*[:=]\s*\S+/gi,
    SECRET: /secret\s*[:=]\s*\S+/gi,
};



// REDACTION
function redactPII(text) {
    let sanitized = text;
    Object.entries(PII_PATTERNS).forEach(([label, regex]) => {
        sanitized = sanitized.replace( regex,`[REDACTED_${label}]`);});
    console.log(sanitized)
    return sanitized;
}



// SEMANTIC PARSING
function semanticParse(text) {
    const doc = nlp(text);
    return {
        topics:doc.topics().out("array"),
        people:doc.people().out("array"),
        organizations:doc.organizations().out("array"),
    };
}


// ADAPTIVE CHUNKER
function adaptiveChunker(text) {
    const paragraphs =text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";
    for (const para of paragraphs) {
        const isCode =para.includes("{") || para.includes("=>") || para.includes("function");
        const maxSize =isCode ? 300 : 1000;
        if (
            currentChunk.length +
            para.length >
            maxSize
        ) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
        }
        currentChunk +=para + "\n\n";
    }
    if (currentChunk.trim()) {
        chunks.push(
            currentChunk.trim()
        );
    }
    return chunks;
}



// KEYWORDS
function extractKeywords(text) {
    const tfidf = new natural.TfIdf();
    tfidf.addDocument(text);
    return tfidf
        .listTerms(0)
        .slice(0, 15)
        .map((t) => t.term);
}


// SUMMARIZATION
function summarize(text) {
  if (!text) {
    return '';
  }


  // CLEAN
  console.log(text);
  const cleaned =text.replace(/\s+/g, ' ').trim();

  // SENTENCES
  const sentences =cleaned.match(
      /[^.!?]+[.!?]+/g
    ) || [];
  if (sentences.length <= 3) {
    return cleaned.slice(0, 400);
  }
  // TF-IDF
  const tfidf =new natural.TfIdf();
  sentences.forEach((sentence) => {
    tfidf.addDocument(sentence);
  });

  // SCORE SENTENCES
  const scored =sentences.map((sentence, index) => {
      let score = 0;
      tfidf.listTerms(index)
        .slice(0, 10)
        .forEach((term) => {
          score += term.tfidf;
        });
      return {
        sentence,
        score,
        index,
      };
    });
  // BEST SENTENCES
  const best =scored
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 3)
      // restore original order
      .sort(
        (a, b) =>
          a.index - b.index
      )
      .map((s) =>
        s.sentence.trim()
      )
      .join(' ');
  return best.slice(0, 500);
}



// EMBEDDING
async function generateEmbedding(text) {
    const embedder = await embedderPromise;
    const result =await embedder(text, {
            pooling: "mean",
            normalize: true,
        });
    return Array.from(
        result.data
    );
}


// MAIN PIPELINE
export async function
    processPdfText({
        text,
        documentId,
        fileName,
        fileHash,
    }) {
    const sanitized =redactPII(text);

    const semantic = semanticParse(
            sanitized
        );
    console.log('sanitized:', sanitized);
    const documentSummary =
        await summarize(
            sanitized.slice(0, 4000)
        );
    const chunks = await semanticChunkDocument(sanitized);
    const enrichedChunks =await Promise.all(
            chunks.map((chunk, index) =>
                limit(async () => {
                    console.log('Chunk:', chunk);
                    const summary =
                        await summarize(chunk.text_content);
                    const embedding =
                        await generateEmbedding(
                            chunk
                        );
                    return {
                        id:uuidv4(),
                        document_id:documentId,
                        chunk_index:index,
                        total_chunks:chunks.length,
                        section:"general",
                        chunk_type:"documentation",
                        is_code:chunk.includes("{"),
                        text_content:chunk,
                        summary,
                        keywords: extractKeywords(chunk),
                        topics:semantic.topics,
                        people: semantic.people,
                        organizations:semantic.organizations,
                        token_estimate:Math.ceil(chunk.length / 4),
                        contains_pii:sanitized !== text,
                        security_level:"internal",
                        embedding,
                        embedding_model:"all-MiniLM-L6-v2",
                        metadata: {
                            fileHash: fileHash,
                            source:fileName,
                            documentSummary,
                            createdAt:new Date().toISOString(),
                        },
                    };
                })
            )
        );
    return enrichedChunks;
}