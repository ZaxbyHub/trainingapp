#!/usr/bin/env python3
"""
Export Seed Chunks Script

Developer CLI script to export ChromaDB collection to seed data format.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Dict, Any


def main():
    parser = argparse.ArgumentParser(
        description="Export ChromaDB collection to seed data format"
    )
    parser.add_argument(
        "--db-path",
        type=str,
        default="doc_qa_db",
        help="Path to ChromaDB directory (default: doc_qa_db)"
    )
    args = parser.parse_args()

    # Add parent directory to path to import vector_store
    script_dir = Path(__file__).parent
    parent_dir = script_dir.parent
    sys.path.insert(0, str(parent_dir))

    try:
        from vector_store import VectorStore
    except ImportError as e:
        print(f"[ERROR] Failed to import VectorStore: {e}")
        sys.exit(1)

    # Create VectorStore instance
    try:
        print(f"[INFO] Loading ChromaDB from: {args.db_path}")
        vector_store = VectorStore(db_path=args.db_path)
    except Exception as e:
        print(f"[ERROR] Failed to load VectorStore: {e}")
        sys.exit(1)

    # Get all chunks from ChromaDB
    try:
        print("[INFO] Fetching chunks from ChromaDB...")
        all_data = vector_store.collection.get(include=["documents", "metadatas", "embeddings"])
        documents = all_data.get("documents") or []
        metadatas = all_data.get("metadatas") or []
        embeddings_raw = all_data.get("embeddings")
        ids = all_data.get("ids") or []
        # Convert embeddings to list for JSON serialization
        if embeddings_raw is not None:
            try:
                import numpy as np
                if isinstance(embeddings_raw, np.ndarray):
                    # Handle both 1D and 2D arrays
                    if len(embeddings_raw.shape) == 1:
                        # Single embedding array
                        embeddings = embeddings_raw.tolist()
                    else:
                        # Multiple embeddings as a 2D array
                        embeddings = [e.tolist() if isinstance(e, np.ndarray) else e for e in embeddings_raw]
                else:
                    # Assume it's already a list
                    embeddings = list(embeddings_raw)
            except ImportError:
                # numpy not available, just use as-is
                embeddings = list(embeddings_raw) if embeddings_raw else []
        else:
            embeddings = []
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to get chunks: {e}")
        traceback.print_exc()
        sys.exit(1)

    # Group chunks by doc_id
    chunks_by_doc: Dict[str, List[Dict[str, Any]]] = {}
    doc_manifest: List[Dict[str, Any]] = []

    for doc_id, text, metadata, chunk_id in zip(ids, documents, metadatas, range(len(ids))):
        # Get source from metadata
        source = metadata.get("source", "Unknown") if metadata else "Unknown"

        # Get chunk_index from metadata
        chunk_index = metadata.get("chunk_index", chunk_id) if metadata else chunk_id

        # Generate seed chunk_id if not already in that format
        seed_chunk_id = f"seed_{doc_id}_{chunk_index}"

        # Create chunk entry
        chunk_entry = {
            "doc_id": doc_id,
            "chunk_id": seed_chunk_id,
            "text": text,
            "embedding": embeddings[chunk_id],
            "metadata": metadata or {}
        }

        # Group by doc_id
        if doc_id not in chunks_by_doc:
            chunks_by_doc[doc_id] = []

        chunks_by_doc[doc_id].append(chunk_entry)

        # Add to manifest if not already present
        existing_entry = next(
            (e for e in doc_manifest if e["doc_id"] == doc_id),
            None
        )
        if existing_entry:
            existing_entry["chunk_count"] += 1
        else:
            doc_manifest.append({
                "doc_id": doc_id,
                "version": 1,
                "description": source,
                "chunk_count": 1
            })

    # Create seed_data directory
    seed_data_dir = script_dir.parent / "seed_data"
    seed_data_dir.mkdir(parents=True, exist_ok=True)

    # Export chunks to JSON
    chunks_output = []
    for doc_id, chunks in chunks_by_doc.items():
        chunks_output.extend(chunks)

    chunks_json_path = seed_data_dir / "chunks.json"
    with open(chunks_json_path, 'w', encoding='utf-8') as f:
        json.dump(chunks_output, f, indent=2, ensure_ascii=False)

    # Export manifest to JSON
    manifest_json_path = seed_data_dir / "seed_manifest.json"
    with open(manifest_json_path, 'w', encoding='utf-8') as f:
        json.dump(doc_manifest, f, indent=2)

    # Print summary
    doc_count = len(doc_manifest)
    chunk_count = len(chunks_output)

    print(f"\n[OK] Export completed!")
    print(f"  Documents: {doc_count}")
    print(f"  Chunks: {chunk_count}")
    print(f"\nOutput files:")
    print(f"  - {chunks_json_path}")
    print(f"  - {manifest_json_path}")


if __name__ == "__main__":
    main()
