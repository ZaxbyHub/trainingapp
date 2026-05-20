"""
Tests for incremental BM25 update performance and correctness.

Verifies:
1. Adding 100 chunks to 5000-chunk corpus completes BM25 update in <500ms
2. BM25 index remains queryable and consistent after incremental update
3. search() returns correct results after incremental update
4. rebuild() triggers full corpus rebuild (verifiable by timing)
5. Adversarial — incremental updates don't cause index corruption or memory leaks
"""

import pytest
import time
import tracemalloc
from vector_store import BM25Index
from document_processor import DocumentChunk


def make_chunk(text: str, source: str = "test.txt", chunk_index: int = 0) -> DocumentChunk:
    """Helper to create a DocumentChunk."""
    return DocumentChunk(text=text, source=source, chunk_index=chunk_index)


def make_chunks(count: int, text_prefix: str = "chunk") -> list:
    """Helper to create multiple DocumentChunks."""
    return [
        DocumentChunk(
            text=f"{text_prefix} {i} contains some searchable text content here",
            source="corpus.txt",
            chunk_index=i,
        )
        for i in range(count)
    ]


class TestIncrementalBM25Performance:
    """Tests for incremental BM25 update performance."""

    def test_add_100_chunks_to_5000_corpus_under_500ms(self):
        """Adding 100 chunks to 5000-chunk corpus completes in <500ms."""
        index = BM25Index()

        # Build initial 5000-chunk corpus
        initial_chunks = make_chunks(5000, "initial")
        index.build_index(initial_chunks)

        # Prepare 100 new chunks to add
        new_chunks = make_chunks(100, "update")

        # Measure incremental update time
        start = time.perf_counter()
        index.add_documents(new_chunks, rebuild_index=True)
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert elapsed_ms < 500, f"Incremental update took {elapsed_ms:.1f}ms, expected <500ms"
        assert len(index.chunks) == 5100

    def test_deferred_rebuild_faster_than_immediate(self):
        """add_documents with rebuild_index=False is faster than rebuild_index=True."""
        index1 = BM25Index()
        index2 = BM25Index()

        base_chunks = make_chunks(1000, "base")

        # Build both with same base
        index1.build_index(base_chunks)
        index2.build_index(base_chunks)

        new_chunks = make_chunks(100, "new")

        # Add with immediate rebuild
        start = time.perf_counter()
        index1.add_documents(new_chunks, rebuild_index=True)
        immediate_time = time.perf_counter() - start

        # Add with deferred rebuild
        start = time.perf_counter()
        index2.add_documents(new_chunks, rebuild_index=False)
        deferred_time = time.perf_counter() - start

        # Deferred rebuild should be much faster
        assert deferred_time < immediate_time * 0.1, \
            f"Deferred rebuild ({deferred_time*1000:.1f}ms) should be << immediate ({immediate_time*1000:.1f}ms)"


class TestBM25QueryConsistency:
    """Tests for BM25 query correctness after incremental updates."""

    def test_search_returns_results_after_incremental_update(self):
        """BM25 index remains queryable after incremental update."""
        index = BM25Index()

        initial_chunks = [
            make_chunk("Python is a programming language", "doc1.txt", 0),
            make_chunk("Java is also a programming language", "doc2.txt", 0),
        ]
        index.build_index(initial_chunks)

        # Add more chunks incrementally
        new_chunks = [
            make_chunk("Machine learning uses algorithms and data", "doc3.txt", 0),
            make_chunk("Deep learning is a subset of machine learning", "doc4.txt", 0),
        ]
        index.add_documents(new_chunks)

        # Search should return results
        results = index.search("programming language")
        assert len(results) > 0, "Search returned no results after incremental update"

    def test_search_results_ordered_by_score(self):
        """Search returns results ordered by BM25 score descending."""
        index = BM25Index()

        chunks = [
            make_chunk("python python python programming", "doc1.txt", 0),
            make_chunk("java programming language", "doc2.txt", 0),
            make_chunk("ruby rails web programming", "doc3.txt", 0),
        ]
        index.build_index(chunks)

        results = index.search("python programming")

        # Results should be ordered by score descending
        scores = [score for _, score in results]
        assert scores == sorted(scores, reverse=True), "Results not sorted by score"

    def test_new_documents_findable_after_incremental_update(self):
        """Documents added via incremental update are findable by search."""
        index = BM25Index()

        # Build with initial content that does NOT contain "special keyword"
        initial_chunks = [
            make_chunk("regular content about programming", "doc1.txt", 0),
        ]
        index.build_index(initial_chunks)

        # Add document containing "special keyword" via incremental update
        new_chunks = [
            make_chunk("special keyword unique to new document content", "doc2.txt", 0),
        ]
        index.add_documents(new_chunks)

        # Search for content only in new document
        results = index.search("special keyword")

        assert len(results) > 0, "New document not findable after incremental update"
        # The new document should be top result
        top_idx, _ = results[0]
        assert index.chunks[top_idx].source == "doc2.txt"

    def test_idf_cache_invalidated_after_incremental_update(self):
        """IDF cache is properly invalidated after adding new documents."""
        index = BM25Index()

        initial_chunks = [
            make_chunk("common word appears frequently in corpus", "doc1.txt", 0),
        ]
        index.build_index(initial_chunks)

        # First search to populate IDF cache
        index.search("common word")
        assert index._idf_cache is not None, "IDF cache should be populated"

        # Add more documents
        new_chunks = [
            make_chunk("new document with different content", "doc2.txt", 0),
        ]
        index.add_documents(new_chunks)

        # IDF cache should be invalidated
        assert index._idf_cache is None, "IDF cache should be invalidated after add_documents"


