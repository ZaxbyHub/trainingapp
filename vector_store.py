"""
Vector Store Module
Manages document embeddings and similarity search using ChromaDB.
"""

import os
import json
from typing import List, Tuple, Optional, Dict, Any
from pathlib import Path
from dataclasses import asdict
import pickle

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
from utils import rrf_fuse


class EmbeddingModel:
    """Wrapper for sentence transformer embedding model."""
    
    DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
    
    def __init__(self, model_name: Optional[str] = None):
        if not SENTENCE_TRANSFORMERS_AVAILABLE:
            raise ImportError("sentence-transformers not installed. Run: pip install sentence-transformers")
        
        self.model_name = model_name or self.DEFAULT_MODEL
        print(f"Loading embedding model: {self.model_name}")
        self.model = SentenceTransformer(self.model_name)
        print(f"[OK] Embedding model loaded")
    
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
            try:
                self.bm25_index = BM25Okapi(tokenized_corpus)
            except NameError:
                # BM25 not available, skip indexing
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
        """Save index and chunks using pickle."""
        data = {
            'chunks': self.chunks,
            'bm25_index': self.bm25_index
        }
        with open(path, 'wb') as f:
            pickle.dump(data, f)
    
    def load(self, path: str):
        """Load index and chunks from pickle."""
        with open(path, 'rb') as f:
            data = pickle.load(f)
        self.chunks = data['chunks']
        self.bm25_index = data['bm25_index']


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
            except Exception:
                pass
            
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
        
        # Build BM25 index if not exists and we have chunks
        if self.metadata["chunk_count"] > 0 and not self.bm25_index:
            self.bm25_index = BM25Index()
            # Get all chunks from the collection for BM25 indexing
            all_chunks = []
            # We need to get all document chunks from the collection
            # Note: ChromaDB API changed - 'ids' is not a valid include option
            try:
                # Try newer API - get all data at once
                all_data = self.collection.get(include=["documents", "metadatas"])
                if all_data.get('documents'):
                    for doc, meta in zip(all_data['documents'], all_data['metadatas']):
                        chunk = DocumentChunk(
                            text=doc,
                            source=meta['source'],
                            chunk_index=meta['chunk_index'],
                            page=meta['page'] if 'page' in meta else None
                        )
                        all_chunks.append(chunk)
            except Exception:
                # Fallback - skip BM25 indexing if API issues
                pass
            
            if all_chunks:
                self.bm25_index.build_index(all_chunks)
        
        self._save_metadata()
        
        return added
    
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
    
    def _get_chunk_by_index(self, index: int) -> Optional[DocumentChunk]:
        """Helper method to retrieve chunk by index from BM25 index."""
        if self.bm25_index and index < len(self.bm25_index.chunks):
            return self.bm25_index.chunks[index]
        return None
    
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
            # Get all chunks from this source by filtering metadata
            # Note: ChromaDB API changed - 'ids' is not a valid include option
            all_data = self.collection.get(include=["documents", "metadatas"])
            chunks = []
            
            if all_data.get('documents'):
                for doc, meta in zip(all_data['documents'], all_data['metadatas']):
                    if meta.get('source') == source:
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
            
            # Get top N unique results
            top_indices = [doc_id for doc_id, _ in fused[:n_results]]
            
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