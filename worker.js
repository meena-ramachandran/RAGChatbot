import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import pdf from "pdf-parse";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { pipeline } from "@xenova/transformers";
import { createClient } from "@supabase/supabase-js";


const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

console.log("Supabase URL:", supabaseUrl ? "Found" : "Missing");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("Supabase Service Role Key:", supabaseKey ? "Found" : "Missing");

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/* -------------------- Redis -------------------- */

const redisUrl = process.env.REDIS_URL;
let connection = null;
let redisReady = false;

if (redisUrl) {
  try {
    const conn = new IORedis(redisUrl, {
      connectTimeout: 3000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    });

    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      conn.once("ready", () => {
        clearTimeout(timer);
        resolve(true);
      });
      conn.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (ok) {
      connection = conn;
      redisReady = true;
      console.log("Redis connected");
    } else {
      conn.disconnect();
      console.warn("Redis not ready, using poller");
    }
  } catch {
    console.warn("Redis failed, using poller");
  }
} else {
  console.warn("No REDIS_URL, using poller");
}

/* -------------------- Helpers -------------------- */

function cleanText(text) {
  return text
    .replace(/\0/g, "")
    .replace(/[\u0001-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function parsePdf(buffer) {
  const data = await pdf(buffer);
  return {
    text: data.text || "",
    numpages: data.numpages || 0,
  };
}

/* -------------------- Embeddings -------------------- */

console.log("Loading embedding model...");
const embedderPromise = pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);

/* -------------------- Document Classification -------------------- */

function classifyDocument(text, metadata = {}) {
  const pages = metadata.pages || 1;
  const paragraphs = text.split("\n\n");
  const avgParaLength =
    paragraphs.reduce((a, p) => a + p.length, 0) /
    Math.max(1, paragraphs.length);

  if (pages <= 2 && avgParaLength < 500) return "short_structured";
  if (/resume|curriculum vitae|experience/i.test(text)) return "resume";
  if (/table of contents|chapter/i.test(text)) return "long_structured";
  if (/legal|hereby|whereas/i.test(text)) return "legal";

  return "generic";
}

/* -------------------- Chunking -------------------- */

function paragraphChunkWithMeta(text) {
  const chunks = [];
  let cursor = 0;
  let index = 0;

  for (const part of text.split("\n\n")) {
    const trimmed = cleanText(part);
    if (!trimmed) {
      cursor += part.length + 2;
      continue;
    }

    const start = text.indexOf(trimmed, cursor);
    const end = start + trimmed.length;

    chunks.push({
      chunk_text: trimmed,
      chunk_index: index++,
      chunk_type: "paragraph",
      char_start: start,
      char_end: end,
    });

    cursor = end;
  }

  return chunks;
}

function recursiveChunkWithMeta(
  text,
  { maxChars = 1500, overlap = 200 } = {}
) {
  const parts = text.split("\n\n");
  const chunks = [];

  let current = "";
  let start = 0;

  for (const part of parts) {
    if ((current + part).length <= maxChars) {
      current += part + "\n\n";
    } else {
      const cleaned = cleanText(current);
      if (cleaned) {
        chunks.push({
          chunk_text: cleaned,
          char_start: start,
          char_end: start + cleaned.length,
          chunk_type: "recursive",
        });
      }
      start += Math.max(0, current.length - overlap);
      current = part + "\n\n";
    }
  }

  if (current.trim()) {
    const cleaned = cleanText(current);
    chunks.push({
      chunk_text: cleaned,
      char_start: start,
      char_end: start + cleaned.length,
      chunk_type: "recursive",
    });
  }

  return chunks.map((c, i) => ({ ...c, chunk_index: i }));
}

/**
 * Hybrid = recursive base + safe merge + size enforcement
 */
async function hybridChunkWithMeta(text) {
  const base = recursiveChunkWithMeta(text, {
    maxChars: 1500,
    overlap: 200,
  });

  const merged = [];
  let current = base[0];

  for (let i = 1; i < base.length; i++) {
    const next = base[i];
    if (
      current.chunk_text.length + next.chunk_text.length <
      1800
    ) {
      current = {
        ...current,
        chunk_text: current.chunk_text + " " + next.chunk_text,
        char_end: next.char_end,
        chunk_type: "hybrid",
      };
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);

  return merged.map((c, i) => ({
    ...c,
    chunk_index: i,
    chunk_type: "hybrid",
  }));
}

/* -------------------- Core Processor -------------------- */

async function processPdfBufferAndInsert(
  fileBuffer,
  documentId,
  filePathForLog = null
) {
  const embedder = await embedderPromise;

  try {
    const pdfData = await parsePdf(fileBuffer);

    console.log("Pages:", pdfData.numpages);
    console.log("Text length:", pdfData.text.length);

    const docType = classifyDocument(pdfData.text, {
      pages: pdfData.numpages,
    });

    console.log("Document type:", docType);

    let chunksWithMeta;
    if (docType === "short_structured" || docType === "resume") {
      chunksWithMeta = paragraphChunkWithMeta(pdfData.text);
    } else {
      chunksWithMeta = await hybridChunkWithMeta(pdfData.text);
    }

    console.log(
      `${chunksWithMeta.length} chunks created for document ${documentId}`
    );

    for (const chunk of chunksWithMeta) {
      const embedding = await embedder(chunk.chunk_text, {
        pooling: "mean",
        normalize: true,
      });

      const { error } = await supabase.from("chunks").insert({
        document_id: documentId,
        chunk_text: chunk.chunk_text,
        embedding: Array.from(embedding.data),
        token_count: chunk.chunk_text.split(/\s+/).length,

        chunk_index: chunk.chunk_index,
        chunk_type: chunk.chunk_type,
        char_start: chunk.char_start,
        char_end: chunk.char_end,
      });

      if (error) console.error("Insert error:", error);
    }

    console.log(`Finished document ${documentId}`);
  } catch (err) {
    console.error(
      "PDF processing error for",
      filePathForLog || documentId,
      ":",
      err?.message || err
    );
  }
}

/* -------------------- BullMQ Worker -------------------- */

if (redisReady && connection) {
  new Worker(
    "pdf-processing",
    async (job) => {
      const { filePath, documentId } = job.data;

      if (!filePath || !fs.existsSync(filePath)) {
        console.error("File not found:", filePath);
        return;
      }

      console.log("Processing PDF (worker):", filePath);
      const buffer = fs.readFileSync(filePath);
      await processPdfBufferAndInsert(buffer, documentId, filePath);
    },
    { connection }
  );

  console.log("BullMQ worker running...");
}

/* -------------------- Poller Fallback -------------------- */

if (!redisReady) {
  console.warn("Starting poller (30s interval)");

  async function pollAndProcess() {
    try {
      const { data: docs } = await supabase
        .from("documents")
        .select("id, storage_path")
        .order("created_at", { ascending: false })
        .limit(20);

      for (const doc of docs || []) {
        const { data: existing } = await supabase
          .from("chunks")
          .select("id")
          .eq("document_id", doc.id)
          .limit(1);

        if (existing?.length) continue;

        const { data: urlData } = await supabase.storage
          .from("documents")
          .createSignedUrl(doc.storage_path, 60);

        if (!urlData?.signedURL) continue;

        const resp = await fetch(urlData.signedURL);
        if (!resp.ok) continue;

        const buffer = Buffer.from(await resp.arrayBuffer());
        console.log("Processing PDF (poller):", doc.storage_path);

        await processPdfBufferAndInsert(
          buffer,
          doc.id,
          doc.storage_path
        );
      }
    } catch (e) {
      console.error("Poller error:", e?.message || e);
    }
  }

  pollAndProcess();
  setInterval(pollAndProcess, 30_000);
}

console.log("Worker started and ready");