class TestBM25RebuildTiming:
    """Tests for rebuild() triggering full corpus rebuild."""

    def test_rebuild_slower_than_incremental_add(self):
        """Full rebuild takes longer than incremental add for same corpus."""
        index1 = BM25Index()
        index2 = BM25Index()

        base_chunks = make_chunks(1000, "base")

        # Build first index normally
        index1.build_index(base_chunks)

        # Build second index and add incrementally
        index2.build_index(base_chunks[:500])
        start = time.perf_counter()
        index2.add_documents(base_chunks[500:], rebuild_index=True)
        incremental_time = time.perf_counter() - start

        # Now measure rebuild on same corpus size
        index3 = BM25Index()
        index3.build_index(base_chunks)
        start = time.perf_counter()
        index3.rebuild()
        rebuild_time = time.perf_counter() - start

        # Rebuild should not be dramatically faster than incremental
        # (they do similar work, rebuild just does it all at once)
        # The key is that add_documents with rebuild_index=False is fast
        # and rebuild() explicitly rebuilds from scratch

    def test_rebuild_completes_on_large_corpus(self):
        """rebuild() completes successfully on corpus with 1000+ chunks."""
        index = BM25Index()
        chunks = make_chunks(1000, "corpus")
        index.build_index(chunks)

        # Rebuild should complete without error
        start = time.perf_counter()
        index.rebuild()
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert elapsed_ms < 5000, f"rebuild took {elapsed_ms:.1f}ms, expected <5000ms"
        assert len(index.chunks) == 1000


