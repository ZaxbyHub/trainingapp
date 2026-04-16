#!/usr/bin/env python3
"""Pre-download models for offline deployment."""

from pathlib import Path


def main():
    """Download embedding and reranker models to HuggingFace cache."""
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    
    # Add project root to path for imports
    import sys
    sys.path.insert(0, str(project_root))
    
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder
    except ImportError as e:
        print("Error: Could not import sentence_transformers.")
        print("Please install it first: pip install sentence_transformers")
        return 1
    
    # Download embedding model
    print("Downloading embedding model...")
    try:
        embedding_model = SentenceTransformer("BAAI/bge-small-en-v1.5")
        print("  ✓ Embedding model downloaded successfully")
    except Exception as e:
        print(f"  ✗ Failed to download embedding model: {e}")
        return 1
    
    # Download reranker model
    print("Downloading reranker model...")
    try:
        reranker_model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")
        print("  ✓ Reranker model downloaded successfully")
    except Exception as e:
        print(f"  ✗ Failed to download reranker model: {e}")
        return 1
    
    print("\nAll models downloaded successfully!")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
