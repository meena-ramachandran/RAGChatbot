# Modern Secure RAG System

This repository contains a Retrieval-Augmented Generation (RAG) platform built with Next.js, Supabase, pgvector, and Gemini/OpenAI models. It features semantic chunking, metadata enrichment, hybrid retrieval, reranking, context compression, token-aware context assembly, output guardrails, multi-tenant isolation, and prompt injection defense.

## Architecture & Data Flow

```
                      +-------------------+
                      |   User Question   |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |  Injection Filter |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |  Query Rewriter   |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      | Hybrid Retrieval  | <---+ Full-text (Postgres GIN)
                      +---------+---------+ <---+ Vector (pgvector ivfflat)
                                |
                                v
                      +-------------------+
                      |  Rerank & Compress|
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |  LLM Generation   |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |  Guardrail Score  |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |   Cited Response  |
                      +-------------------+
```

### Document Ingestion
1. **Extraction**: Uploaded PDFs are parsed.
2. **Redaction**: PII and sensitive data are redacted.
3. **Semantic Chunking**: Sentences are grouped using embedding similarity thresholds instead of fixed-length windows.
4. **Metadata & Embedding**: Generates summaries, headings, and vectors (via Xenova Transformers) which are stored in Supabase PostgreSQL database tables.

### Query Ingestion & Retrieval
1. **Security Checks**: Query sanitization and prompt injection heuristic check.
2. **Expansion**: The system rewrites queries for improved keyword and vector coverage.
3. **Hybrid Search**: Performs parallel vector cosine search and full-text keyword indexing.
4. **Context Optimization**: Reranked using semantic relevance, compressed within token budgets, and submitted to the LLM.
5. **Output Filtering**: Response is checked for hallucinations (faithfulness scoring) and citations are attached.

## Database Schema

### `documents`
- `id` (UUID): Primary key.
- `user_id` (UUID): Owner identification for multi-tenant isolation.
- `file_name` (Text): Name of document.
- `storage_path` (Text): Link to file bucket.
- `file_hash` (Text): File verification hash.
- `created_at` (Timestamp).

### `document_chunks`
- `id` (UUID): Primary key.
- `document_id` (UUID): Reference to parent document.
- `text_content` (Text): Raw chunk content.
- `summary` (Text): Summarized chunk overview.
- `heading` (Text): Related document heading.
- `keywords` (Text[]): Ingested metadata keywords.
- `token_count` (Int): Token size estimation.
- `embedding` (Vector): Vector representation for cosine search.
- `fts` (tsvector): Full-text search index vector.

## Getting Started

### Prerequisites

Ensure you have a running PostgreSQL database with `pgvector` enabled:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Environment Variables

Configure a `.env` file in the root directory:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
DATABASE_URL=your_postgres_db_url
REDIS_URL=your_redis_url
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_gemini_key
OPENAI_API_KEY=your_openai_key
```

### Installation

1. Install Node.js dependencies:
   ```bash
   npm install
   ```

2. Run database migration scripts to establish indices:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding 
     ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

   CREATE INDEX IF NOT EXISTS idx_document_chunks_fts 
     ON document_chunks USING GIN(fts);
   ```

3. Run the worker pipeline for processing PDF uploads:
   ```bash
   node workers/pdfWorker.js
   ```

4. Start the Next.js development server:
   ```bash
   npm run dev
   ```

## API Specifications

- `POST /api/upload`: Receives and processes files.
- `POST /api/chat`: Processes user queries, retrieves context, and returns cited responses.
- `POST /api/auth/register` / `POST /api/auth/login`: Handles account credentials and security roles.
