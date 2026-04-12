# Architecture Guide

Technical architecture overview of the Document Q&A Assistant, including system design, component interactions, and algorithmic details.

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Architecture](#component-architecture)
3. [Data Flow](#data-flow)
4. [RAG Pipeline](#rag-pipeline)
5. [Search Algorithms](#search-algorithms)
6. [Memory Management](#memory-management)
7. [Concurrency Model](#concurrency-model)
8. [Extensibility](#extensibility)

## System Overview

### High-Level Design

The Document Q&A Assistant follows the **Retrieval-Augmented Generation (RAG)** pattern:

```
User Question → Query Processing → Retrieval → Context Assembly → LLM Generation → Answer
```

### Design Goals

1. **Offline-First**: All processing happens locally
2. **Hardware-Agnostic**: Works on any x64 Windows machine
3. **Modular**: Components can be replaced or extended
4. **Performance**: Optimized for CPU-only deployment
5. **Accuracy**: Hybrid search with RRF fusion

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Document Processing | Python (pdfplumber, python-docx, pypdf fallback) | Text extraction |
| Vector Store | ChromaDB | Semantic search |
| Keyword Search | rank-bm25 | BM25 indexing |
| Fusion | Custom RRF | Combine search results |
| LLM Interface | llama-cpp-python | GGUF inference |
| RAG Engine | Custom Python | Orchestration |
| GUI | CustomTkinter | User interface |
| API | FastAPI | REST interface |

## Component Architecture

### Module Structure

```
doc_qa_app/
├── main.py                    # Application entry point
├── app_gui.py                 # GUI implementation
├── api_server.py              # REST API server
├── rag_engine.py              # RAG orchestration
├── document_processor.py      # Document extraction
├── vector_store.py            # Vector + BM25 search
├── llm_interface.py           # LLM backends
├── reranking.py               # Cross-encoder reranking
├── query_transformer.py       # Query transformation
├── app_paths.py               # Path management
├── engine_factory.py          # Engine creation
├── utils.py                   # Utilities (RRF)
├── scripts/                   # Build and utility scripts
└── tests/                     # Test suite
```

### Component Responsibilities

#### DocumentProcessor
- **Input**: File paths (PDF, DOCX, PPTX, TXT, MD)
- **Output**: List of DocumentChunk objects
- **Key Methods**:
  - `extract_document()`: Extract text from any format
  - `chunk_text()`: Semantic chunking with boundaries

#### VectorStore
- **Input**: DocumentChunk objects
- **Output**: Search results with metadata
- **Key Methods**:
  - `add_chunks()`: Index and embed documents
  - `search()`: Vector similarity search
  - `get_context()`: Hybrid search with RRF
  - `get_chunks_by_source()`: Fetch related chunks

#### LLMInterface
- **Input**: Prompts
- **Output**: Generated text
- **Backends**:
  - GGUFBackend: CPU-only inference
  - OpenVINOLLM: Intel acceleration
  - OllamaLLM: Local LLM runtime
  - OpenAICompatibleLLM: External API

#### RAGEngine
- **Input**: User questions
- **Output**: QueryResult objects
- **Orchestration**:
  - Query processing
  - Retrieval
  - Context assembly
  - Answer generation

## Data Flow

### Query Processing Flow

```
User Question
    ↓
[Step 1] Query Processing
    ├─→ Check for greetings (direct response)
    ├─→ Check for general questions (more context)
    └─→ Transform query (optional)
    ↓
[Step 2] Retrieval
    ├─→ Hybrid Search (BM25 + Vector + RRF)
    ├─→ Window Expansion
    └─→ Reranking (optional)
    ↓
[Step 3] Context Assembly
    ├─→ Filter by similarity threshold
    ├─→ Truncate to safe size
    └─→ Format as prompt
    ↓
[Step 4] LLM Generation
    ├─→ Build RAG prompt
    ├─→ Generate response
    └─→ Format answer with sources
    ↓
Answer + Sources
```

### Ingestion Flow

```
Document Directory
    ↓
[Step 1] Scan & Extract
    ├─→ Identify supported files
    └─→ Extract text (pdfplumber, python-docx)
    ↓
[Step 2] Clean & Normalize
    ├─→ Remove extra whitespace
    ├─→ Normalize line breaks
    └─→ Strip whitespace
    ↓
[Step 3] Semantic Chunking
    ├─→ Split on paragraph boundaries
    ├─→ Split sentences within paragraphs
    ├─→ Respect word count limits
    └─→ Create overlaps
    ↓
[Step 4] Embedding
    ├─→ Encode each chunk
    ├─→ Generate embeddings
    └─→ Store in ChromaDB
    ↓
[Step 5] BM25 Indexing
    ├─→ Tokenize chunks
    ├─→ Build index
    └─→ Store for keyword search
    ↓
Indexed Documents
```

## RAG Pipeline

### Configuration Model

```python
@dataclass
class RAGConfig:
    # Document processing
    chunk_size: int = 512
    chunk_overlap: int = 50

    # Retrieval
    n_results: int = 3
    min_similarity: float = 0.3
    retrieval_window: int = 1

    # Search
    hybrid_search: bool = True
    initial_retrieval_top_k: int = 20

    # Reranking
    reranking_enabled: bool = True
    reranker_model: str = "cross-encoder/ms-marco-TinyBERT-L-2"

    # Query transformation
    query_transformation_enabled: bool = False

    # Generation
    max_tokens: int = 1024
    temperature: float = 0.3
```

### Pipeline Execution

#### Phase 1: Query Processing

**Greeting Detection**:
```python
greeting_keywords = {'hello', 'hi', 'hey', ...}
if len(words) <= 3 and any(keyword in question):
    return direct_response()
```

**General Question Detection**:
```python
general_keywords = {'what', 'information', 'have', ...}
if len(words) <= 8 and any(keyword in question):
    return more_context()
```

**Query Transformation** (Optional):
```python
if query_transformation_enabled:
    query = transformer.transform_step_back(question)
```

#### Phase 2: Retrieval

**Hybrid Search**:
```python
if hybrid_search:
    # Vector search
    vector_results = vector_store.search(query, n_results=20)

    # BM25 search
    bm25_results = bm25_index.search(query, top_k=20)

    # RRF fusion
    fused = rrf_fuse([vector_results, bm25_results])

    # Get top N
    top_n = fused[:n_results]
else:
    # Pure vector search
    top_n = vector_store.search(query, n_results=n_results)
```

**Window Expansion**:
```python
if retrieval_window > 0:
    for chunk in top_n:
        expanded = vector_store.get_chunks_by_source(chunk.source)
        expanded = filter_adjacent(expanded, chunk, window)
        top_n.extend(expanded)
    top_n = deduplicate(top_n)
```

**Reranking** (Enabled by default):
```python
if reranking_enabled:
    # Split combined context string back into individual chunks
    chunk_texts = context.split("\n\n---\n\n")
    rerank_chunks = [DocumentChunk(text=t.strip(), source=source, chunk_index=i)
                     for i, t in enumerate(chunk_texts) if t.strip()]
    reranked = reranker.rerank(question, rerank_chunks, top_k=n_results)
    context = "\n\n---\n\n".join(c.text for c, _ in reranked)
    sources = list(dict.fromkeys(c.source for c, _ in reranked))
```

#### Phase 3: Context Assembly

```python
# Filter by similarity
context_chunks = [c for c in top_n if c.similarity >= min_similarity]

# Truncate to safe size
context = "\n\n---\n\n".join(c.text for c in context_chunks)
context = context[:max_context_length]

# Extract sources
sources = list(set(c.source for c in context_chunks))
```

#### Phase 4: Generation

```python
# Build RAG prompt
prompt = f"""
You are a helpful assistant that answers questions based on the provided context.
Answer the question using ONLY the information in the context below.
If the context doesn't contain enough information to answer, say "I don't have enough information..."

Context from documents:
{context}

Sources: {', '.join(sources)}

Question: {question}

Answer:
"""

# Generate response
response = llm.generate(prompt, config)
```

## Search Algorithms

### Vector Search (ChromaDB)

**Algorithm**: Approximate Nearest Neighbor (ANN)

**Parameters**:
- Distance metric: Cosine similarity
- Index type: HNSW (Hierarchical Navigable Small World)
- Dimension: 384 (for bge-small-en-v1.5)

**Process**:
1. Embed query: `query_embedding = embedder.encode_single(query)`
2. Query index: `results = collection.query(...)`
3. Convert distance to similarity: `similarity = 1 - distance`
4. Filter and sort: `results.sort(key=lambda x: x.similarity, reverse=True)`

**Time Complexity**: O(log N) for HNSW

### BM25 Search

**Algorithm**: BM25 (Best Matching 25)

**Parameters**:
- k1: 1.5 (term frequency saturation)
- b: 0.75 (document length normalization)
- idf: Inverse document frequency

**Process**:
1. Tokenize query: `tokens = query.split()`
2. Calculate scores: `scores = index.get_scores(tokens)`
3. Filter non-zero: `scores = [s for s in scores if s > 0]`
4. Sort by score: `scores.sort(reverse=True)`

**Time Complexity**: O(N) for scoring

### RRF Fusion

**Algorithm**: Reciprocal Rank Fusion

**Formula**:
```
RRF_score(doc_id, list) = Σ 1/(k + rank_in_list)
```

**Parameters**:
- k: 60 (default)

**Process**:
1. Initialize score dict
2. For each result list:
   - For each rank:
     - Add score: `score[doc_id] += 1/(k + rank)`
3. Sort by final score

**Time Complexity**: O(M * N) where M = number of lists, N = rank length

**Implementation**:
```python
def rrf_fuse(results_list, k=60):
    from collections import defaultdict
    rrf_scores = defaultdict(float)

    for results in results_list:
        for rank, (doc_id, _) in enumerate(results):
            rrf_scores[doc_id] += 1.0 / (k + rank + 1)

    return sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
```

### Window Expansion

**Algorithm**: Adjacent Chunk Retrieval

**Process**:
```python
def expand_chunks(chunks, window):
    expanded = []
    seen = set()

    for chunk in chunks:
        source_chunks = get_chunks_by_source(chunk.source)

        for source_chunk in source_chunks:
            if abs(source_chunk.chunk_index - chunk.chunk_index) <= window:
                chunk_id = f"{source_chunk.source}_{source_chunk.chunk_index}"
                if chunk_id not in seen:
                    expanded.append(source_chunk)
                    seen.add(chunk_id)

    expanded.sort(key=lambda c: (c.source, c.chunk_index))
    return expanded
```

**Benefits**:
- Context continuity
- Better for multi-part questions
- Improved answer quality

## Memory Management

### Data Structures

**DocumentChunk**:
```python
@dataclass
class DocumentChunk:
    text: str              # Chunk text
    source: str            # Source file
    page: Optional[int]    # Page number (if PDF)
    chunk_index: int       # Chunk number in source
```

**Vector Metadata**:
```python
{
    "source": "report.pdf",
    "chunk_index": 5,
    "page": 12
}
```

### Memory Optimization

**1. Chunking Strategy**:
- Small chunks (256 words) reduce memory per document
- Overlap preserves context between chunks

**2. Embedding Storage**:
- 384-dimensional vectors
- Float32 (4 bytes per value)
- ~1.5 KB per chunk

**3. BM25 Index**:
- In-memory list of tokenized text
- No embeddings stored
- Lightweight

**4. Cache Management**:
- ChromaDB persists to disk
- Only active data in memory
- Auto-cleanup on clear_documents()

### Memory Usage Estimates

| Documents | Chunks | Memory (embeddings) | Memory (total) |
|-----------|--------|---------------------|----------------|
| 10        | 500    | ~2 MB               | ~5 MB          |
| 100       | 5000   | ~20 MB              | ~50 MB         |
| 1000      | 50000  | ~200 MB             | ~500 MB        |
| 10000     | 500000 | ~2 GB               | ~5 GB          |

**Recommendation**: Keep documents under 10,000 for best performance

## Concurrency Model

### Threading Strategy

**GUI Thread**:
- Handles UI updates
- User input
- Event processing

**Engine Thread**:
- Ingestion processing
- Query execution
- Background tasks

**Implementation**:
```python
def ingest(self, directory: str, callback=None):
    # Run in separate thread
    def process():
        chunks = self.doc_processor.process_directory(directory)
        self.vector_store.add_chunks(chunks)
        if callback:
            callback("Ingestion complete", 100)

    threading.Thread(target=process, daemon=True).start()

def query(self, question: str):
    # Run in separate thread
    def process():
        result = self._execute_query(question)
        self.message_queue.put(("message", result))

    threading.Thread(target=process, daemon=True).start()
```

### Thread Safety

**Shared State Protection**:
- VectorStore: Thread-safe ChromaDB operations
- Message Queue: Synchronized queue
- Configuration: Atomic file writes

**No Shared State**:
- LLM interface: One instance per engine
- DocumentProcessor: Stateless operations

## Extensibility

### Adding New LLM Backend

```python
class NewLLMBackend(BaseLLM):
    def __init__(self, config):
        # Initialize
        pass

    def generate(self, prompt, config):
        # Generate response
        return response

    def get_info(self):
        # Return backend info
        return {"backend": "NewLLM", ...}

# Add to SmartLLM priority
def __init__(self, ...):
    if new_backend_path:
        self.backend = NewLLMBackend(...)
```

### Adding New Search Backend

```python
class NewSearchBackend:
    def search(self, query, top_k):
        # Search implementation
        return results

# Add to RAGEngine
def query(self, question):
    if new_search_enabled:
        results = new_search_backend.search(question)
```

### Adding New Chunker

```python
def chunk_text_semantic(self, text, source):
    """Semantic chunking with sentence boundaries"""
    # Implementation
    return chunks
```

## API Design

### REST API Endpoints

| Endpoint | Method | Description | Request | Response |
|----------|--------|-------------|---------|----------|
| `/` | GET | Health check | None | `{"status": "ok"}` |
| `/stats` | GET | Engine statistics | None | JSON stats |
| `/ask` | POST | Ask question | `{question, n_results}` | QueryResult |
| `/search` | POST | Search documents | `{query}` | List of matches |
| `/ingest` | POST | Ingest directory | `{directory}` | Stats |
| `/ingest/file` | POST | Ingest file | `{filepath}` | Stats |
| `/documents` | GET | List documents | None | List of filenames |
| `/documents` | DELETE | Clear all | None | `{"status": "cleared"}` |

### Request/Response Format

**Ask Question**:
```json
POST /ask
{
  "question": "What are the main findings?",
  "n_results": 3
}

Response:
{
  "question": "What are the main findings?",
  "answer": "The main findings indicate...",
  "sources": ["report.pdf"],
  "context_length": 1500,
  "inference_time": 1.23,
  "chunks_retrieved": 3
}
```

---

**Version**: 1.1.0
**Last Updated**: 2026-04-09
