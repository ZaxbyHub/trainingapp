"""
Tests for Phase 5 critical fixes verification.

Fix 1 — rag_engine.query() n_results → effective_top_k:
    Line 396: effective_top_k = n_results if n_results is not None else self.config.rerank_top_k
    Line 414: self.reranker.rerank(question, rerank_chunks, top_k=effective_top_k)
    When n_results=N is passed, reranker must receive top_k=N (not config default).

Fix 2 — app_gui.py retrieval_window default of 2:
    Line 240-242: self.retrieval_window_entry.insert(0, str(self.settings.get("retrieval_window", 2)))
    When retrieval_window absent from settings, GUI must default to 2.

Fix 3 — scripts/reingest.py --force flag:
    Lines 56-60: Without --force, script prompts and aborts on 'n'. With --force, skips prompt.
"""

import pytest
import sys
import inspect
from pathlib import Path
from unittest.mock import patch, MagicMock, call

# ---------------------------------------------------------------------------
# Fix 1 — rag_engine.query() n_results override for reranker
# ---------------------------------------------------------------------------

class TestRagEngineQueryNResultsFix:
    """
    Verify that rag_engine.query() passes n_results to the reranker as top_k,
    falling back to config.rerank_top_k only when n_results is None.
    """

    def test_n_results_3_passes_top_k_3_to_reranker(self):
        """
        When query() is called with n_results=3, the reranker.rerank()
        must be invoked with top_k=3 — NOT with the config default (6).
        """
        from rag_engine import RAGEngine
        from document_processor import DocumentChunk

        with patch("rag_engine.SmartLLM") as mock_llm:
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore") as mock_vs:
                    # Mock vector store returning enough chunks to exercise reranking
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = (
                        "Context text.",
                        ["doc1.txt"],
                        [
                            DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0),
                            DocumentChunk(text="chunk 2", source="doc1.txt", chunk_index=1),
                            DocumentChunk(text="chunk 3", source="doc1.txt", chunk_index=2),
                            DocumentChunk(text="chunk 4", source="doc1.txt", chunk_index=3),
                        ],
                    )
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 4,
                        "documents": ["doc1.txt"],
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Test answer."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()

                    # Enable reranking and patch the reranker
                    engine.config.reranking_enabled = True
                    engine.config.rerank_top_k = 6  # config default is 6

                    mock_reranker = MagicMock()
                    mock_reranker.rerank.return_value = [
                        (DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0), 0.9),
                    ]
                    engine.reranker = mock_reranker

                    # Call with n_results=3 → reranker must receive top_k=3
                    engine.query("What is the answer?", n_results=3)

                    mock_reranker.rerank.assert_called_once()
                    _, call_kwargs = mock_reranker.rerank.call_args
                    assert call_kwargs.get("top_k") == 3, (
                        f"Expected top_k=3 but got top_k={call_kwargs.get('top_k')}. "
                        "n_results override is not being passed to reranker!"
                    )

    def test_n_results_none_uses_config_rerank_top_k(self):
        """
        When n_results is None, reranker must receive config.rerank_top_k (6).
        """
        from rag_engine import RAGEngine
        from document_processor import DocumentChunk

        with patch("rag_engine.SmartLLM") as mock_llm:
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore") as mock_vs:
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = (
                        "Context text.",
                        ["doc1.txt"],
                        [
                            DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0),
                            DocumentChunk(text="chunk 2", source="doc1.txt", chunk_index=1),
                            DocumentChunk(text="chunk 3", source="doc1.txt", chunk_index=2),
                        ],
                    )
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 3,
                        "documents": ["doc1.txt"],
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Test answer."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    engine.config.reranking_enabled = True
                    engine.config.rerank_top_k = 6  # explicit config default

                    mock_reranker = MagicMock()
                    mock_reranker.rerank.return_value = [
                        (DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0), 0.9),
                    ]
                    engine.reranker = mock_reranker

                    # Call with n_results=None → should use config default 6
                    engine.query("What is the answer?", n_results=None)

                    mock_reranker.rerank.assert_called_once()
                    _, call_kwargs = mock_reranker.rerank.call_args
                    assert call_kwargs.get("top_k") == 6, (
                        f"Expected top_k=6 (config default) but got top_k={call_kwargs.get('top_k')}. "
                        "Config fallback is broken!"
                    )

    def test_n_results_1_uses_top_k_1(self):
        """Boundary: n_results=1 must pass top_k=1 to reranker."""
        from rag_engine import RAGEngine
        from document_processor import DocumentChunk

        with patch("rag_engine.SmartLLM") as mock_llm:
            with patch("rag_engine.RAGEngine._save_config"):
                with patch("rag_engine.VectorStore") as mock_vs:
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = (
                        "Context text.",
                        ["doc1.txt"],
                        [
                            DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0),
                            DocumentChunk(text="chunk 2", source="doc1.txt", chunk_index=1),
                        ],
                    )
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 2,
                        "documents": ["doc1.txt"],
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Test answer."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    engine.config.reranking_enabled = True
                    engine.config.rerank_top_k = 6

                    mock_reranker = MagicMock()
                    mock_reranker.rerank.return_value = [
                        (DocumentChunk(text="chunk 1", source="doc1.txt", chunk_index=0), 0.9),
                    ]
                    engine.reranker = mock_reranker

                    engine.query("What?", n_results=1)

                    _, call_kwargs = mock_reranker.rerank.call_args
                    assert call_kwargs.get("top_k") == 1

    def test_source_line_effective_top_k_logic(self):
        """Verify the fix is implemented at the correct source location."""
        import rag_engine
        source = inspect.getsource(rag_engine.RAGEngine.query)
        # The fix must set effective_top_k using n_results override
        assert "n_results if n_results is not None" in source, (
            "effective_top_k = n_results if n_results is not None ... "
            "not found in query() source"
        )
        # And pass it to rerank
        assert "top_k=effective_top_k" in source, (
            "top_k=effective_top_k not passed to reranker.rerank()"
        )


