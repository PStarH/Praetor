/**
 * knowledgeStore — Enterprise knowledge-base persistence layer for RAG.
 *
 * Enterprise users' #1 need: let Agents retrieve internal company documents.
 * This store ingests raw documents (text/plain, application/json, text/markdown,
 * text/html), chunks them, embeds the chunks, and provides semantic search so
 * an Agent can pull relevant context before answering.
 *
 * Storage layout (under `.commander/knowledge-base/`):
 *   documents.json          — document metadata array
 *   chunks/<docId>.ndjson   — one JSON chunk per line (text + embedding)
 *   index.json              — global manifest of chunkId → { docId, chunkIndex }
 *
 * Embeddings use a zero-dependency hashing-trick LocalEmbeddingFunction (copied
 * from packages/core/src/runtime/embedding.ts so we do not depend on the core
 * build output, and because LocalEmbeddingFunction is not re-exported from
 * `@praetor/core`). This means NO OpenAI API key is required.
 *
 * Evidence:
 * - Feature hashing is the standard free approximate-similarity approach
 *   (Weinberger et al., 2009); used by Vowpal Wabbit / Facebook / Criteo.
 * - Quality is ~70-80% of real embeddings for near-exact retrieval, which is
 *   sufficient for keyword-overlapping enterprise docs and avoids the cost /
 *   privacy concerns of sending internal docs to an external API.
 */
import { reportSilentFailure } from '@praetor/core';
import { tenantPathSegment, validateTenantId } from '@praetor/core/runtime/tenantContext';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { removeHtmlElement, stripAngleSpans, stripHtmlComments } from './htmlStrip';

// ── Types ────────────────────────────────────────────────────────────────

export type KnowledgeDocumentStatus = 'ready' | 'indexing' | 'failed';

export type SupportedContentType =
  'text/plain' | 'application/json' | 'text/markdown' | 'text/html';

export const SUPPORTED_CONTENT_TYPES: SupportedContentType[] = [
  'text/plain',
  'application/json',
  'text/markdown',
  'text/html',
];

export interface KnowledgeDocument {
  id: string;
  name: string;
  type: SupportedContentType;
  size: number;
  chunks: number;
  status: KnowledgeDocumentStatus;
  createdAt: string;
  updatedAt: string;
  /** Optional free-form tags / source hint supplied by the uploader. */
  tags?: string[];
  /** Last error message when status === 'failed'. */
  error?: string;
}

export interface KnowledgeChunkMetadata {
  docId: string;
  docName: string;
  chunkIndex: number;
  /** Character offset of the chunk within the original document text. */
  offset: number;
  /** Character length of the chunk. */
  length: number;
}

export interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  offset: number;
  length: number;
  text: string;
  embedding: number[];
}

export interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  docName: string;
  chunkIndex: number;
  offset: number;
  text: string;
  /** Cosine similarity in [-1, 1]; higher is more relevant. */
  score: number;
}

export interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  embeddingDimension: number;
  /** Breakdown of documents by content type. */
  byType: Record<string, number>;
}

export interface KnowledgeListOptions {
  page?: number;
  limit?: number;
}

export interface KnowledgeListResult {
  documents: KnowledgeDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface KnowledgeSearchOptions {
  query: string;
  topK?: number;
  /** Restrict search to a subset of documents. */
  docIds?: string[];
}

export interface KnowledgeRagContext {
  query: string;
  context: string;
  chunks: KnowledgeSearchResult[];
  topK: number;
}

// ── Embedding (copied from core so we stay build-output-independent) ──────

/**
 * LocalEmbeddingFunction — zero-dependency, API-key-free embedding via the
 * hashing trick with n-gram shingling. Produces L2-normalized fixed-size
 * vectors so cosine similarity is a simple dot product.
 *
 * NOTE: This is a verbatim copy of the class in
 * `packages/core/src/runtime/embedding.ts`. We duplicate it here because the
 * class is not re-exported from the `@praetor/core` package entry point
 * (only `MockEmbeddingFunction` and `cosineSimilarity` are). Copying avoids a
 * hard dependency on the core build output and keeps the knowledge store fully
 * self-contained.
 */
class LocalEmbeddingFunction {
  readonly name = 'local-embedding';
  readonly dimension = 256;
  private readonly ngramSize: number;
  private readonly useTfIdf: boolean;

