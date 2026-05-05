"""
Vector Store Module
Manages document embeddings and similarity search using ChromaDB.
"""

import os
import re
import sys
import json
import threading
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
from query_transformer import STOP_WORDS

import logging

logger = logging.getLogger(__name__)


class EmbeddingModel:
    """Wrapper for sentence transformer embedding model."""

    DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"

    def __init__(self, model_name: Optional[str] = None):
        if not SENTENCE_TRANSFORMERS_AVAILABLE:
            raise ImportError(
                "sentence-transformers not installed. Run: pip install sentence-transformers"
            )

        self.model_name = model_name or self.DEFAULT_MODEL
        self._model_args = {"local_files_only": True}
        self.model = None

        local_model_path = Path("./models/bge-small-en-v1.5/")

        if getattr(sys, "frozen", False):
            # Running in PyInstaller bundle
            bundle_path = Path(sys._MEIPASS) / "bundled_models" / "bge-small-en-v1.5"
            if bundle_path.exists() and any(bundle_path.iterdir()):
                # Bundle has model files - use them
                self.model_name = str(bundle_path)
                logger.info("Loading embedding model from bundle: %s", self.model_name)
            else:
                # No bundled model - try local fallback
                logger.warning("Bundled embedding model not found, checking local fallback...")
                if local_model_path.exists() and any(local_model_path.iterdir()):
                    # Use local fallback with local_files_only to prevent download
                    self.model_name = str(local_model_path)
                    logger.info("Loading embedding model from local fallback: %s", self.model_name)
                else:
                    # Model not found anywhere - raise clear error
                    expected_path = local_model_path.resolve()
                    raise FileNotFoundError(
                        f"Embedding model not found.\n"
                        f"  Expected path: {expected_path}\n"
                        f"  Install instructions: Download BAAI/bge-small-en-v1.5 to {expected_path}"
                    )
        else:
            # Running in development mode
            if local_model_path.exists() and any(local_model_path.iterdir()):
                # Use local model with local_files_only to prevent download
                self.model_name = str(local_model_path)
                logger.info("Loading embedding model from local path: %s", self.model_name)
            else:
                # Try HuggingFace cache with local_files_only=True to prevent download
                logger.info("Loading embedding model: %s (cache-only)", self.model_name)

    def _ensure_model_loaded(self):
        """Lazy-load the SentenceTransformer model if not already loaded."""
        if self.model is None:
            local_model_path = Path("./models/bge-small-en-v1.5/")

            if getattr(sys, "frozen", False):
                # Running in PyInstaller bundle
                bundle_path = Path(sys._MEIPASS) / "bundled_models" / "bge-small-en-v1.5"
                if bundle_path.exists() and any(bundle_path.iterdir()):
                    # Bundle has model files - use them
                    self.model_name = str(bundle_path)
                    logger.info("Loading embedding model from bundle: %s", self.model_name)
                    self.model = SentenceTransformer(self.model_name, **self._model_args)
                    logger.info("[OK] Embedding model loaded")
                else:
                    # No bundled model - try local fallback
                    logger.warning("Bundled embedding model not found, checking local fallback...")
                    if local_model_path.exists() and any(local_model_path.iterdir()):
                        # Use local fallback with local_files_only to prevent download
                        self.model_name = str(local_model_path)
                        logger.info("Loading embedding model from local fallback: %s", self.model_name)
                        self.model = SentenceTransformer(self.model_name, **self._model_args)
                        logger.info("[OK] Embedding model loaded")
                    else:
                        # Model not found anywhere - raise clear error
                        expected_path = local_model_path.resolve()
                        raise FileNotFoundError(
                            f"Embedding model not found.\n"
                            f"  Expected path: {expected_path}\n"
                            f"  Install instructions: Download BAAI/bge-small-en-v1.5 to {expected_path}"
                        )
            else:
                # Running in development mode
                if local_model_path.exists() and any(local_model_path.iterdir()):
                    # Use local model with local_files_only to prevent download
                    logger.info("Loading embedding model from local path: %s", self.model_name)
                    self.model = SentenceTransformer(self.model_name, **self._model_args)
                    logger.info("[OK] Embedding model loaded")
                else:
                    # Try HuggingFace cache with local_files_only=True to prevent download
                    logger.info("Loading embedding model: %s (cache-only)", self.model_name)
                    try:
                        self.model = SentenceTransformer(self.model_name, **self._model_args)
                        logger.info("[OK] Embedding model loaded")
                    except OSError as e:
                        # Model not in cache - raise helpful error
                        expected_path = local_model_path.resolve()
                        raise FileNotFoundError(
                            f"Embedding model not found in HuggingFace cache.\n"
                            f"  Model name: {self.model_name}\n"
                            f"  Expected local path: {expected_path}\n"
                            f"  Install instructions: Download BAAI/bge-small-en-v1.5 to {expected_path}"
                        ) from e

    def encode(self, texts: List[str]) -> List[List[float]]:
        """Encode texts to embeddings."""
        self._ensure_model_loaded()
        embeddings = self.model.encode(texts, show_progress_bar=len(texts) > 10)
        return embeddings.tolist()

    def encode_single(self, text: str) -> List[float]:
        """Encode a single text to embedding."""
        self._ensure_model_loaded()
        embedding = self.model.encode([text])
        return embedding[0].tolist()


