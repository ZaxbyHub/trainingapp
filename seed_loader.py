"""Seed Data Loader for version-aware seed data imports."""

import json
import logging
from pathlib import Path
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class SeedDataLoader:
    """Load and manage seed data with version tracking."""

    def __init__(
        self,
        vector_store,
        seed_manifest_path: Path,
        seed_chunks_path: Path,
        seed_state_path: Path,
    ):
        """Initialize the seed data loader.

        Args:
            vector_store: VectorStore instance with add_chunks_with_embeddings method.
            seed_manifest_path: Path to seed manifest JSON file.
            seed_chunks_path: Path to seed chunks JSON file.
            seed_state_path: Path to seed state JSON file.
        """
        self.vector_store = vector_store
        self.seed_manifest_path = seed_manifest_path
        self.seed_chunks_path = seed_chunks_path
        self.seed_state_path = seed_state_path

    def sync(self) -> dict:
        """Sync seed data based on version comparison.

        Returns:
            dict with operation summary: {"imported": [...], "updated": [...], "skipped": [...]}
        """
        # Step 1: Read manifest
        if not self.seed_manifest_path.exists():
            return {"imported": [], "updated": [], "skipped": []}

        with open(self.seed_manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        # Step 2: Read current state
        if self.seed_state_path.exists():
            with open(self.seed_state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
        else:
            state = {}

        # Step 3: Read chunks
        if not self.seed_chunks_path.exists():
            return {"imported": [], "updated": [], "skipped": []}

        with open(self.seed_chunks_path, "r", encoding="utf-8") as f:
            all_chunks = json.load(f)

        # If no chunks, return empty summary (nothing to import)
        if not all_chunks:
            return {"imported": [], "updated": [], "skipped": []}

        summary = {"imported": [], "updated": [], "skipped": []}

        # Step 4: Process each entry in manifest
        for entry in manifest:
            doc_id = entry.get("doc_id")
            version = entry.get("version")

            if not doc_id or version is None:
                logger.warning("Invalid manifest entry missing doc_id or version: %s", entry)
                continue

            # Determine action based on version
            if doc_id not in state:
                # New document
                self._import_doc(doc_id, all_chunks)
                summary["imported"].append(doc_id)
                state[doc_id] = version
            elif state[doc_id] < version:
                # Version update needed
                self._delete_seed_doc(doc_id)
                self._import_doc(doc_id, all_chunks)
                summary["updated"].append(doc_id)
                state[doc_id] = version
            else:
                # Already up to date
                summary["skipped"].append(doc_id)

        # Step 5: Write updated state
        with open(self.seed_state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)

        return summary

    def _import_doc(self, doc_id: str, chunks: List[Dict[str, Any]]):
        """Import a single document's seed chunks.

        Args:
            doc_id: Document identifier.
            chunks: List of all chunks (filtered by _import_doc method).
        """
        # Filter chunks to only those with matching doc_id
        doc_chunks = [
            {"doc_id": c["doc_id"], "chunk_id": c["chunk_id"], "text": c["text"], "embedding": c["embedding"], "metadata": c["metadata"]}
            for c in chunks
            if c.get("doc_id") == doc_id
        ]

        # Call vector store to add chunks
        if doc_chunks:
            self.vector_store.add_chunks_with_embeddings(doc_chunks)

    def _delete_seed_doc(self, doc_id: str):
        """Delete a seed document from vector store.

        Args:
            doc_id: Document identifier to delete.
        """
        # Get all collection IDs matching prefix seed_{doc_id}_
        prefix = f"seed_{doc_id}_"

        # Get all IDs from collection
        all_ids = self.vector_store.collection.get()["ids"]

        # Filter to those matching prefix
        ids_to_delete = [id for id in all_ids if id.startswith(prefix)]

        # Delete from vector store
        if ids_to_delete:
            self.vector_store.collection.delete(ids=ids_to_delete)
            logger.debug("Deleted %d seed chunks for document: %s", len(ids_to_delete), doc_id)

        # Note: BM25 index cleanup is not automatic here.
        # For proper cleanup, the BM25Index should support a remove_document method,
        # or the index can be rebuilt on the next query. The current approach
        # (delete from ChromaDB and rebuild on next query) is acceptable for
        # this implementation.
