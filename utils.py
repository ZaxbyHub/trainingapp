from typing import List, Tuple
from collections import defaultdict

def rrf_fuse(results_list: List[List[Tuple[int, float]]], k: int = 60) -> List[Tuple[int, float]]:
    """
    Reciprocal Rank Fusion (RRF) - combines multiple ranked result lists into one.
    
    RRF Formula: score = 1 / (k + rank)
    Where:
        - k: constant (default 60) that dampens the impact of rank position
        - rank: position in the list (0-indexed, so we add 1)
    
    Example:
        List 1: [(doc_A, 0.9), (doc_B, 0.8)]  # doc_A at rank 0, doc_B at rank 1
        List 2: [(doc_B, 0.95), (doc_A, 0.7)] # doc_B at rank 0, doc_A at rank 1
        
        RRF scores with k=60:
        - doc_A: 1/(60+0+1) + 1/(60+1+1) = 0.0164 + 0.0161 = 0.0325
        - doc_B: 1/(60+1+1) + 1/(60+0+1) = 0.0161 + 0.0164 = 0.0325
        
        Result: Both docs get similar scores, with slight edge to doc_B due to 
        appearing at rank 0 in List 2.
    
    Args:
        results_list: List of result lists, each containing (doc_id, score) tuples
        k: RRF constant (default 60) - higher values reduce rank position impact
    
    Returns:
        List of (doc_id, rrf_score) sorted by score descending
    """
    rrf_scores = defaultdict(float)
    
    for results in results_list:
        for rank, (doc_id, _) in enumerate(results):
            rrf_scores[doc_id] += 1.0 / (k + rank + 1)  # +1 because rank is 0-indexed
    
    # Sort by RRF score descending
    fused = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
    return fused