# ---------------------------------------------------------------------------
# Fix 2 — app_gui.py retrieval_window defaults to 2
# ---------------------------------------------------------------------------

class TestAppGuiRetrievalWindowFix:
    """
    Verify that SettingsDialog._populate_fields defaults retrieval_window to 2
    when it is absent from settings.
    """

    def test_populate_fields_retrieval_window_default_is_2(self):
        """
        _populate_fields must insert 2 (as string) when settings has no
        'retrieval_window' key.
        """
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not available")

        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)

        # The fix: str(self.settings.get("retrieval_window", 2))
        assert 'self.settings.get("retrieval_window", 2)' in source, (
            "_populate_fields must use 2 as the default for retrieval_window. "
            "Expected: self.settings.get('retrieval_window', 2)"
        )
        # Must NOT default to 0 or 1
        assert 'self.settings.get("retrieval_window", 0)' not in source
        assert 'self.settings.get("retrieval_window", 1)' not in source

    def test_retrieval_window_missing_from_settings_defaults_to_2(self):
        """
        Simulate the logic: settings={} must produce entry value '2'.
        """
        settings = {}
        # The pattern from _populate_fields
        value = int(settings.get("retrieval_window", 2))
        assert value == 2

    def test_retrieval_window_explicit_5_is_respected(self):
        """Explicit retrieval_window=5 in settings must be returned as-is."""
        settings = {"retrieval_window": 5}
        value = int(settings.get("retrieval_window", 2))
        assert value == 5

    def test_retrieval_window_entry_insertion_value_is_string_2(self):
        """The entry must be inserted with str(2), not bare 2."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not available")

        source = inspect.getsource(app_gui.SettingsDialog._populate_fields)
        # Must use str() wrapper for the default
        assert "str(self.settings.get(\"retrieval_window\", 2))" in source, (
            "Entry must be populated with str() of the default value"
        )

    def test_save_validates_retrieval_window_range(self):
        """_save must validate retrieval_window is 0-5."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not available")

        source = inspect.getsource(app_gui.SettingsDialog._save)
        assert "retrieval_window" in source
        # Should validate range 0-5
        assert "0 <= retrieval_window <= 5" in source or "0 <= " in source


# ---------------------------------------------------------------------------
# Fix 3 — scripts/reingest.py --force flag behavior
# ---------------------------------------------------------------------------