class BM25Index:
    """BM25 indexing and search functionality."""

    def __init__(self):
        """Initialize empty index."""
        self.chunks: List[DocumentChunk] = []
        self.bm25_index = None

    def _tokenize(self, text: str) -> List[str]:
        """Tokenize text for BM25: lowercase, strip punctuation via regex, remove stop words, filter short tokens."""
        tokens = re.findall(r"[a-zA-Z0-9]+", text.lower())
        return [t for t in tokens if t not in STOP_WORDS and len(t) > 2]

    def build_index(self, chunks: List[DocumentChunk]):
        """Build BM25 index from chunks."""
        self.chunks = chunks
        tokenized_corpus = [self._tokenize(chunk if isinstance(chunk, str) else chunk.text) for chunk in chunks]
        # Create BM25Okapi index from tokenized corpus
        if tokenized_corpus:
            if BM25_AVAILABLE:
                self.bm25_index = BM25Okapi(tokenized_corpus)
                if len(chunks) > 10000:
                    logger.warning(
                        "Large BM25 corpus: %d chunks. Search performance may degrade.",
                        len(chunks),
                    )
            else:
                self.bm25_index = None

    def add_documents(self, chunks: List[DocumentChunk], rebuild_index: bool = True):
        """Add multiple documents to the BM25 index.

        Args:
            chunks: List of DocumentChunk objects to add.
            rebuild_index: If True (default), rebuild the index after adding.
                          If False, caller must manually call build_index() later.
        """
        self.chunks.extend(chunks)
        # Rebuild index once after all additions if requested
        if rebuild_index:
            self.build_index(self.chunks)

    def add_document(self, chunk_id: str, text: str, rebuild_index: bool = True):
        """Add a single document to the BM25 index.

        Args:
            chunk_id: Unique identifier for the document.
            text: Document text content.
            rebuild_index: If True (default), rebuild the index after adding.
                          If False, caller must manually call build_index() later.
        """
        self.add_documents(
            [
                DocumentChunk(
                    text=text, source=chunk_id, chunk_index=len(self.chunks), page=None
                )
            ],
            rebuild_index=rebuild_index,
        )

    def search(self, query: str, top_k: int = 10) -> List[Tuple[int, float]]:
        """Search for top_k results based on BM25 scores."""
        if not self.bm25_index:
            return []

        try:
            tokenized_query = self._tokenize(query)
            # Get BM25 scores for all documents
            scores = self.bm25_index.get_scores(tokenized_query)
            # Return list of (chunk_index, score) sorted by score descending
            # Only return results with score > 0
            results = [(i, score) for i, score in enumerate(scores) if score > 0]
            results.sort(key=lambda x: x[1], reverse=True)
            return results[:top_k]
        except Exception as e:
            logger.warning("BM25 search failed for query '%s': %s", query, e)
            return []

    def save(self, path: str):
        """Save chunks to JSON (BM25 index is rebuilt on load)."""
        import dataclasses

        data = {"chunks": [dataclasses.asdict(chunk) for chunk in self.chunks]}
        json_path = path.replace(".pkl", ".json") if path.endswith(".pkl") else path
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def load(self, path: str):
        """Load chunks from JSON and rebuild BM25 index."""
        from document_processor import DocumentChunk

        json_path = path.replace(".pkl", ".json") if path.endswith(".pkl") else path
        if not os.path.exists(json_path):
            # No saved index — start fresh
            self.chunks = []
            self.bm25_index = None
            return
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.chunks = [
            DocumentChunk(**chunk_dict) for chunk_dict in data.get("chunks", [])
        ]
        # Rebuild BM25Okapi from corpus
        tokenized_corpus = [self._tokenize(chunk.text) for chunk in self.chunks]
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

    def __init__(
        self, db_path: str = "./chroma_db", embedding_model: Optional[str] = None
    ):
        if not CHROMADB_AVAILABLE:
            raise ImportError("chromadb not installed. Run: pip install chromadb")

        self.db_path = Path(db_path)
        self.db_path.mkdir(parents=True, exist_ok=True)

        self.embedder = EmbeddingModel(embedding_model)

        self.client = chromadb.PersistentClient(
            path=str(self.db_path), settings=Settings(anonymized_telemetry=False)
        )

        self.collection = self.client.get_or_create_collection(
            name=self.COLLECTION_NAME, metadata={"hnsw:space": "cosine"}
        )

        self.bm25_index: Optional[BM25Index] = None

        self._load_metadata()
        self._lock = threading.RLock()
        self._bm25_needs_rebuild = self.metadata.get("chunk_count", 0) > 0

        logger.info("[OK] Vector store initialized at %s", self.db_path)
        logger.info("  Documents: %d", self.metadata.get("document_count", 0))
        logger.info("  Chunks: %d", self.collection.count())

    def _rebuild_bm25_if_needed(self):
        """Rebuild BM25 index lazily on first search if needed."""
        if not self._bm25_needs_rebuild:
            return

        try:
            all_data = self.collection.get(include=["documents", "metadatas"])
            docs = all_data.get("documents") or []
            metas = all_data.get("metadatas") or []
            if docs and metas:
                all_chunks = []
                for doc, meta in zip(docs, metas):
                    if (
                        not meta
                        or "source" not in meta
                        or "chunk_index" not in meta
                    ):
                        continue
                    chunk = DocumentChunk(
                        text=doc,
                        source=meta["source"],
                        chunk_index=meta["chunk_index"],
                        page=meta.get("page"),
                        doc_id=meta.get("doc_id"),
                        source_path=meta.get("source_path"),
                    )
                    all_chunks.append(chunk)
                if all_chunks:
                    self.bm25_index = BM25Index()
                    self.bm25_index.build_index(all_chunks)
                    logger.info(
                        "[OK] BM25 index rebuilt on first search: %d chunks", len(all_chunks)
                    )
        except Exception as e:
            logger.warning("BM25 index rebuild failed on first search: %s", e)
            self.bm25_index = BM25Index()

        # Always reset flag, even on failure - don't keep retrying
        self._bm25_needs_rebuild = False

    def _load_metadata(self):
        """Load store metadata from disk."""
        metadata_path = self.db_path / self.METADATA_FILE
        if metadata_path.exists():
            with open(metadata_path, "r") as f:
                self.metadata = json.load(f)
        else:
            self.metadata = {"document_count": 0, "chunk_count": 0, "documents": {}}

        # Migrate legacy entries that lack new-style fields
        for key, entry in list(self.metadata.get("documents", {}).items()):
            if isinstance(entry, dict) and "source_display" not in entry:
                # Old-style entry — the key IS the source/basename
                self.metadata["documents"][key] = {
                    "doc_id": key,
                    "source_display": key,
                    "source_path": key,
                    "chunks": entry.get("chunks", 0),
                    "added_at": entry.get("added_at", ""),
                }

    def _save_metadata(self):
        """Save store metadata to disk."""
        metadata_path = self.db_path / self.METADATA_FILE
        with open(metadata_path, "w") as f:
            json.dump(self.metadata, f, indent=2)

    def add_chunks(self, chunks: List[DocumentChunk], batch_size: int = 100) -> int:
        """Add document chunks to the vector store."""
        with self._lock:
            if not chunks:
                return 0

            added = 0
            added_chunks: List[DocumentChunk] = []
            for i in range(0, len(chunks), batch_size):
                batch = chunks[i : i + batch_size]

                texts = [chunk.text for chunk in batch]
                embeddings = self.embedder.encode(texts)

                ids = [
                    f"{getattr(chunk, 'doc_id', None) or chunk.source}_{chunk.chunk_index}"
                    for chunk in batch
                ]
                metadatas = [
                    {
                        "source": chunk.source,
                        "chunk_index": chunk.chunk_index,
                        "page": chunk.page if chunk.page is not None else -1,
                        "doc_id": getattr(chunk, "doc_id", None) or chunk.source,
                        "source_path": getattr(chunk, "source_path", None) or chunk.source,
                    }
                    for chunk in batch
                ]

                existing_ids = set()
                try:
                    existing = self.collection.get(ids=ids)
                    existing_ids = set(existing["ids"]) if existing["ids"] else set()
                except Exception as e:
                    logger.warning(
                        "Could not check for existing IDs, proceeding without dedup: %s",
                        e,
                    )

                new_indices = [
                    j for j, id_ in enumerate(ids) if id_ not in existing_ids
                ]

                if new_indices:
                    self.collection.add(
                        embeddings=[embeddings[j] for j in new_indices],
                        documents=[texts[j] for j in new_indices],
                        ids=[ids[j] for j in new_indices],
                        metadatas=[metadatas[j] for j in new_indices],
                    )
                    added += len(new_indices)
                    added_chunks.extend([batch[j] for j in new_indices])

                logger.info("  Processed %d/%d chunks", min(i + batch_size, len(chunks)), len(chunks))

            for chunk in chunks:
                meta_key = chunk.doc_id or chunk.source
                if meta_key not in self.metadata["documents"]:
                    self.metadata["documents"][meta_key] = {
                        "doc_id": chunk.doc_id or chunk.source,
                        "source_display": chunk.source,
                        "source_path": getattr(chunk, "source_path", None) or chunk.source,
                        "chunks": 0,
                        "added_at": str(
                            Path(chunk.source).stat().st_mtime
                            if Path(chunk.source).exists()
                            else ""
                        ),
                    }
                self.metadata["documents"][meta_key]["chunks"] = max(
                    self.metadata["documents"][meta_key]["chunks"],
                    chunk.chunk_index + 1,
                )

            self.metadata["document_count"] = len(self.metadata["documents"])
            self.metadata["chunk_count"] = self.collection.count()

            # Update BM25 index with newly added chunks (single rebuild)
            if added > 0:
                if not self.bm25_index:
                    self.bm25_index = BM25Index()
                self.bm25_index.add_documents(added_chunks)

            self._save_metadata()

            return added

    def add_chunks_with_embeddings(
        self, chunks_with_vectors: List[Dict[str, Any]]
    ) -> None:
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
        with self._lock:
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
                    raise ValueError(
                        f"Chunk {chunk_id}: 'embedding' must be a list, got {type(embedding).__name__}"
                    )
                if not all(isinstance(x, (int, float)) for x in embedding):
                    raise ValueError(
                        f"Chunk {chunk_id}: 'embedding' must contain only numbers"
                    )

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
                all_existing_ids = set(existing["ids"]) if existing["ids"] else set()
            except Exception as e:
                logger.warning("Could not check for existing IDs in batch: %s", e)
            if all_existing_ids:
                raise ValueError(f"Chunk IDs already exist: {all_existing_ids}")

            # Add to ChromaDB collection
            self.collection.add(
                ids=ids, documents=documents, embeddings=embeddings, metadatas=metadatas
            )

            # Update BM25 index with new chunks (single rebuild)
            if not self.bm25_index:
                self.bm25_index = BM25Index()
            new_chunks = [
                DocumentChunk(
                    text=text,
                    source=meta.get("source", chunk_id),
                    chunk_index=meta.get("chunk_index", i),
                    page=meta.get("page"),
                )
                for i, (chunk_id, text, meta) in enumerate(
                    zip(ids, documents, metadatas)
                )
                if chunk_id and text
            ]
            if new_chunks:
                self.bm25_index.add_documents(new_chunks)

    def search(
        self, query: str, n_results: int = 5
    ) -> List[Tuple[str, Dict[str, Any], float]]:
        """Search for similar documents."""
        with self._lock:
            if self.collection.count() == 0:
                return []

            query_embedding = self.embedder.encode_single(query)

            results = self.collection.query(
                query_embeddings=[query_embedding],
                n_results=min(n_results, self.collection.count()),
                include=["documents", "metadatas", "distances"],
            )

            matches = []
            if results["documents"] and results["documents"][0]:
                for doc, meta, dist in zip(
                    results["documents"][0],
                    results["metadatas"][0],
                    results["distances"][0],
                ):
                    similarity = 1 - dist
                    matches.append((doc, meta, similarity))

            return matches

    def get_chunks(
        self, query: str, n_results: int = 3, min_similarity: float = 0.3
    ) -> List[DocumentChunk]:
        """Get document chunks for RAG without combining context."""
        with self._lock:
            matches = self.search(query, n_results=n_results)

            filtered = [
                (doc, meta, sim) for doc, meta, sim in matches if sim >= min_similarity
            ]

            if not filtered:
                return []

            chunks = []
            for doc, meta, sim in filtered:
                chunk = DocumentChunk(
                    text=doc,
                    source=meta.get("source", "Unknown"),
                    chunk_index=meta.get("chunk_index", -1),
                    page=meta.get("page"),
                    doc_id=meta.get("doc_id"),
                    source_path=meta.get("source_path"),
                )
                chunks.append(chunk)

            return chunks

    def get_chunks_by_source(self, source: str) -> List[DocumentChunk]:
        """Get all chunks from a specific source document."""
        with self._lock:
            try:
                all_data = self.collection.get(
                    where={"source": source}, include=["documents", "metadatas"]
                )
                chunks = []

                if all_data.get("documents"):
                    for doc, meta in zip(all_data["documents"], all_data["metadatas"]):
                        chunk = DocumentChunk(
                            text=doc,
                            source=meta["source"],
                            chunk_index=meta["chunk_index"],
                            page=meta.get("page"),
                            doc_id=meta.get("doc_id"),
                            source_path=meta.get("source_path"),
                        )
                        chunks.append(chunk)

                chunks.sort(key=lambda c: c.chunk_index)
                return chunks
            except Exception:
                return []

    def get_chunks_by_doc_id(self, doc_id: str) -> List[DocumentChunk]:
        """Get all chunks for a document by doc_id (collision-safe alternative to get_chunks_by_source)."""
        with self._lock:
            try:
                all_data = self.collection.get(
                    where={"doc_id": doc_id}, include=["documents", "metadatas"]
                )
                chunks = []

                if all_data.get("documents"):
                    for doc, meta in zip(all_data["documents"], all_data["metadatas"]):
                        chunk = DocumentChunk(
                            text=doc,
                            source=meta["source"],
                            chunk_index=meta["chunk_index"],
                            page=meta.get("page"),
                            doc_id=meta.get("doc_id"),
                            source_path=meta.get("source_path"),
                        )
                        chunks.append(chunk)

                chunks.sort(key=lambda c: c.chunk_index)
                return chunks
            except Exception:
                return []

    def delete_document(self, doc_id: str) -> bool:
        """Delete a document and all its chunks by doc_id.

        Accepts doc_id (new-style hash) or source/basename (legacy).

        Returns:
            True if the document existed and was removed, False otherwise.
        """
        if not doc_id or not isinstance(doc_id, str):
            return False

        with self._lock:
            doc_id = doc_id.strip()

            # Find the metadata entry: try exact match first (new-style doc_id key)
            entry = self.metadata.get("documents", {}).get(doc_id)

            # Backward compat: if not found by doc_id, try as source/basename
            if entry is None:
                basename = os.path.basename(doc_id)
                entry = self.metadata.get("documents", {}).get(basename)
                if entry is not None:
                    doc_id = basename  # use the key we found

            if entry is None:
                logger.warning("delete_document: no entry found for %r", doc_id)
                return False

            # Capture removed_chunks for fallback chunk count calculation
            removed_chunks = entry.get("chunks", 0) if isinstance(entry, dict) else 0

            # Delete from Chroma: use doc_id metadata field if available, else source
            try:
                if (
                    isinstance(entry, dict)
                    and entry.get("doc_id")
                    and entry["doc_id"] != entry.get("source_display")
                ):
                    # New-style: delete by doc_id metadata field
                    self.collection.delete(where={"doc_id": entry["doc_id"]})
                else:
                    # Legacy or simple source-keyed entry
                    source_display = (
                        entry.get("source_display", doc_id) if isinstance(entry, dict) else doc_id
                    )
                    self.collection.delete(where={"source": source_display})
            except Exception as e:
                logger.warning("delete_document: Chroma deletion failed for %r: %s", doc_id, e)
                return False

            # Remove from BM25 index if present
            if self.bm25_index and self.bm25_index.chunks:
                source_display = (
                    entry.get("source_display", doc_id) if isinstance(entry, dict) else doc_id
                )
                remaining = [
                    c
                    for c in self.bm25_index.chunks
                    if not (
                        getattr(c, "doc_id", None) == doc_id  # primary: match by doc_id
                        or (not getattr(c, "doc_id", None) and c.source == source_display)  # fallback: no doc_id, match by source
                    )
                ]
                if remaining:
                    self.bm25_index.build_index(remaining)
                    self.bm25_index.chunks = remaining
                else:
                    self.bm25_index.bm25_index = None
                    self.bm25_index.chunks = []
                self._bm25_needs_rebuild = len(remaining) == 0

            # Remove from metadata
            del self.metadata["documents"][doc_id]

            # Update document count
            self.metadata["document_count"] = len(self.metadata["documents"])

            # Update chunk count - try to get from collection.count(), fall back to calculation
            try:
                new_chunk_count = self.collection.count()
                if not isinstance(new_chunk_count, int):
                    raise ValueError("count() did not return an integer")
            except Exception:
                previous_chunk_count = self.metadata.get("chunk_count", 0)
                new_chunk_count = max(0, previous_chunk_count - removed_chunks)

            self.metadata["chunk_count"] = new_chunk_count

            # Save updated metadata
            self._save_metadata()

            return True

    def _expand_chunks_with_neighbors(
        self, chunks: List[DocumentChunk], window: int
    ) -> List[DocumentChunk]:
        """Expand each chunk with its ±window neighbors from the same source.

        Uses doc_id for dedup and neighbor lookup when available (collision-safe for
        same-basename files). Falls back to source for legacy chunks without doc_id.
        """
        if window <= 0:
            return chunks

        expanded = []
        seen = set()

        for chunk in chunks:
            cid = getattr(chunk, "doc_id", None)
            # Use doc_id-based lookup to avoid same-basename collisions
            if cid:
                source_chunks = self.get_chunks_by_doc_id(cid)
            else:
                source_chunks = self.get_chunks_by_source(chunk.source)

            def _dedup_key(c):
                did = getattr(c, "doc_id", None)
                return (did, c.chunk_index) if did else (c.source, c.chunk_index)

            if not source_chunks:
                key = _dedup_key(chunk)
                if key not in seen:
                    seen.add(key)
                    expanded.append(chunk)
                continue

            start_idx = max(0, chunk.chunk_index - window)
            end_idx = min(len(source_chunks) - 1, chunk.chunk_index + window)

            for idx in range(start_idx, end_idx + 1):
                neighbor = source_chunks[idx]
                key = _dedup_key(neighbor)
                if key not in seen:
                    seen.add(key)
                    expanded.append(neighbor)

        expanded.sort(key=lambda c: (c.source, c.chunk_index))
        return expanded

    def get_context(
        self,
        query: str,
        n_results: int = 3,
        min_similarity: float = 0.3,
        hybrid_search: bool = False,
        retrieval_window: int = 0,
    ) -> Tuple[str, List[str], List["DocumentChunk"]]:
        """Get context for RAG from similar documents."""
        with self._lock:
            # Handle empty query - return no context
            if not query or not query.strip():
                return "", [], []
            if hybrid_search:
                self._rebuild_bm25_if_needed()

                if self.bm25_index is None:
                    logger.warning(
                        "BM25 index unavailable after rebuild attempt; falling back to vector-only search."
                    )
                    hybrid_search = False

            if hybrid_search:
                vector_results = self.search(query, n_results=n_results * 2)
                bm25_results = self.bm25_index.search(query, top_k=n_results * 2)

                # --- Namespace-safe RRF ---
                OFFSET = 1_000_000  # large enough to avoid any collision with vector indices

                vector_ranked = [(i, score) for i, (_, _, score) in enumerate(vector_results)]
                bm25_ranked = [(corpus_idx + OFFSET, score) for corpus_idx, score in bm25_results]

                fused = rrf_fuse([vector_ranked, bm25_ranked])

                context_parts = []
                per_chunk_sources = []   # one source per chunk, NOT deduplicated
                per_chunk_pages = []
                per_chunk_indices = []
                per_chunk_doc_ids = []
                per_chunk_source_paths = []
                sources = []             # deduplicated for display
                seen_keys = set()

                for fused_id, _ in fused[:n_results]:
                    if fused_id >= OFFSET:
                        # BM25 result — resolve against bm25_index.chunks
                        corpus_idx = fused_id - OFFSET
                        if corpus_idx < len(self.bm25_index.chunks):
                            chunk = self.bm25_index.chunks[corpus_idx]
                            cid = getattr(chunk, "doc_id", None)
                            key = (cid or chunk.source, chunk.chunk_index)
                            if key not in seen_keys:
                                seen_keys.add(key)
                                context_parts.append(chunk.text)
                                per_chunk_sources.append(chunk.source)
                                per_chunk_pages.append(chunk.page)
                                per_chunk_indices.append(chunk.chunk_index)
                                per_chunk_doc_ids.append(cid)
                                per_chunk_source_paths.append(getattr(chunk, "source_path", None))
                                if chunk.source not in sources:
                                    sources.append(chunk.source)
                    else:
                        # Vector result — resolve against vector_results list
                        vec_idx = fused_id
                        if vec_idx < len(vector_results):
                            doc, meta, score = vector_results[vec_idx]
                            # Apply min_similarity (currently bypassed in hybrid — fixed here)
                            if score < min_similarity:
                                continue
                            source = meta.get("source", "Unknown")
                            chunk_idx = meta.get("chunk_index", vec_idx)
                            page = meta.get("page")
                            cid = meta.get("doc_id")
                            key = (cid or source, chunk_idx)
                            if key not in seen_keys:
                                seen_keys.add(key)
                                context_parts.append(doc)
                                per_chunk_sources.append(source)
                                per_chunk_pages.append(page)
                                per_chunk_indices.append(chunk_idx)
                                per_chunk_doc_ids.append(cid)
                                per_chunk_source_paths.append(meta.get("source_path"))
                                if source not in sources:
                                    sources.append(source)

                # Expand with neighbors if window > 0
                if retrieval_window > 0 and context_parts:
                    hybrid_chunks = [
                        DocumentChunk(
                            text=context_parts[i],
                            source=per_chunk_sources[i],
                            chunk_index=per_chunk_indices[i],
                            page=per_chunk_pages[i],
                            doc_id=per_chunk_doc_ids[i],
                            source_path=per_chunk_source_paths[i],
                        )
                        for i in range(len(context_parts))
                    ]
                    expanded = self._expand_chunks_with_neighbors(hybrid_chunks, retrieval_window)
                    context_parts = [c.text for c in expanded]
                    per_chunk_sources = [c.source for c in expanded]
                    per_chunk_pages = [c.page for c in expanded]
                    per_chunk_indices = [c.chunk_index for c in expanded]
                    per_chunk_doc_ids = [getattr(c, "doc_id", None) for c in expanded]
                    per_chunk_source_paths = [getattr(c, "source_path", None) for c in expanded]
                    sources = list(dict.fromkeys(c.source for c in expanded))

                # Build result chunks for structured return
                result_chunks = [
                    DocumentChunk(
                        text=text, source=src, chunk_index=idx, page=pg,
                        doc_id=did, source_path=sp,
                    )
                    for text, src, idx, pg, did, sp in zip(
                        context_parts, per_chunk_sources, per_chunk_indices,
                        per_chunk_pages, per_chunk_doc_ids, per_chunk_source_paths,
                    )
                ]

                context = "\n\n---\n\n".join(context_parts)
                return context, sources, result_chunks
            else:
                # Original vector-only search logic
                matches = self.search(query, n_results=n_results)

                filtered = [
                    (doc, meta, sim)
                    for doc, meta, sim in matches
                    if sim >= min_similarity
                ]

                if not filtered:
                    return "", [], []

                context_parts = []
                per_chunk_sources = []
                per_chunk_pages = []
                per_chunk_indices = []
                per_chunk_doc_ids = []
                per_chunk_source_paths = []
                sources = []

                for i, (doc, meta, sim) in enumerate(filtered):
                    source = meta.get("source", "Unknown")
                    chunk_idx = meta.get("chunk_index", i)
                    page = meta.get("page")
                    context_parts.append(doc)
                    per_chunk_sources.append(source)
                    per_chunk_pages.append(page)
                    per_chunk_indices.append(chunk_idx)
                    per_chunk_doc_ids.append(meta.get("doc_id"))
                    per_chunk_source_paths.append(meta.get("source_path"))
                    if source not in sources:
                        sources.append(source)

                # Expand with neighbors if window > 0
                if retrieval_window > 0:
                    filtered_chunks = [
                        DocumentChunk(
                            text=doc,
                            source=meta.get("source", "Unknown"),
                            chunk_index=meta.get("chunk_index", i),
                            page=meta.get("page"),
                            doc_id=meta.get("doc_id"),
                            source_path=meta.get("source_path"),
                        )
                        for i, (doc, meta, sim) in enumerate(filtered)
                    ]
                    expanded = self._expand_chunks_with_neighbors(filtered_chunks, retrieval_window)
                    context_parts = [c.text for c in expanded]
                    per_chunk_sources = [c.source for c in expanded]
                    per_chunk_pages = [c.page for c in expanded]
                    per_chunk_indices = [c.chunk_index for c in expanded]
                    per_chunk_doc_ids = [getattr(c, "doc_id", None) for c in expanded]
                    per_chunk_source_paths = [getattr(c, "source_path", None) for c in expanded]
                    sources = list(dict.fromkeys(c.source for c in expanded))

                # Build result chunks
                result_chunks = [
                    DocumentChunk(
                        text=text, source=src, chunk_index=idx, page=pg,
                        doc_id=did, source_path=sp,
                    )
                    for text, src, idx, pg, did, sp in zip(
                        context_parts, per_chunk_sources, per_chunk_indices,
                        per_chunk_pages, per_chunk_doc_ids, per_chunk_source_paths,
                    )
                ]

                context = "\n\n---\n\n".join(context_parts)
                return context, sources, result_chunks

    def clear(self):
        """Clear all documents from the store."""
        with self._lock:
            self.client.delete_collection(self.COLLECTION_NAME)
            self.collection = self.client.create_collection(
                name=self.COLLECTION_NAME, metadata={"hnsw:space": "cosine"}
            )
            self.metadata = {"document_count": 0, "chunk_count": 0, "documents": {}}
            self._save_metadata()
            logger.info("[OK] Vector store cleared")

    def get_stats(self) -> Dict[str, Any]:
        """Get statistics about the vector store."""
        with self._lock:
            return {
                "db_path": str(self.db_path),
                "document_count": self.metadata.get("document_count", 0),
                "chunk_count": self.collection.count(),
                "embedding_model": self.embedder.model_name,
                "documents": [
                    entry.get("source_display", key) if isinstance(entry, dict) else key
                    for key, entry in self.metadata.get("documents", {}).items()
                ],
            }

    def get_all_documents(self) -> List[Dict[str, Any]]:
        """Return metadata for all ingested documents.

        Returns list of dicts with: id, source_display, source_path, chunks, added_at.
        Handles both new-style entries (keyed by doc_id) and old-style (keyed by source).
        """
        with self._lock:
            result = []
            for key, entry in self.metadata.get("documents", {}).items():
                if isinstance(entry, dict):
                    result.append({
                        "id": entry.get("doc_id", key),
                        "source_display": entry.get("source_display", key),
                        "source_path": entry.get("source_path", key),
                        "chunks": entry.get("chunks", 0),
                        "added_at": entry.get("added_at", ""),
                    })
                else:
                    # Legacy scalar value — shouldn't happen, but be defensive
                    result.append({
                        "id": key,
                        "source_display": key,
                        "source_path": key,
                        "chunks": 0,
                        "added_at": "",
                    })
            return result


if __name__ == "__main__":
    store = VectorStore(db_path="./test_db")

    test_chunks = [
        DocumentChunk(
            text="Python is a programming language.", source="test.txt", chunk_index=0
        ),
        DocumentChunk(
            text="Machine learning uses algorithms.", source="test.txt", chunk_index=1
        ),
        DocumentChunk(
            text="Natural language processing is a field of AI.",
            source="test.txt",
            chunk_index=2,
        ),
    ]

    store.add_chunks(test_chunks)

    results = store.search("What is Python?", n_results=2)
    print("\nSearch results:")
    for doc, meta, score in results:
        print(f"  [{score:.3f}] {meta['source']}: {doc[:50]}...")

    context, sources, chunks = store.get_context("Tell me about programming")
    print(f"\nContext from: {sources}")
    print(f"Context length: {len(context)} chars")
