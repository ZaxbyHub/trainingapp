#!/usr/bin/env python3
"""Clear ChromaDB vector store and re-ingest all documents from a configured directory."""

import os
import sys
import argparse
from pathlib import Path


def main():
    """Main entry point for re-ingestion script."""
    parser = argparse.ArgumentParser(
        description="Clear ChromaDB vector store and re-ingest all documents"
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=None,
        help="Directory to re-ingest documents from (default: ./documents or current directory)"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Skip confirmation prompt"
    )
    
    args = parser.parse_args()
    
    # Determine directory to ingest
    if args.directory:
        directory = args.directory
    else:
        # Try ./documents first, then current directory
        documents_path = Path(__file__).parent.parent / "documents"
        if documents_path.exists() and documents_path.is_dir():
            directory = str(documents_path)
        else:
            directory = os.getcwd()
    
    print(f"Re-ingestion target directory: {directory}")
    print()
    
    # Print warning about why re-ingestion is needed
    print("=" * 70)
    print("WARNING: Re-ingestion Required")
    print("=" * 70)
    print()
    print("The clean_text() fix in the document processor changed how paragraph")
    print("structure is preserved. Existing embeddings in ChromaDB were built from")
    print("the old flattened text format. Re-ingestion is required to rebuild")
    print("embeddings with the corrected text processing.")
    print()
    print("=" * 70)
    print()
    
    if not args.force:
        response = input("This will DELETE all existing documents in the vector store. Are you sure? [y/N]: ")
        if response.lower() not in ("y", "yes"):
            print("Aborted.")
            return 0
    
    # Add project root to sys.path if needed
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    
    try:
        from engine_factory import create_engine_from_env
        
        print("Creating RAG engine...")
        engine = create_engine_from_env()
        print("  ✓ Engine created successfully")
        print()
        
        # Clear existing documents
        print("Clearing existing documents from vector store...")
        engine.clear_documents()
        print("  ✓ Existing documents cleared")
        print()
        
        # Re-ingest documents
        print(f"Ingesting documents from: {directory}")
        stats = engine.ingest_directory(directory)
        print(f"  ✓ Re-ingestion complete: {stats}")
        print()
        
        print("=" * 70)
        print("SUCCESS: Re-ingestion completed successfully")
        print("=" * 70)
        return 0
        
    except ImportError as e:
        print(f"Error: Could not import required modules.")
        print(f"  {e}")
        print()
        print("Make sure you are running this script from within the project directory.")
        return 1
    except Exception as e:
        print(f"Error: Re-ingestion failed.")
        print(f"  {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