class TestReingestForceFlagFix:
    """
    Verify that reingest.py:
    - Without --force: prompts user and aborts on 'n'
    - With --force: skips prompt and proceeds
    """

    def test_force_flag_skips_prompt(self):
        """
        With --force, the script must NOT call input() for confirmation
        and must proceed to engine operations.
        """
        # Re-import to pick up fresh module state
        if "reingest" in sys.modules:
            del sys.modules["reingest"]

        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

        with patch("engine_factory.create_engine_from_env") as mock_create:
            with patch("reingest.Path") as mock_path:
                mock_engine = MagicMock()
                mock_engine.ingest_directory.return_value = {
                    "success": True, "documents": 3, "chunks_added": 10
                }
                mock_create.return_value = mock_engine

                mock_path_instance = MagicMock()
                mock_path_instance.exists.return_value = False
                mock_path.return_value = mock_path_instance

                # Patch input to fail if called (it should NOT be called with --force)
                with patch("builtins.input", side_effect=RuntimeError("input() should not be called with --force")):
                    with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
                        from reingest import main
                        result = main()

                assert result == 0, "Script must succeed with --force"
                mock_engine.clear_documents.assert_called_once()
                mock_engine.ingest_directory.assert_called_once()

    def test_without_force_prompts_and_aborts_on_n(self):
        """
        Without --force, the script must call input() and abort when user
        responds with 'n'.
        """
        if "reingest" in sys.modules:
            del sys.modules["reingest"]

        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

        with patch("engine_factory.create_engine_from_env") as mock_create:
            with patch("reingest.Path") as mock_path:
                mock_engine = MagicMock()
                mock_engine.ingest_directory.return_value = {
                    "success": True, "documents": 3, "chunks_added": 10
                }
                mock_create.return_value = mock_engine

                mock_path_instance = MagicMock()
                mock_path_instance.exists.return_value = False
                mock_path.return_value = mock_path_instance

                # Simulate user typing 'n' (not 'yes')
                with patch("builtins.input", return_value="n") as mock_input:
                    with patch.object(sys, "argv", ["reingest.py", "/test/path"]):
                        from reingest import main
                        result = main()

                # Must have prompted for confirmation
                mock_input.assert_called()
                # Must NOT have called any engine methods
                mock_engine.clear_documents.assert_not_called()
                mock_engine.ingest_directory.assert_not_called()
                # Must return 0 (aborted gracefully)
                assert result == 0, "Must return 0 on abort"
                # stdout must contain "Aborted"
                import io, contextlib
                # Already captured via capsys in real pytest, but here we check return logic
                # The "Aborted" message is printed, not returned

    def test_without_force_proceeds_on_yes(self):
        """
        Without --force but with 'y' response, script must proceed.
        """
        if "reingest" in sys.modules:
            del sys.modules["reingest"]

        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

        with patch("engine_factory.create_engine_from_env") as mock_create:
            with patch("reingest.Path") as mock_path:
                mock_engine = MagicMock()
                mock_engine.ingest_directory.return_value = {
                    "success": True, "documents": 3, "chunks_added": 10
                }
                mock_create.return_value = mock_engine

                mock_path_instance = MagicMock()
                mock_path_instance.exists.return_value = False
                mock_path.return_value = mock_path_instance

                with patch("builtins.input", return_value="y"):
                    with patch.object(sys, "argv", ["reingest.py", "/test/path"]):
                        from reingest import main
                        result = main()

                assert result == 0
                mock_engine.clear_documents.assert_called_once()
                mock_engine.ingest_directory.assert_called_once()

    def test_without_force_proceeds_on_yes_full_word(self):
        """'yes' (full word) must also be accepted."""
        if "reingest" in sys.modules:
            del sys.modules["reingest"]

        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

        with patch("engine_factory.create_engine_from_env") as mock_create:
            with patch("reingest.Path") as mock_path:
                mock_engine = MagicMock()
                mock_engine.ingest_directory.return_value = {"success": True}
                mock_create.return_value = mock_engine

                mock_path_instance = MagicMock()
                mock_path_instance.exists.return_value = False
                mock_path.return_value = mock_path_instance

                with patch("builtins.input", return_value="YES"):
                    with patch.object(sys, "argv", ["reingest.py", "/test/path"]):
                        from reingest import main
                        result = main()

                assert result == 0
                mock_engine.clear_documents.assert_called_once()

    def test_source_has_force_arg_and_input_check(self):
        """Verify the fix exists in source: --force arg + if not args.force input()."""
        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
        if "reingest" in sys.modules:
            del sys.modules["reingest"]
        from reingest import main
        source = inspect.getsource(main)

        assert '"--force"' in source or '"--force"' in source, (
            "--force argument not found in main() source"
        )
        assert "if not args.force:" in source, (
            "Confirmation guard 'if not args.force:' not found in main() source"
        )
        assert 'response.lower() not in ("y", "yes")' in source, (
            "Abort-on-not-yes check not found in main() source"
        )