  constructor(config?: { ngramSize?: number; useTfIdf?: boolean }) {
    this.ngramSize = config?.ngramSize ?? 3;
    this.useTfIdf = config?.useTfIdf ?? true;
  }

  generate(text: string): number[] {
    const normalized = text.toLowerCase().trim();
    if (normalized.length < 5) {
      return this.simpleHashEmbedding(normalized);
    }

    const ngrams = this.extractNgrams(normalized);
    const vector = new Array(this.dimension).fill(0);
    for (const ngram of ngrams) {
      const hash = this.fnv1a(ngram);
      const pos = hash % this.dimension;
      const weight = this.useTfIdf ? 1.0 : 1.0;
      vector[pos] += weight;
    }

    // L2 normalize for cosine similarity compatibility
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimension; i++) {
        vector[i] /= norm;
      }
    }
    return vector;
  }

  private extractNgrams(text: string): string[] {
    const ngrams: string[] = [];
    const words = text
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, 2048);

    for (let n = 1; n <= Math.min(this.ngramSize, words.length); n++) {
      for (let i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(' '));
      }
    }

    const bounded = text.length > 8192 ? text.slice(0, 8192) : text;
    if (bounded.length > 10) {
      for (let i = 0; i <= bounded.length - 3; i++) {
        ngrams.push(bounded.slice(i, i + 3));
      }
    }
    return ngrams;
  }

  private simpleHashEmbedding(text: string): number[] {
    const hash = this.fnv1a(text);
    const result: number[] = new Array(this.dimension).fill(0);
    let seed = hash;
    for (let i = 0; i < this.dimension; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      result[i] = (seed % 2000) / 2000 - 0.5;
    }
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) norm += result[i] * result[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimension; i++) result[i] /= norm;
    return result;
  }

  private fnv1a(str: string): number {
    const bounded = str.length > 8192 ? str.slice(0, 8192) : str;
    let hash = 0x811c9dc5;
    for (const unit of bounded.split('')) {
      hash ^= unit.charCodeAt(0);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash;
  }
}

/** Cosine similarity for two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Chunking ─────────────────────────────────────────────────────────────

const CHUNK_MIN_CHARS = 500;
const CHUNK_MAX_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 100;

/**
 * Split text into retrieval-friendly chunks.
 *
 * Strategy: split on paragraph boundaries (blank lines), then greedily pack
 * paragraphs into chunks of [CHUNK_MIN_CHARS, CHUNK_MAX_CHARS]. A paragraph
 * longer than the max is hard-split at word boundaries. Successive chunks
 * overlap by CHUNK_OVERLAP_CHARS so retrieval can catch context that straddles
 * a boundary.
 */
