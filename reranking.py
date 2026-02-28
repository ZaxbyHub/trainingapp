"""
CrossEncoder Reranking Module
Implements a reranker using sentence-transformers CrossEncoder model.
"""

from typing import List, Tuple
from dataclasses import dataclass

# Import DocumentChunk from document_processor
from document_processor import DocumentChunk


class CrossEncoderReranker:
    """CrossEncoder based reranker for document chunks."""
    
    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L-2-v2"):
        """
        Initialize the CrossEncoderReranker.
        
        Args:
            model_name (str): Name of the CrossEncoder model to use
        """
        self.model_name = model_name
        self.model = None
    
    def _load_model(self):
        """
        Lazy loading of the CrossEncoder model.
        """
        if self.model is None:
            print(f"Loading CrossEncoder model: {self.model_name}")
            from sentence_transformers import CrossEncoder
            self.model = CrossEncoder(self.model_name)
    
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