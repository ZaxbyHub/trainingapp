"""
CrossEncoder Reranking Module
Implements a reranker using sentence-transformers CrossEncoder model.
Uses a module-level singleton so all callers share one model instance.
"""

import threading
from typing import List, Tuple

# Import DocumentChunk from document_processor
from document_processor import DocumentChunk


# Module-level singleton — one shared instance for all callers
_shared_instance = None
_shared_lock = threading.Lock()
_shared_model_name = None


class CrossEncoderReranker:
    """CrossEncoder based reranker. All instantiations return the shared singleton.

    Thread-safe: model loading is protected by a lock; predict() calls are
    thread-safe (sentence-transformers releases the GIL during computation).
    """

    _instance_lock = threading.Lock()  # Protects _load_model for this instance

    def __new__(cls, model_name: str = "cross-encoder/ms-marco-TinyBERT-L-2"):
        """Return the shared singleton — all callers get the same instance."""
        global _shared_instance, _shared_model_name
        if _shared_instance is None:
            with _shared_lock:
                if _shared_instance is None:
                    _shared_instance = super().__new__(cls)
                    _shared_instance.model = None  # Always initialize before __init__ runs
                    _shared_model_name = model_name
        elif model_name != _shared_model_name:
            # Different model_name requested — warn but still return shared instance
            import warnings
            warnings.warn(
                f"CrossEncoderReranker(model_name={model_name!r}) ignored: "
                f"singleton already initialized with {_shared_model_name!r}"
            )
        return _shared_instance

    def __init__(self, model_name: str = "cross-encoder/ms-marco-TinyBERT-L-2"):
        # __new__ enforces singleton. Always set model_name (harmless re-assign).
        # model is already set to None by __new__ on first construction.
        self.model_name = model_name
    
    def _load_model(self):
        """
        Lazy loading of the CrossEncoder model with thread safety.
        Uses double-check locking pattern to avoid lock overhead on repeated calls.
        """
        if self.model is None:
            with self._instance_lock:
                if self.model is None:  # Double-check inside lock
                    print(f"Loading CrossEncoder model: {self.model_name}")
                    from sentence_transformers import CrossEncoder
                    self.model = CrossEncoder(self.model_name, local_files_only=True)
    
    def rerank(self, query: str, chunks: List[DocumentChunk], top_k: int = 5) -> List[Tuple[DocumentChunk, float]]:
        """
        Rerank document chunks based on their relevance to the query.
        
        Args:
            query (str): The search query
            chunks (List[DocumentChunk]): List of document chunks to rerank
            top_k (int): Number of top results to return
            
        Returns:
            List[Tuple[DocumentChunk, float]]: List of (chunk, score) pairs sorted by score descending
        """
        # Load model if needed
        self._load_model()
        
        # Create sentence pairs
        sentence_pairs = [(query, chunk.text) for chunk in chunks]
        
        # Get scores
        scores = self.model.predict(sentence_pairs)
        
        # Pair chunks with scores and sort by score descending
        results = [(chunk, score) for chunk, score in zip(chunks, scores)]
        results.sort(key=lambda x: x[1], reverse=True)
        
        # Return top_k results
        return results[:top_k]
    
    def rerank_with_scores(self, query: str, chunks: List[DocumentChunk]) -> List[Tuple[DocumentChunk, float]]:
        """
        Rerank all document chunks and return all results with their scores.
        
        Args:
            query (str): The search query
            chunks (List[DocumentChunk]): List of document chunks to rerank
            
        Returns:
            List[Tuple[DocumentChunk, float]]: List of (chunk, score) pairs sorted by score descending
        """
        # Load model if needed
        self._load_model()
        
        # Create sentence pairs
        sentence_pairs = [(query, chunk.text) for chunk in chunks]
        
        # Get scores
        scores = self.model.predict(sentence_pairs)
        
        # Pair chunks with scores and sort by score descending
        results = [(chunk, score) for chunk, score in zip(chunks, scores)]
        results.sort(key=lambda x: x[1], reverse=True)
        
        # Return all results
        return results