export function chunkText(
  text: string,
  options?: { minChars?: number; maxChars?: number; overlap?: number },
): Array<{ text: string; offset: number }> {
  const minChars = options?.minChars ?? CHUNK_MIN_CHARS;
  const maxChars = options?.maxChars ?? CHUNK_MAX_CHARS;
  const overlap = options?.overlap ?? CHUNK_OVERLAP_CHARS;

  const clean = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  if (clean.length === 0) return [];

  // Split into paragraphs on blank lines; keep paragraph boundaries as part
  // of the text so offsets stay meaningful.
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  // First, expand any over-long paragraph into <=maxChars pieces (word-aware).
  const expanded: Array<{ text: string; offset: number }> = [];
  let cursor = 0; // absolute offset within `clean`
  for (const para of paragraphs) {
    // Locate the paragraph's start offset in `clean` (skipping the blank-line
    // separator that was consumed by the split). We search forward from cursor.
    const startIdx = clean.indexOf(para, cursor);
    const paraOffset = startIdx >= 0 ? startIdx : cursor;
    cursor = paraOffset + para.length;

    if (para.length <= maxChars) {
      expanded.push({ text: para, offset: paraOffset });
    } else {
      // Hard-split long paragraph at word boundaries.
      let i = 0;
      while (i < para.length) {
        let end = Math.min(i + maxChars, para.length);
        if (end < para.length) {
          // Walk back to the last space to avoid splitting words.
          const lastSpace = para.lastIndexOf(' ', end);
          if (lastSpace > i + minChars) end = lastSpace;
        }
        const piece = para.slice(i, end).trim();
        if (piece.length > 0) {
          expanded.push({ text: piece, offset: paraOffset + i });
        }
        i = end;
      }
    }
  }

  // Greedily pack pieces into chunks within [minChars, maxChars].
  const chunks: Array<{ text: string; offset: number }> = [];
  let buffer = '';
  let bufferOffset = 0;
  const flush = (): void => {
    if (buffer.length > 0) {
      chunks.push({ text: buffer, offset: bufferOffset });
      buffer = '';
    }
  };

  for (const piece of expanded) {
    if (buffer.length === 0) {
      buffer = piece.text;
      bufferOffset = piece.offset;
    } else if (buffer.length + 1 + piece.text.length <= maxChars) {
      buffer += '\n\n' + piece.text;
    } else {
      flush();
      // Carry overlap from the previous chunk for context continuity.
      const prev = chunks.length > 0 ? chunks[chunks.length - 1].text : '';
      const tail = prev.length > overlap ? prev.slice(prev.length - overlap) : prev;
      buffer = (tail ? tail + '\n\n' : '') + piece.text;
      bufferOffset = piece.offset;
    }
  }
  flush();

  return chunks;
}

function stripHtmlDocument(value: string): string {
  let text = value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
  text = stripHtmlComments(text);
  text = removeHtmlElement(text, 'script');
  text = removeHtmlElement(text, 'style');
  return stripAngleSpans(text);
}

// ── Plain-text extraction ────────────────────────────────────────────────

/**
 * Convert a raw document body of a given content type into plain text suitable
 * for chunking + embedding.
 *
 * - text/plain: returned as-is.
 * - text/markdown: returned as-is (markdown is already human-readable text;
 *   stripping syntax would harm retrieval of code fences / headings).
 * - application/json: pretty-printed so structure is preserved.
 * - text/html: tags + scripts/styles stripped to plain text.
 */
export function extractPlainText(content: string, type: SupportedContentType): string {
  switch (type) {
    case 'text/plain':
    case 'text/markdown':
      return content;
    case 'application/json': {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // Not valid JSON — fall back to raw content so it is still searchable.
        return content;
      }
    }
    case 'text/html': {
      return stripHtmlDocument(content)
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    default:
      return content;
  }
}

/** Coerce an arbitrary content-type string into our supported enum. */
export function normalizeContentType(raw: string): SupportedContentType {
  const lower = (raw || '').toLowerCase().split(';')[0].trim();
  if (lower === 'application/json') return 'application/json';
  if (lower === 'text/markdown' || lower === 'text/x-markdown') return 'text/markdown';
  if (lower === 'text/html') return 'text/html';
  // Default to plain text for anything else (text/plain, unknown, etc.)
  return 'text/plain';
}

// ── Store ────────────────────────────────────────────────────────────────

interface IndexManifest {
  /** Embedding dimension (so consumers can validate vector shape). */
  dimension: number;
  /** chunkId → { docId, chunkIndex } for all chunks on disk. */
  chunks: Record<string, { docId: string; chunkIndex: number }>;
}

interface DocumentsFile {
  documents: KnowledgeDocument[];
}

const DEFAULT_DIMENSION = 256;

const DOCUMENT_STATUSES: KnowledgeDocumentStatus[] = ['ready', 'indexing', 'failed'];

/** Stable, non-leaking error codes for the HTTP boundary. */
export type KnowledgeStoreErrorCode =
  /** A metadata/chunk file exists but could not be read or parsed. */
  | 'KNOWLEDGE_STORE_UNAVAILABLE'
  /** Ingestion failed before the visibility commit; nothing was published. */
  | 'KNOWLEDGE_INGEST_FAILED';

