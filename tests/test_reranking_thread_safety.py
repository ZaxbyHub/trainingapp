"""
Tests for thread-safe CrossEncoder loading in reranking.py.

Covers:
1. Five concurrent threads calling rerank() simultaneously get the same CrossEncoder model instance
2. CrossEncoder model loaded exactly once under concurrent access (constructor call count = 1)
3. Adversarial: 50 threads hammering rerank() don't deadlock
4. local_files_only=True is actually used (CrossEncoder won't try to download)
"""

import pytest
import threading
import time
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, call
from concurrent.futures import ThreadPoolExecutor, as_completed

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from document_processor import DocumentChunk


# ---------------------------------------------------------------------------
# Shared state for tracking CrossEncoder construction
# ---------------------------------------------------------------------------

_crossencoder_constructor_calls = []
_crossencoder_constructor_lock = threading.Lock()


def _make_mock_crossencoder():
    """Create a mock CrossEncoder class that tracks instantiation."""
    mock_model = MagicMock()
    mock_model.predict.return_value = [0.9, 0.8, 0.7, 0.6, 0.5]
    mock_model.model_name = "cross-encoder/ms-marco-TinyBERT-L-2"

    class MockCrossEncoder:
        """Mock CrossEncoder that tracks calls and returns predictable scores."""

        call_count = 0

        def __init__(self, model_name, local_files_only=False):
            global _crossencoder_constructor_calls
            with _crossencoder_constructor_lock:
                _crossencoder_constructor_calls.append({
                    'model_name': model_name,
                    'local_files_only': local_files_only,
                })
            MockCrossEncoder.call_count += 1
            self._mock_model = mock_model
            self.model_name = model_name

        def predict(self, sentence_pairs, **kwargs):
            return self._mock_model.predict(sentence_pairs)

    return MockCrossEncoder


@pytest.fixture(autouse=True)
def reset_crossencoder_tracking():
    """Reset CrossEncoder call tracking before each test."""
    global _crossencoder_constructor_calls
    _crossencoder_constructor_calls = []
    yield
    _crossencoder_constructor_calls = []


# ---------------------------------------------------------------------------
# Test 1: Five concurrent threads get the same model instance
# ---------------------------------------------------------------------------

class TestConcurrentRerankSameInstance:
    """Verify that 5 concurrent threads all receive the same CrossEncoder model instance."""

    def test_five_threads_concurrent_rerank_get_same_model(self):
        """Five threads calling rerank() simultaneously must all get identical model instance."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            # Re-import to pick up patched module
            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text 1", source="doc1.txt"),
                DocumentChunk(text="test text 2", source="doc2.txt"),
                DocumentChunk(text="test text 3", source="doc3.txt"),
            ]

            results = []
            model_ids = []
            barrier = threading.Barrier(5)

            def thread_target():
                barrier.wait()  # Synchronize threads to start simultaneously
                result = reranker.rerank("query", chunks, top_k=3)
                results.append(result)
                model_ids.append(id(reranker.model))

            threads = [threading.Thread(target=thread_target) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            # All threads must have received results
            assert len(results) == 5, f"Expected 5 results, got {len(results)}"

            # All threads must have gotten the exact same model instance
            distinct_model_ids = set(model_ids)
            assert len(distinct_model_ids) == 1, (
                f"Expected all threads to share same model instance, got {len(distinct_model_ids)} distinct instances: {distinct_model_ids}"
            )

            # All results must be non-empty
            for r in results:
                assert len(r) == 3, f"Expected 3 reranked results, got {len(r)}"

    def test_five_threads_concurrent_via_executor_get_same_model(self):
        """Five threads via ThreadPoolExecutor all get same model instance."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            model_ids = []
            with ThreadPoolExecutor(max_workers=5) as executor:
                futures = []
                for _ in range(5):
                    futures.append(executor.submit(reranker.rerank, "query", chunks, 1))

                for future in as_completed(futures):
                    future.result()
                    model_ids.append(id(reranker.model))

            distinct_ids = set(model_ids)
            assert len(distinct_ids) == 1, (
                f"ThreadPoolExecutor threads got {len(distinct_ids)} distinct model instances"
            )


# ---------------------------------------------------------------------------
# Test 2: CrossEncoder loaded exactly once under concurrent access
# ---------------------------------------------------------------------------

