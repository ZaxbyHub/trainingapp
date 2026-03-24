"""
Vector Store Module
Manages document embeddings and similarity search using ChromaDB.
"""

import os
import sys
import json
from typing import List, Tuple, Optional, Dict, Any
from pathlib import Path


try:
    import chromadb
    from chromadb.config import Settings
    CHROMADB_AVAILABLE = True
except ImportError:
    CHROMADB_AVAILABLE = False

try:
    from sentence_transformers import SentenceTransformer
    SENTENCE_TRANSFORMERS_AVAILABLE = True
except ImportError:
    SENTENCE_TRANSFORMERS_AVAILABLE = False

try:
    from rank_bm25 import BM25Okapi
    BM25_AVAILABLE = True
except ImportError:
    BM25_AVAILABLE = False

from document_processor import DocumentChunk
from utils import rrf_fuse

import logging
logger = logging.getLogger(__name__)


class EmbeddingModel:
    """Wrapper for sentence transformer embedding model."""
    
    DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
    
    def __init__(self, model_name: Optional[str] = None):
        if not SENTENCE_TRANSFORMERS_AVAILABLE:
            raise ImportError("sentence-transformers not installed. Run: pip install sentence-transformers")

        if getattr(sys, 'frozen', False):
            # Running in PyInstaller bundle - use bundled model
            bundle_path = Path(sys._MEIPASS) / 'bundled_models' / 'bge-small-en-v1.5'
            if not bundle_path.exists():
                raise FileNotFoundError(f"Bundled embedding model not found at {bundle_path}")
            self.model_name = str(bundle_path)
            print(f"Loading embedding model from bundle: {self.model_name}")
            self.model = SentenceTransformer(self.model_name, local_files_only=True)
            print("[OK] Embedding model loaded")
        else:
            # Running in development - use model from HuggingFace cache
            self.model_name = model_name or self.DEFAULT_MODEL
            print(f"Loading embedding model: {self.model_name}")
            self.model = SentenceTransformer(self.model_name)
            print("[OK] Embedding model loaded")
    
    def encode(self, texts: List[str]) -> List[List[float]]:
        """Encode texts to embeddings."""
        embeddings = self.model.encode(texts, show_progress_bar=len(texts) > 10)
        return embeddings.tolist()
    
    def encode_single(self, text: str) -> List[float]:
        """Encode a single text to embedding."""
        embedding = self.model.encode([text])
        return embedding[0].tolist()


class BM25Index:
    """BM25 indexing and search functionality."""
    
    def __init__(self):
        """Initialize empty index."""
        self.chunks: List[DocumentChunk] = []
        self.bm25_index = None
    
    def build_index(self, chunks: List[DocumentChunk]):
        """Build BM25 index from chunks."""
        self.chunks = chunks
        # Tokenize each chunk.text (simple split on whitespace)
        tokenized_corpus = [chunk.text.split() for chunk in chunks]
        # Create BM25Okapi index from tokenized corpus
        if tokenized_corpus:
            if BM25_AVAILABLE:
                self.bm25_index = BM25Okapi(tokenized_corpus)
            else:
                self.bm25_index = None

    def add_document(self, chunk_id: str, text: str):
        """Add a document to the BM25 index.

        Args:
            chunk_id: Unique identifier for the document.
            text: Document text content.
        """
        # Add to chunks list regardless of BM25 availability
        self.chunks.append(DocumentChunk(
            text=text,
            source=chunk_id,  # Use chunk_id as source
            chunk_index=len(self.chunks),
            page=None
        ))

        # Rebuild index with new document
        tokenized_corpus = [chunk.text.split() for chunk in self.chunks]
        if tokenized_corpus:
            if BM25_AVAILABLE:
                self.bm25_index = BM25Okapi(tokenized_corpus)
            else:
                self.bm25_index = None
    
    def search(self, query: str, top_k: int = 10) -> List[Tuple[int, float]]:
        """Search for top_k results based on BM25 scores."""
        if not self.bm25_index:
            return []
        
        try:
            # Tokenize query (simple split)
            tokenized_query = query.split()
            # Get BM25 scores for all documents
            scores = self.bm25_index.get_scores(tokenized_query)
            # Return list of (chunk_index, score) sorted by score descending
            # Only return results with score > 0
            results = [(i, score) for i, score in enumerate(scores) if score > 0]
            results.sort(key=lambda x: x[1], reverse=True)
            return results[:top_k]
        except Exception:
            return []
    
    def save(self, path: str):
        """Save chunks to JSON (BM25 index is rebuilt on load)."""
        import dataclasses
        data = {
            'chunks': [dataclasses.asdict(chunk) for chunk in self.chunks]
        }
        json_path = path.replace('.pkl', '.json') if path.endswith('.pkl') else path
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def load(self, path: str):
        """Load chunks from JSON and rebuild BM25 index."""
        from document_processor import DocumentChunk
        json_path = path.replace('.pkl', '.json') if path.endswith('.pkl') else path
        if not os.path.exists(json_path):
            # No saved index — start fresh
            self.chunks = []
            self.bm25_index = None
            return
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        self.chunks = [DocumentChunk(**chunk_dict) for chunk_dict in data.get('chunks', [])]
        # Rebuild BM25Okapi from corpus
        tokenized_corpus = [chunk.text.split() for chunk in self.chunks]
        if tokenized_corpus:
            if BM25_AVAILABLE:
                self.bm25_index = BM25Okapi(tokenized_corpus)
            else:
                self.bm25_index = None
        else:
            self.bm25_index = None