/**
 * Typed store failure.
 *
 * LM-22 / AUDIT api-completion#API-C06: read errors used to be swallowed and
 * converted into an empty in-memory state, which the next write then persisted —
 * turning a transient EACCES/EIO/corrupt-JSON into permanent document loss. The
 * store now fails closed with a typed, client-safe code instead.
 */
export class KnowledgeStoreError extends Error {
  constructor(
    readonly code: KnowledgeStoreErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeStoreError';
  }
}

function isNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function isKnowledgeStoreError(err: unknown): err is KnowledgeStoreError {
  return err instanceof KnowledgeStoreError;
}

export class KnowledgeStore {
  private readonly baseDir: string;
  private readonly chunksDir: string;
  private readonly documentsPath: string;
  private readonly indexPath: string;
  private readonly embedder = new LocalEmbeddingFunction();
  private readonly dimension = DEFAULT_DIMENSION;

  // In-memory cache of all chunks (chunkId → chunk), lazily loaded.
  private cache: Map<string, KnowledgeChunk> | null = null;
  private documentsCache: KnowledgeDocument[] | null = null;
  private manifestCache: IndexManifest | null = null;
  private initPromise: Promise<void> | null = null;
  /**
   * Serialises mutations within this store instance.
   *
   * Without it, two concurrent `addDocument` calls each read index.json, each
   * add their own chunks, and the later write wins — silently dropping the
   * other document's index entries. This is an in-process guarantee only; it
   * does not make the file store safe across replicas.
   */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(baseDir?: string) {
    this.baseDir = path.resolve(
      baseDir ?? path.join(process.cwd(), '.commander', 'knowledge-base'),
    );
    this.chunksDir = path.join(this.baseDir, 'chunks');
    this.documentsPath = path.join(this.baseDir, 'documents.json');
    this.indexPath = path.join(this.baseDir, 'index.json');
  }