class TestCrossEncoderLoadedExactlyOnce:
    """Verify CrossEncoder constructor is called exactly once under concurrent load."""

    def test_constructor_called_exactly_once_under_concurrent_access(self):
        """CrossEncoder() must be instantiated exactly once even when 5 threads race."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            barrier = threading.Barrier(5)

            def thread_target():
                barrier.wait()
                reranker.rerank("query", chunks, top_k=1)

            threads = [threading.Thread(target=thread_target) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert MockCrossEncoder.call_count == 1, (
                f"Expected CrossEncoder constructor called exactly once, got {MockCrossEncoder.call_count} calls"
            )

    def test_constructor_called_exactly_once_under_adversarial_load(self):
        """CrossEncoder() instantiated exactly once even with 50 concurrent threads."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            num_threads = 50
            barrier = threading.Barrier(num_threads)

            def thread_target():
                barrier.wait()
                reranker.rerank("query", chunks, top_k=1)

            with ThreadPoolExecutor(max_workers=num_threads) as executor:
                futures = [executor.submit(thread_target) for _ in range(num_threads)]
                for future in as_completed(futures):
                    future.result()

            assert MockCrossEncoder.call_count == 1, (
                f"Expected 1 CrossEncoder call under adversarial load, got {MockCrossEncoder.call_count}"
            )


# ---------------------------------------------------------------------------
# Test 3: Adversarial - 50 threads hammering rerank() don't deadlock
# ---------------------------------------------------------------------------