class VectorStore:
    """Manages document chunks and embeddings using ChromaDB."""
    
    COLLECTION_NAME = "documents"
    METADATA_FILE = "store_metadata.json"
    
    def __init__(self, db_path: str = "./chroma_db", embedding_model: Optional[str] = None):
        if not CHROMADB_AVAILABLE:
            raise ImportError("chromadb not installed. Run: pip install chromadb")
        
        self.db_path = Path(db_path)
        self.db_path.mkdir(parents=True, exist_ok=True)
        
        self.embedder = EmbeddingModel(embedding_model)
        
        self.client = chromadb.PersistentClient(
            path=str(self.db_path),
            settings=Settings(anonymized_telemetry=False)
        )
        
        self.collection = self.client.get_or_create_collection(
            name=self.COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"}
        )
        
        self.bm25_index: Optional[BM25Index] = None
        
        self._load_metadata()

        # Rebuild BM25 index from persisted ChromaDB data if documents exist
        if self.metadata.get("chunk_count", 0) > 0:
            try:
                all_data = self.collection.get(include=["documents", "metadatas"])
                docs = all_data.get("documents") or []
                metas = all_data.get("metadatas") or []
                if docs and metas:
                    all_chunks = []
                    for doc, meta in zip(docs, metas):
                        if not meta or "source" not in meta or "chunk_index" not in meta:
                            continue
                        chunk = DocumentChunk(
                            text=doc,
                            source=meta["source"],
                            chunk_index=meta["chunk_index"],
                            page=meta.get("page")
                        )
                        all_chunks.append(chunk)
                    if all_chunks:
                        self.bm25_index = BM25Index()
                        self.bm25_index.build_index(all_chunks)
                        print(f"[OK] BM25 index rebuilt on startup: {len(all_chunks)} chunks")
            except Exception as e:
                print(f"[WARN] BM25 index rebuild failed on startup: {e}")

        print(f"[OK] Vector store initialized at {self.db_path}")
        print(f"  Documents: {self.metadata.get('document_count', 0)}")
        print(f"  Chunks: {self.collection.count()}")
    
    def _load_metadata(self):
        """Load store metadata from disk."""
        metadata_path = self.db_path / self.METADATA_FILE
        if metadata_path.exists():
            with open(metadata_path, 'r') as f:
                self.metadata = json.load(f)
        else:
            self.metadata = {
                "document_count": 0,
                "chunk_count": 0,
                "documents": {}
            }
    
    def _save_metadata(self):
        """Save store metadata to disk."""
        metadata_path = self.db_path / self.METADATA_FILE
        with open(metadata_path, 'w') as f:
            json.dump(self.metadata, f, indent=2)
    
    def add_chunks(self, chunks: List[DocumentChunk], batch_size: int = 100) -> int:
        """Add document chunks to the vector store."""
        if not chunks:
            return 0
        
        added = 0
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            
            texts = [chunk.text for chunk in batch]
            embeddings = self.embedder.encode(texts)
            
            ids = [f"{chunk.source}_{chunk.chunk_index}" for chunk in batch]
            metadatas = [
                {
                    "source": chunk.source,
                    "chunk_index": chunk.chunk_index,
                    "page": chunk.page if chunk.page else -1
                }
                for chunk in batch
            ]
            
            existing_ids = set()
            try:
                existing = self.collection.get(ids=ids)
                existing_ids = set(existing['ids']) if existing['ids'] else set()
            except Exception as e:
                logger.warning("Could not check for existing IDs, proceeding without dedup: %s", e)

            new_indices = [j for j, id_ in enumerate(ids) if id_ not in existing_ids]
            
            if new_indices:
                self.collection.add(
                    embeddings=[embeddings[j] for j in new_indices],
                    documents=[texts[j] for j in new_indices],
                    ids=[ids[j] for j in new_indices],
                    metadatas=[metadatas[j] for j in new_indices]
                )
                added += len(new_indices)
            
            print(f"  Processed {min(i + batch_size, len(chunks))}/{len(chunks)} chunks")
        
        for chunk in chunks:
            if chunk.source not in self.metadata["documents"]:
                self.metadata["documents"][chunk.source] = {
                    "chunks": 0,
                    "added_at": str(Path(chunk.source).stat().st_mtime if Path(chunk.source).exists() else "")
                }
            self.metadata["documents"][chunk.source]["chunks"] = max(
                self.metadata["documents"][chunk.source]["chunks"],
                chunk.chunk_index + 1
            )
        
        self.metadata["document_count"] = len(self.metadata["documents"])
        self.metadata["chunk_count"] = self.collection.count()
        
        # Update BM25 index incrementally for newly added chunks
        if added > 0:
            if not self.bm25_index:
                self.bm25_index = BM25Index()
            for chunk in chunks:
                chunk_id = f"{chunk.source}_{chunk.chunk_index}"
                self.bm25_index.add_document(chunk_id, chunk.text)
        
        self._save_metadata()
        
        return added
    
    def add_chunks_with_embeddings(self, chunks_with_vectors: List[Dict[str, Any]]) -> None:
        """Add document chunks with pre-computed embeddings to the vector store.
        
        Args:
            chunks_with_vectors: List of dicts, each with keys:
                - chunk_id (str): Unique identifier for the chunk
                - text (str): The chunk text content
                - embedding (list[float]): Pre-computed embedding vector
                - metadata (dict): Metadata dict with keys like source, doc_id, chunk_index, etc.
        
        Raises:
            ValueError: If a chunk_id already exists in the collection.
        """
        if not chunks_with_vectors:
            return
        
        ids = []
        documents = []
        embeddings = []
        metadatas = []

        # Collect all chunk data first
        for chunk_data in chunks_with_vectors:
            chunk_id = chunk_data.get("chunk_id")
            text = chunk_data.get("text")
            embedding = chunk_data.get("embedding")
            metadata = chunk_data.get("metadata", {})

            if embedding is None:
                raise ValueError(f"Chunk {chunk_id} missing 'embedding' field")

            if not isinstance(embedding, list):
                raise ValueError(f"Chunk {chunk_id}: 'embedding' must be a list, got {type(embedding).__name__}")
            if not all(isinstance(x, (int, float)) for x in embedding):
                raise ValueError(f"Chunk {chunk_id}: 'embedding' must contain only numbers")

            if not chunk_id or not text or not embedding:
                raise ValueError(f"Invalid chunk data: {chunk_data}")

            ids.append(chunk_id)
            documents.append(text)
            embeddings.append(embedding)
            metadatas.append(metadata)

        # Batch existence check BEFORE any writes
        all_existing_ids = set()
        try:
            existing = self.collection.get(ids=ids)
            all_existing_ids = set(existing['ids']) if existing['ids'] else set()
        except Exception as e:
            logger.warning("Could not check for existing IDs in batch: %s", e)
        if all_existing_ids:
            raise ValueError(f"Chunk IDs already exist: {all_existing_ids}")

        # Add to ChromaDB collection
        self.collection.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas
        )

        # Initialize BM25 index if not exists
        if not self.bm25_index:
            self.bm25_index = BM25Index()

        # Update BM25 index with new chunks
        for chunk_id, text in zip(ids, documents):
            if chunk_id and text:
                self.bm25_index.add_document(chunk_id, text)
    
    def search(self, query: str, n_results: int = 5) -> List[Tuple[str, Dict[str, Any], float]]:
        """Search for similar documents."""
        if self.collection.count() == 0:
            return []
        
        query_embedding = self.embedder.encode_single(query)
        
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=min(n_results, self.collection.count()),
            include=["documents", "metadatas", "distances"]
        )
        
        matches = []
        if results['documents'] and results['documents'][0]:
            for doc, meta, dist in zip(
                results['documents'][0],
                results['metadatas'][0],
                results['distances'][0]
            ):
                similarity = 1 - dist
                matches.append((doc, meta, similarity))
        
        return matches
    
    def get_chunks(self, query: str, n_results: int = 3, min_similarity: float = 0.3) -> List[DocumentChunk]:
        """Get document chunks for RAG without combining context."""
        matches = self.search(query, n_results=n_results)
        
        filtered = [(doc, meta, sim) for doc, meta, sim in matches if sim >= min_similarity]
        
        if not filtered:
            return []
        
        chunks = []
        for doc, meta, sim in filtered:
            source = meta.get('source', 'Unknown')
            chunk_index = meta.get('chunk_index', -1)
            page = meta.get('page', None)
            
            chunk = DocumentChunk(
                text=doc,
                source=source,
                chunk_index=chunk_index,
                page=page
            )
            chunks.append(chunk)
        
        return chunks
    
    def get_chunks_by_source(self, source: str) -> List[DocumentChunk]:
        """Get all chunks from a specific source document."""
        try:
            all_data = self.collection.get(where={"source": source}, include=["documents", "metadatas"])
            chunks = []

            if all_data.get('documents'):
                for doc, meta in zip(all_data['documents'], all_data['metadatas']):
                    chunk = DocumentChunk(
                        text=doc,
                        source=meta['source'],
                        chunk_index=meta['chunk_index'],
                        page=meta['page'] if 'page' in meta else None
                    )
                    chunks.append(chunk)

            # Sort by chunk_index
            chunks.sort(key=lambda c: c.chunk_index)
            return chunks
        except Exception:
            return []
    
    def delete_document(self, doc_id: str) -> bool:
        """Delete a document and all its chunks from the vector store.

        Args:
            doc_id: The filename or document ID to delete.

        Returns:
            True if the document existed and was removed, False otherwise.
        """
        # Guard clause: return False if doc_id is falsy or not a string
        if not doc_id or not isinstance(doc_id, str):
            return False

        # Sanitize doc_id using basename and strip whitespace
        sanitized_id = os.path.basename(doc_id).strip()

        # Return False if sanitized id is empty
        if not sanitized_id:
            return False

        # Return False if document doesn't exist in metadata
        if sanitized_id not in self.metadata.get('documents', {}):
            return False

        # Capture the document metadata before deleting it
        doc_meta = self.metadata.get('documents', {}).get(sanitized_id, {})
        removed_chunks = doc_meta.get('chunks', 0)

        # Return False if there are no chunks to remove
        if removed_chunks == 0:
            return False

        try:
            # Verify collection can be queried before deleting
            self.collection.get(where={"source": sanitized_id})
        except Exception:
            # Handle exception gracefully, return False
            return False

        try:
            # Delete all chunks with matching source from ChromaDB collection
            self.collection.delete(where={"source": sanitized_id})
        except Exception:
            # Handle exception gracefully, return False
            return False

        # Remove from BM25 index
        if self.bm25_index:
            prefix = f"{sanitized_id}_"
            self.bm25_index.chunks = [
                chunk for chunk in self.bm25_index.chunks
                if not chunk.source.startswith(prefix)
            ]
            self.bm25_index.bm25_index = None  # Invalidate cached index

        # Remove the document from metadata
        if sanitized_id in self.metadata.get('documents', {}):
            del self.metadata['documents'][sanitized_id]

        # Update document count
        self.metadata['document_count'] = len(self.metadata['documents'])

        # Update chunk count - try to get from collection.count(), fall back to calculation
        try:
            new_chunk_count = self.collection.count()
            # Verify it's actually an integer
            if not isinstance(new_chunk_count, int):
                raise ValueError("count() did not return an integer")
        except Exception:
            # Fall back to subtracting removed chunks from previous count
            previous_chunk_count = self.metadata.get('chunk_count', 0)
            new_chunk_count = max(0, previous_chunk_count - removed_chunks)

        self.metadata['chunk_count'] = new_chunk_count

        # Save updated metadata
        self._save_metadata()

        return True
    
    def get_context(self, query: str, n_results: int = 3, min_similarity: float = 0.3, hybrid_search: bool = False) -> Tuple[str, List[str]]:
        """Get context for RAG from similar documents."""
        if hybrid_search and self.bm25_index:
            # Get vector search results
            vector_results = self.search(query, n_results=n_results * 2)
            
            # Get BM25 results
            bm25_results = self.bm25_index.search(query, top_k=n_results * 2)
            
            # Prepare results for fusion
            # Vector results are (doc, meta, score) tuples
            # BM25 results are (index, score) tuples where index refers to bm25_index.chunks
            vector_ranked = [(i, score) for i, (_, _, score) in enumerate(vector_results)]
            
            # Fuse using RRF
            fused = rrf_fuse([vector_ranked, bm25_results])

            # Build context from fused results
            context_parts = []
            sources = []
            
            # For each fused result, get the chunk text from appropriate source
            for doc_id, _ in fused[:n_results]:
                # Check if it's a vector result (index < len(vector_results)) or BM25 result (index >= len(vector_results))
                if doc_id < len(vector_results):
                    # This is a vector search result
                    doc, meta, score = vector_results[doc_id]
                    source = meta.get('source', 'Unknown')
                    context_parts.append(doc)
                    if source not in sources:
                        sources.append(source)
                else:
                    # This is a BM25 result - get from bm25_index.chunks
                    chunk_index = doc_id - len(vector_results)
                    if chunk_index < len(self.bm25_index.chunks):
                        chunk = self.bm25_index.chunks[chunk_index]
                        context_parts.append(chunk.text)
                        source = chunk.source
                        if source not in sources:
                            sources.append(source)
            
            context = "\n\n---\n\n".join(context_parts)
            return context, sources
        else:
            # Original vector-only search logic
            matches = self.search(query, n_results=n_results)
            
            filtered = [(doc, meta, sim) for doc, meta, sim in matches if sim >= min_similarity]
            
            if not filtered:
                return "", []
            
            context_parts = []
            sources = []
            
            for doc, meta, sim in filtered:
                source = meta.get('source', 'Unknown')
                context_parts.append(doc)  # Don't add source prefix - just the text
                if source not in sources:
                    sources.append(source)
            
            context = "\n\n---\n\n".join(context_parts)
            return context, sources
    
    def clear(self):
        """Clear all documents from the store."""
        self.client.delete_collection(self.COLLECTION_NAME)
        self.collection = self.client.create_collection(
            name=self.COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"}
        )
        self.metadata = {
            "document_count": 0,
            "chunk_count": 0,
            "documents": {}
        }
        self._save_metadata()
        print("[OK] Vector store cleared")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about the vector store."""
        return {
            "db_path": str(self.db_path),
            "document_count": self.metadata.get("document_count", 0),
            "chunk_count": self.collection.count(),
            "embedding_model": self.embedder.model_name,
            "documents": list(self.metadata.get("documents", {}).keys())
        }


if __name__ == "__main__":
    store = VectorStore(db_path="./test_db")
    
    test_chunks = [
        DocumentChunk(text="Python is a programming language.", source="test.txt", chunk_index=0),
        DocumentChunk(text="Machine learning uses algorithms.", source="test.txt", chunk_index=1),
        DocumentChunk(text="Natural language processing is a field of AI.", source="test.txt", chunk_index=2),
    ]
    
    store.add_chunks(test_chunks)
    
    results = store.search("What is Python?", n_results=2)
    print("\nSearch results:")
    for doc, meta, score in results:
        print(f"  [{score:.3f}] {meta['source']}: {doc[:50]}...")
    
    context, sources = store.get_context("Tell me about programming")
    print(f"\nContext from: {sources}")
    print(f"Context length: {len(context)} chars")