  /** Lazily ensure the storage directory tree exists. */
  private async ensureDirs(): Promise<void> {
    try {
      await fsp.mkdir(this.chunksDir, { recursive: true });
    } catch (err) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge store directory is unusable',
        err,
      );
    }
  }

  /**
   * Initialize the store: ensure directories exist and load metadata files.
   *
   * Safe to call multiple times. On failure the in-flight promise is cleared so
   * a caller can retry once the underlying problem is fixed — a poisoned
   * `initPromise` would otherwise pin the store to "empty" forever.
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const attempt = this.doInit();
    this.initPromise = attempt.catch((err: unknown) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await this.ensureDirs();
    await this.loadDocuments();
    await this.loadIndex();
  }

  // ── Persistence helpers ───────────────────────────────────────────────

  /**
   * Read + validate documents.json.
   *
   * Only a missing file (fresh store) yields an empty list. Any other failure —
   * EACCES/EIO, malformed JSON, wrong shape, duplicate ids — is raised: treating
   * it as "no documents" is what allowed the next write to overwrite the real
   * file with a single document.
   */
  private async loadDocuments(): Promise<KnowledgeDocument[]> {
    if (this.documentsCache) return this.documentsCache;
    let raw: string;
    try {
      raw = await fsp.readFile(this.documentsPath, 'utf-8');
    } catch (err) {
      if (isNotFoundError(err)) {
        this.documentsCache = [];
        return this.documentsCache;
      }
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge documents are unreadable',
        err,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge documents are corrupt',
        err,
      );
    }

    const documents = (parsed as DocumentsFile | null)?.documents;
    if (!Array.isArray(documents)) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge documents have an unexpected shape',
      );
    }
    const seenIds = new Set<string>();
    for (const candidate of documents) {
      const doc = candidate as Partial<KnowledgeDocument> | null;
      if (
        !doc ||
        typeof doc.id !== 'string' ||
        doc.id.length === 0 ||
        typeof doc.name !== 'string' ||
        !SUPPORTED_CONTENT_TYPES.includes(doc.type as SupportedContentType) ||
        !DOCUMENT_STATUSES.includes(doc.status as KnowledgeDocumentStatus)
      ) {
        throw new KnowledgeStoreError(
          'KNOWLEDGE_STORE_UNAVAILABLE',
          'Knowledge documents contain an invalid record',
        );
      }
      if (seenIds.has(doc.id)) {
        throw new KnowledgeStoreError(
          'KNOWLEDGE_STORE_UNAVAILABLE',
          'Knowledge documents contain a duplicate id',
        );
      }
      seenIds.add(doc.id);
    }

    this.documentsCache = documents.map((doc) => ({ ...doc }));
    return this.documentsCache;
  }

  /**
   * Durably write the document list, then publish it to the in-memory cache.
   * The cache is only replaced after the write succeeded, so a failed write can
   * never leave the process believing uncommitted data is visible.
   */
  private async commitDocuments(candidate: readonly KnowledgeDocument[]): Promise<void> {
    await this.ensureDirs();
    const payload: DocumentsFile = { documents: candidate.map((doc) => ({ ...doc })) };
    await this.atomicWrite(this.documentsPath, JSON.stringify(payload, null, 2));
    this.documentsCache = payload.documents;
  }

  /**
   * Read + validate index.json.
   *
   * Only a missing file yields an empty manifest. A corrupt or unreadable index
   * must not be replaced by an empty one: the next write would then persist a
   * manifest containing only its own chunks and orphan every other document.
   */
  private async loadIndex(): Promise<IndexManifest> {
    if (this.manifestCache) return this.manifestCache;
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexPath, 'utf-8');
    } catch (err) {
      if (isNotFoundError(err)) {
        this.manifestCache = { dimension: this.dimension, chunks: {} };
        return this.manifestCache;
      }
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge index is unreadable',
        err,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge index is corrupt',
        err,
      );
    }
    const manifest = parsed as IndexManifest | null;
    if (!manifest || typeof manifest !== 'object' || typeof manifest.chunks !== 'object') {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge index has an unexpected shape',
      );
    }
    this.manifestCache = {
      dimension: typeof manifest.dimension === 'number' ? manifest.dimension : this.dimension,
      chunks: { ...manifest.chunks },
    };
    return this.manifestCache;
  }

  /** Durably write the manifest, then publish it to the in-memory cache. */
  private async persistIndex(manifest: IndexManifest): Promise<void> {
    await this.ensureDirs();
    const payload: IndexManifest = {
      dimension: manifest.dimension,
      chunks: { ...manifest.chunks },
    };
    await this.atomicWrite(this.indexPath, JSON.stringify(payload, null, 2));
    this.manifestCache = payload;
  }

  /** Atomic write via temp file + rename to avoid torn reads. */
  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
    await fsp.writeFile(tmp, data, 'utf-8');
    await fsp.rename(tmp, filePath);
  }

  private chunkFilePath(docId: string): string {
    const name = path.basename(docId);
    if (name !== docId || name.length === 0 || name === '.' || name === '..') {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Document id is not a single path segment',
      );
    }
    const root = path.resolve(this.chunksDir);
    const resolved = path.resolve(root, `${name}.ndjson`);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (!resolved.startsWith(prefix)) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Document id escapes the chunk directory',
      );
    }
    return resolved;
  }

  /**
   * Load all chunks from disk into the in-memory cache.
   *
   * A partial read must not be published as a complete cache: a missing chunk
   * directory entry or an unparsable NDJSON line means we cannot tell the caller
   * what the knowledge base actually contains, so we fail closed instead of
   * serving a silently truncated index.
   */
  private async loadCache(): Promise<Map<string, KnowledgeChunk>> {
    if (this.cache) return this.cache;
    await this.ensureDirs();
    const cache = new Map<string, KnowledgeChunk>();
    const documents = await this.loadDocuments();
    const documentIds = new Set(documents.map((doc) => doc.id));
    const manifest = await this.loadIndex();
    let files: string[];
    try {
      files = await fsp.readdir(this.chunksDir);
    } catch (err) {
      throw new KnowledgeStoreError(
        'KNOWLEDGE_STORE_UNAVAILABLE',
        'Knowledge chunk directory is unreadable',
        err,
      );
    }
    for (const file of files) {
      if (!file.endsWith('.ndjson')) continue;
      const filePath = path.join(this.chunksDir, file);
      let raw: string;
      try {
        raw = (await fsp.readFile(filePath, 'utf-8')).trim();
      } catch (err) {
        throw new KnowledgeStoreError(
          'KNOWLEDGE_STORE_UNAVAILABLE',
          'Knowledge chunk file is unreadable',
          err,
        );
      }
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let chunk: KnowledgeChunk;
        try {
          chunk = JSON.parse(line) as KnowledgeChunk;
        } catch (err) {
          throw new KnowledgeStoreError(
            'KNOWLEDGE_STORE_UNAVAILABLE',
            'Knowledge chunk file is corrupt',
            err,
          );
        }
        if (
          !chunk ||
          typeof chunk.chunkId !== 'string' ||
          chunk.chunkId.length === 0 ||
          typeof chunk.docId !== 'string' ||
          !documentIds.has(chunk.docId) ||
          !Number.isInteger(chunk.chunkIndex) ||
          chunk.chunkIndex < 0 ||
          !Number.isInteger(chunk.offset) ||
          chunk.offset < 0 ||
          !Number.isInteger(chunk.length) ||
          chunk.length < 0 ||
          typeof chunk.text !== 'string' ||
          !Array.isArray(chunk.embedding) ||
          chunk.embedding.length !== this.dimension ||
          chunk.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
          throw new KnowledgeStoreError(
            'KNOWLEDGE_STORE_UNAVAILABLE',
            'Knowledge chunk contains an invalid record',
          );
        }
        const indexed = manifest.chunks[chunk.chunkId];
        if (!indexed || indexed.docId !== chunk.docId || indexed.chunkIndex !== chunk.chunkIndex) {
          throw new KnowledgeStoreError(
            'KNOWLEDGE_STORE_UNAVAILABLE',
            'Knowledge chunk is not bound to the index manifest',
          );
        }
        if (cache.has(chunk.chunkId)) {
          throw new KnowledgeStoreError(
            'KNOWLEDGE_STORE_UNAVAILABLE',
            'Knowledge chunk id is duplicated',
          );
        }
        cache.set(chunk.chunkId, chunk);
      }
    }
    for (const [chunkId, indexed] of Object.entries(manifest.chunks)) {
      const chunk = cache.get(chunkId);
      if (!chunk || chunk.docId !== indexed.docId || chunk.chunkIndex !== indexed.chunkIndex) {
        throw new KnowledgeStoreError(
          'KNOWLEDGE_STORE_UNAVAILABLE',
          'Knowledge index references a missing or mismatched chunk',
        );
      }
    }
    this.cache = cache;
    return cache;
  }

  /** Serialise mutations so concurrent writers cannot lose each other's updates. */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Add a document: extract plain text, chunk, embed, and persist.
   *
   * Commit order (LM-22):
   *   1. stage the chunk file,
   *   2. persist the index manifest,
   *   3. commit `documents.json` with `status: 'ready'` — this is the single
   *      visibility commit point,
   *   4. only then publish the chunks into the search cache.
   *
   * A failure in 1–2 leaves `documents.json` untouched (the document is simply
   * not visible) and removes the staged chunk file. Throwing — rather than
   * returning a `failed` document — is deliberate: a persisted `failed` record
   * would still be a visible document whose chunks were never committed.
   */
  async addDocument(params: {
    name: string;
    type: SupportedContentType;
    content: string;
    tags?: string[];
  }): Promise<KnowledgeDocument> {
    return this.enqueueMutation(async () => {
      await this.init();
      const { name, type, content, tags } = params;
      const docId = uuidv4();
      const now = new Date().toISOString();

      const doc: KnowledgeDocument = {
        id: docId,
        name: name.slice(0, 256) || 'untitled',
        type,
        size: Buffer.byteLength(content, 'utf-8'),
        chunks: 0,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
        tags: tags && tags.length > 0 ? tags.slice(0, 20) : undefined,
      };

      const docs = await this.loadDocuments();

      let chunks: KnowledgeChunk[] = [];
      try {
        const plainText = extractPlainText(content, type);
        const pieces = chunkText(plainText);
        chunks = pieces.map((piece, idx) => ({
          chunkId: uuidv4(),
          docId,
          chunkIndex: idx,
          offset: piece.offset,
          length: piece.text.length,
          text: piece.text,
          embedding: this.embedder.generate(piece.text),
        }));

        if (chunks.length > 0) {
          // Persist chunks as ndjson (one JSON object per line).
          const ndjson = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
          await this.ensureDirs();
          await this.atomicWrite(this.chunkFilePath(docId), ndjson);

          const manifest = await this.loadIndex();
          const nextManifest: IndexManifest = {
            dimension: this.dimension,
            chunks: { ...manifest.chunks },
          };
          for (const c of chunks) {
            nextManifest.chunks[c.chunkId] = { docId, chunkIndex: c.chunkIndex };
          }
          await this.persistIndex(nextManifest);
        }
      } catch (err) {
        // Nothing was published: the document is not in documents.json. Remove
        // the staged chunk file so it cannot be mistaken for committed content.
        await fsp.unlink(this.chunkFilePath(docId)).catch(() => undefined);
        reportSilentFailure(err, 'knowledgeStore:addDocument');
        throw new KnowledgeStoreError('KNOWLEDGE_INGEST_FAILED', 'Document indexing failed', err);
      }

      // Visibility commit. Until this succeeds the document does not exist.
      doc.chunks = chunks.length;
      doc.updatedAt = new Date().toISOString();
      await this.commitDocuments([...docs, doc]);

      // Publish to the search cache only after the durable commit.
      if (chunks.length > 0) {
        const cache = await this.loadCache();
        for (const c of chunks) cache.set(c.chunkId, c);
      }
      return { ...doc };
    });
  }

  /** Get a single document's metadata by id. */
  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    await this.init();
    const docs = await this.loadDocuments();
    return docs.find((d) => d.id === id) ?? null;
  }

  /** List documents with simple page/limit pagination. */
  async listDocuments(options?: KnowledgeListOptions): Promise<KnowledgeListResult> {
    await this.init();
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const docs = await this.loadDocuments();
    // Newest first — enterprise users typically want to see recent uploads.
    const sorted = [...docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = (page - 1) * limit;
    const slice = sorted.slice(start, start + limit);
    return { documents: slice.map((doc) => ({ ...doc })), total: docs.length, page, limit };
  }

  /**
   * Delete a document and all of its chunks.
   *
   * Commit order (LM-22): `documents.json` is committed first without the id —
   * from that moment the document is gone and cannot be retrieved. Chunk/index
   * cleanup runs afterwards; if cleanup fails the deletion still stands and the
   * incomplete cleanup is reported, rather than pretending nothing happened or
   * restoring the document.
   */
  async deleteDocument(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.init();
      const docs = await this.loadDocuments();
      if (!docs.some((doc) => doc.id === id)) return false;
      this.chunkFilePath(id);

      await this.commitDocuments(docs.filter((doc) => doc.id !== id));

      const cleanupFailures: string[] = [];

      try {
        await fsp.unlink(this.chunkFilePath(id));
      } catch (err) {
        if (!isNotFoundError(err)) cleanupFailures.push('chunk-file');
      }

      const removedChunkIds: string[] = [];
      try {
        const manifest = await this.loadIndex();
        const nextManifest: IndexManifest = {
          dimension: this.dimension,
          chunks: { ...manifest.chunks },
        };
        for (const [chunkId, entry] of Object.entries(nextManifest.chunks)) {
          if (entry.docId === id) {
            delete nextManifest.chunks[chunkId];
            removedChunkIds.push(chunkId);
          }
        }
        await this.persistIndex(nextManifest);
      } catch (err) {
        cleanupFailures.push('index-manifest');
      }

      try {
        const cache = await this.loadCache();
        for (const chunkId of removedChunkIds) cache.delete(chunkId);
      } catch {
        // The cache was not published; nothing to correct in memory.
      }

      if (cleanupFailures.length > 0) {
        reportSilentFailure(
          new Error(
            `knowledge document ${id} committed as deleted but post-commit cleanup was incomplete: ${cleanupFailures.join(', ')}`,
          ),
          'knowledgeStore:deleteDocument:cleanup',
        );
      }
      return true;
    });
  }

  /**
   * Semantic search: embed the query and return the top-K most similar chunks
   * (cosine similarity). Optionally restrict to a subset of docIds.
   */
  async search(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]> {
    await this.init();
    const query = options.query?.trim() ?? '';
    if (!query) return [];
    const topK = Math.min(50, Math.max(1, options.topK ?? 5));
    const docIdFilter =
      options.docIds && options.docIds.length > 0 ? new Set(options.docIds) : null;

    const cache = await this.loadCache();
    if (cache.size === 0) return [];

    const queryVec = this.embedder.generate(query);
    const docs = await this.loadDocuments();
    const docNameById = new Map(docs.map((d) => [d.id, d.name]));

    const scored: KnowledgeSearchResult[] = [];
    for (const chunk of cache.values()) {
      if (docIdFilter && !docIdFilter.has(chunk.docId)) continue;
      // Skip chunks whose document no longer exists (defensive).
      if (!docNameById.has(chunk.docId)) continue;
      const score = cosineSimilarity(queryVec, chunk.embedding);
      scored.push({
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        docName: docNameById.get(chunk.docId) ?? '',
        chunkIndex: chunk.chunkIndex,
        offset: chunk.offset,
        text: chunk.text,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * RAG query: run a semantic search, then assemble a context string ready to
   * be injected into an LLM prompt. Chunks are numbered and attributed to
   * their source document so the model can cite sources.
   */
  async query(options: KnowledgeSearchOptions): Promise<KnowledgeRagContext> {
    const topK = Math.min(50, Math.max(1, options.topK ?? 5));
    const results = await this.search({ ...options, topK });

    const parts: string[] = [];
    parts.push(`Found ${results.length} relevant knowledge chunk(s) for query: "${options.query}"`);
    parts.push('');
    results.forEach((r, i) => {
      parts.push(
        `--- [${i + 1}] Source: ${r.docName} (chunk ${r.chunkIndex + 1}, score ${r.score.toFixed(3)}) ---`,
      );
      parts.push(r.text);
      parts.push('');
    });

    return {
      query: options.query,
      context: parts.join('\n'),
      chunks: results,
      topK,
    };
  }

  /** Aggregate statistics for the dashboard. */
  async stats(): Promise<KnowledgeStats> {
    await this.init();
    const docs = await this.loadDocuments();
    const cache = await this.loadCache();
    const byType: Record<string, number> = {};
    let totalSize = 0;
    for (const d of docs) {
      byType[d.type] = (byType[d.type] ?? 0) + 1;
      totalSize += d.size;
    }
    return {
      documentCount: docs.length,
      chunkCount: cache.size,
      totalSizeBytes: totalSize,
      embeddingDimension: this.dimension,
      byType,
    };
  }
}

// ── Singleton accessor (mirrors other stores in the API) ─────────────────

let singleton: KnowledgeStore | null = null;
const tenantStores = new Map<string, KnowledgeStore>();

/**
 * Return a single-tenant store when no id is supplied, or an isolated store
 * rooted below the requested tenant when called at an authenticated boundary.
 */
export function getKnowledgeStore(tenantId?: string): KnowledgeStore {
  if (tenantId === undefined) {
    if (!singleton) singleton = new KnowledgeStore();
    return singleton;
  }

  validateTenantId(tenantId);
  const existing = tenantStores.get(tenantId);
  if (existing) return existing;

  const baseDir = path.join(
    path.resolve(process.cwd(), '.commander', 'knowledge-base'),
    tenantPathSegment(tenantId),
  );
  const store = new KnowledgeStore(baseDir);
  tenantStores.set(tenantId, store);
  return store;
}

// Export helpers for unit testing / reuse by the endpoints module.
export { LocalEmbeddingFunction };

// Allow callers to override the storage dir (used by tests). Not exported via
// the singleton; construct `new KnowledgeStore(dir)` directly to override.
export function _resetKnowledgeStoreSingletonForTests(): void {
  singleton = null;
  tenantStores.clear();
}