class TestAdversarialHammering:
    """Adversarial tests: 50 threads hammering rerank() with no deadlocks."""

    def test_50_threads_no_deadlock(self):
        """50 threads hammering rerank() must complete without deadlock."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            num_threads = 50
            iterations_per_thread = 20
            barrier = threading.Barrier(num_threads)
            errors = []

            def thread_target():
                try:
                    barrier.wait()
                    for _ in range(iterations_per_thread):
                        reranker.rerank("query", chunks, top_k=1)
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=thread_target) for _ in range(num_threads)]
            for t in threads:
                t.start()

            # Wait with timeout to detect deadlock
            for t in threads:
                t.join(timeout=30)

            # Check no thread is still alive (would indicate deadlock)
            alive_threads = [t for t in threads if t.is_alive()]
            assert len(alive_threads) == 0, (
                f"{len(alive_threads)} threads deadlocked after 30s timeout"
            )

            assert len(errors) == 0, f"Errors during hammering: {errors}"

    def test_50_threads_all_get_same_model_instance(self):
        """50 threads hammering rerank() must all receive the same model instance."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            num_threads = 50
            results = []
            barrier = threading.Barrier(num_threads)
            results_lock = threading.Lock()

            def thread_target():
                barrier.wait()
                reranker.rerank("query", chunks, top_k=1)
                with results_lock:
                    results.append(id(reranker.model))

            threads = [threading.Thread(target=thread_target) for _ in range(num_threads)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            distinct_instances = set(results)
            assert len(distinct_instances) == 1, (
                f"Expected 1 distinct model instance, got {len(distinct_instances)}"
            )

    def test_rapid_fire_no_deadlock(self):
        """Rapid-fire calls from 50 threads complete without deadlock."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            num_threads = 50
            iterations = 50

            with ThreadPoolExecutor(max_workers=num_threads) as executor:
                futures = []
                for _ in range(iterations):
                    for _ in range(num_threads):
                        futures.append(executor.submit(reranker.rerank, "query", chunks, 1))

                # All must complete without error
                for future in as_completed(futures):
                    future.result()

            # Should have completed all 2500 calls without deadlock
            assert MockCrossEncoder.call_count == 1, (
                f"Expected 1 CrossEncoder call, got {MockCrossEncoder.call_count}"
            )


# ---------------------------------------------------------------------------
# Test 4: local_files_only=True is actually used
# ---------------------------------------------------------------------------

class TestLocalFilesOnly:
    """Verify that local_files_only=True is passed to CrossEncoder."""

    def test_local_files_only_true_passed_to_crossencoder(self):
        """CrossEncoder must be instantiated with local_files_only=True."""
        global _crossencoder_constructor_calls
        _crossencoder_constructor_calls = []
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            reranker.rerank("query", chunks, top_k=1)

            assert len(_crossencoder_constructor_calls) == 1, (
                f"Expected 1 CrossEncoder constructor call, got {len(_crossencoder_constructor_calls)}"
            )

            call_info = _crossencoder_constructor_calls[0]
            assert call_info['model_name'] == "cross-encoder/ms-marco-TinyBERT-L-2", (
                f"Expected default model name, got {call_info['model_name']}"
            )
            assert call_info['local_files_only'] is True, (
                f"Expected local_files_only=True, got {call_info['local_files_only']}"
            )

    def test_local_files_only_with_custom_model(self):
        """Custom model name is passed through with local_files_only=True."""
        global _crossencoder_constructor_calls
        _crossencoder_constructor_calls = []
        MockCrossEncoder = _make_mock_crossencoder()

        custom_model = "cross-encoder/ms-marco-MiniLM-L-2"

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker(model_name=custom_model)
            chunks = [
                DocumentChunk(text="test text", source="doc.txt"),
            ]

            reranker.rerank("query", chunks, top_k=1)

            assert len(_crossencoder_constructor_calls) == 1
            call_info = _crossencoder_constructor_calls[0]
            assert call_info['model_name'] == custom_model
            assert call_info['local_files_only'] is True

    def test_local_files_only_not_using_wrong_parameter_name(self):
        """Verify we test the actual local_files_only kwarg, not some other parameter."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            # Spy on the constructor to verify exact call signature
            original_init = MockCrossEncoder.__init__
            init_calls = []

            def tracking_init(self, model_name, local_files_only=False):
                init_calls.append({'model_name': model_name, 'local_files_only': local_files_only})
                original_init(self, model_name, local_files_only)

            MockCrossEncoder.__init__ = tracking_init

            reranker = CrossEncoderReranker()
            chunks = [DocumentChunk(text="test text", source="doc.txt")]
            reranker.rerank("query", chunks, top_k=1)

            assert len(init_calls) == 1
            assert init_calls[0]['local_files_only'] is True, (
                f"local_files_only must be True, got {init_calls[0]['local_files_only']}"
            )


# ---------------------------------------------------------------------------
# Test 5: Edge Cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Edge cases for CrossEncoder reranking."""

    def test_rerank_with_empty_chunks(self):
        """rerank() with empty chunks list returns empty list without error."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            result = reranker.rerank("query", [], top_k=5)

            assert result == [], f"Expected empty list for empty chunks, got {result}"

    def test_rerank_with_single_chunk(self):
        """rerank() with single chunk returns single result."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [DocumentChunk(text="only chunk", source="doc.txt")]
            result = reranker.rerank("query", chunks, top_k=1)

            assert len(result) == 1
            assert result[0][0].text == "only chunk"

    def test_rerank_top_k_greater_than_chunks(self):
        """rerank() with top_k > len(chunks) returns all chunks sorted."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            reranker = CrossEncoderReranker()
            chunks = [
                DocumentChunk(text="chunk1", source="doc.txt"),
                DocumentChunk(text="chunk2", source="doc.txt"),
            ]
            result = reranker.rerank("query", chunks, top_k=10)

            assert len(result) == 2, f"Expected 2 results, got {len(result)}"

    def test_model_loaded_on_first_rerank_not_on_init(self):
        """Model is not loaded during __init__, only on first rerank() call."""
        MockCrossEncoder = _make_mock_crossencoder()

        with patch.dict('sys.modules', {'sentence_transformers': MagicMock()}):
            import sentence_transformers as st_module
            st_module.CrossEncoder = MockCrossEncoder

            if 'reranking' in sys.modules:
                del sys.modules['reranking']
            from reranking import CrossEncoderReranker

            MockCrossEncoder.call_count = 0
            reranker = CrossEncoderReranker()

            assert MockCrossEncoder.call_count == 0, (
                "CrossEncoder should not be loaded during __init__"
            )
            assert reranker.model is None, "Model should not be loaded yet"

            chunks = [DocumentChunk(text="test", source="doc.txt")]
            reranker.rerank("query", chunks, top_k=1)

            assert MockCrossEncoder.call_count == 1, (
                "CrossEncoder should be loaded on first rerank() call"
            )
            assert reranker.model is not None, "Model should be loaded after rerank()"