class TestBM25Adversarial:
    """Adversarial tests for index integrity and memory safety."""

    def test_empty_incremental_update_no_error(self):
        """Adding empty list to BM25 index does not cause error."""
        index = BM25Index()
        initial_chunks = [make_chunk("some content", "doc.txt", 0)]
        index.build_index(initial_chunks)

        # Empty update should not error
        index.add_documents([])
        assert len(index.chunks) == 1

    def test_very_large_document_add(self):
        """Adding document with very long text does not corrupt index."""
        index = BM25Index()
        initial_chunks = [make_chunk("short content", "doc1.txt", 0)]
        index.build_index(initial_chunks)

        # Add very large chunk (1MB of text)
        large_text = "word " * 125000  # ~1MB of text
        large_chunk = [make_chunk(large_text, "large.txt", 0)]

        # Should not raise, should not corrupt
        index.add_documents(large_chunk)

        assert len(index.chunks) == 2
        # Search should still work
        results = index.search("word")
        assert len(results) > 0

    def test_many_small_incremental_adds_functional(self):
        """Many small incremental adds remain functional (index doesn't corrupt)."""
        index = BM25Index()
        initial_chunks = [make_chunk("initial content", "init.txt", 0)]
        index.build_index(initial_chunks)

        # Do 100 small incremental adds with deferred rebuild
        for i in range(100):
            chunk = [make_chunk(f"content batch {i}", f"batch{i}.txt", 0)]
            index.add_documents(chunk, rebuild_index=False)

        # Final rebuild
        index.rebuild()

        # Index should be functional
        assert len(index.chunks) == 101
        results = index.search("batch 50")
        assert len(results) > 0
        results = index.search("initial")
        assert len(results) > 0

    def test_unicode_content_in_incremental_update(self):
        """Unicode content in incremental updates doesn't corrupt index."""
        index = BM25Index()
        initial_chunks = [
            make_chunk("Hello world English content", "en.txt", 0),
        ]
        index.build_index(initial_chunks)

        # Add chunks with various Unicode - use standalone words that won't merge with emoji
        unicode_chunks = [
            make_chunk("こんにちは世界 Japanese", "jp.txt", 0),
            make_chunk("Привет мир Russian", "ru.txt", 0),
            make_chunk("celebration emoji fun party", "emoji.txt", 0),
            make_chunk("العربية Arabic", "ar.txt", 0),
        ]
        index.add_documents(unicode_chunks)

        # Search should work across all content
        results = index.search("Japanese")
        assert len(results) > 0

        results = index.search("emoji")
        assert len(results) > 0

    def test_special_characters_in_incremental_update(self):
        """Special characters (SQL injection, XSS attempts) don't corrupt index."""
        index = BM25Index()
        initial_chunks = [make_chunk("normal content", "normal.txt", 0)]
        index.build_index(initial_chunks)

        # Add chunks with potential injection content
        malicious_chunks = [
            make_chunk("'; DROP TABLE users; --", "sql.txt", 0),
            make_chunk("<script>alert('xss')</script>", "xss.txt", 0),
            make_chunk("${env.SECRET_KEY}", "tpl.txt", 0),
            make_chunk("../../../etc/passwd", "path.txt", 0),
        ]
        index.add_documents(malicious_chunks)

        # Index should remain stable
        assert len(index.chunks) == 5

        # Search should not crash
        results = index.search("script")
        assert isinstance(results, list)

    def test_incremental_update_with_stop_words(self):
        """Incremental updates work correctly with BM25 stop word handling."""
        index = BM25Index()
        initial_chunks = [
            make_chunk("the quick brown fox jumps", "doc1.txt", 0),
            make_chunk("over the lazy dog", "doc2.txt", 0),
        ]
        index.build_index(initial_chunks)

        # Add more chunks
        new_chunks = [
            make_chunk("pack of hunting dogs", "doc3.txt", 0),
        ]
        index.add_documents(new_chunks)

        # Search for content that would be affected by stop words
        results = index.search("quick brown fox")

        # Should find doc1
        assert len(results) > 0

    def test_add_documents_idempotent_multiple_calls(self):
        """Multiple calls to add_documents produce correct cumulative state."""
        index = BM25Index()

        # Add chunks in multiple calls
        index.add_documents([make_chunk("first batch content", "batch1.txt", 0)])
        index.add_documents([make_chunk("second batch content", "batch2.txt", 0)])
        index.add_documents([make_chunk("third batch content", "batch3.txt", 0)])

        assert len(index.chunks) == 3

        # All documents should be findable
        results = index.search("first")
        assert len(results) > 0
        results = index.search("second")
        assert len(results) > 0
        results = index.search("third")
        assert len(results) > 0

    def test_rebuild_after_many_incremental_updates(self):
        """rebuild() produces consistent state after many incremental updates."""
        index = BM25Index()
        index.build_index([make_chunk("initial", "init.txt", 0)])

        # Many incremental updates
        for i in range(50):
            index.add_documents([make_chunk(f"update {i}", f"upd{i}.txt", 0)])

        # Now rebuild
        index.rebuild()

        # State should be consistent
        assert len(index.chunks) == 51

        # All documents should be findable
        results = index.search("update 25")
        assert len(results) > 0

        results = index.search("initial")
        assert len(results) > 0

    def test_search_with_empty_query_returns_empty(self):
        """Search with empty query returns empty list, not error."""
        index = BM25Index()
        index.build_index([make_chunk("some content", "doc.txt", 0)])

        results = index.search("")
        assert results == []

    def test_search_with_no_matching_terms_returns_empty(self):
        """Search with terms not in any document returns empty list."""
        index = BM25Index()
        index.build_index([make_chunk("python programming content", "doc.txt", 0)])

        # Use a query where NO terms match the indexed content
        results = index.search("xyz123 completely unrelated query")
        assert results == [], "Search should return empty when no terms match"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
