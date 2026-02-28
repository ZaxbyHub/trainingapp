from typing import List, Tuple

def rrf_fuse(results_list: List[List[Tuple[int, float]]], k: int = 60) -> List[Tuple[int, float]]:
    """
    Reciprocal Rank Fusion - combines multiple ranked lists.
    
    Args:
        results_list: List of result lists, each containing (doc_id, score) tuples
        k: RRF constant (default 60)
    
    Returns:
        List of (doc_id, rrf_score) sorted by score descending
    """
    from collections import defaultdict
    
    rrf_scores = defaultdict(float)
    
    for results in results_list:
        for rank, (doc_id, _) in enumerate(results):
            rrf_scores[doc_id] += 1.0 / (k + rank + 1)  # +1 because rank is 0-indexed
    
    # Sort by RRF score descending
    fused = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
    return fused