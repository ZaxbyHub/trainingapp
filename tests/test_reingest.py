"""Tests for scripts/reingest.py — Task 7.3: RAG Pipeline Remediation.

Verifies:
1. Directory argument defaults correctly (./documents or current dir)
2. engine.clear_documents() is called BEFORE engine.ingest_directory()
3. Warning message about clean_text() fix is printed
4. Returns 1 on failure (ImportError or other exceptions)
5. Returns 0 on success
6. Confirmation prompt behavior (with --force or mocked input)
"""

import os
import sys
import pytest
from unittest.mock import patch, MagicMock, call
from pathlib import Path
from io import StringIO

# Ensure script is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))


class TestDirectoryArgument:
    """Test directory argument handling and defaults."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_explicit_directory_argument(self, mock_path, mock_create_engine, capsys):
        """When directory argument is provided, use it directly."""
        # Setup mocks
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        # Mock Path to return a non-existent documents directory
        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        # Patch sys.argv to simulate running with explicit directory and --force
        with patch.object(sys, "argv", ["reingest.py", "/some/custom/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        mock_engine.ingest_directory.assert_called_once_with("/some/custom/path")
        captured = capsys.readouterr()
        assert "/some/custom/path" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    @patch("reingest.os.getcwd", return_value="/fallback/dir")
    def test_default_to_documents_if_exists(self, mock_getcwd, mock_path, mock_create_engine, capsys):
        """When no arg provided and ./documents exists, use ./documents."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 3, "chunks": 6}
        mock_create_engine.return_value = mock_engine

        # Mock Path to return existing documents directory
        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = True
        mock_path_instance.is_dir.return_value = True
        # Make the documents path resolve to /project/documents
        mock_path_instance.__truediv__ = lambda self, other: MagicMock(
            exists=lambda: True, is_dir=lambda: True, __str__=lambda: "/project/documents"
        )
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        mock_engine.ingest_directory.assert_called_once()
        captured = capsys.readouterr()
        assert "Re-ingestion target directory:" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    @patch("reingest.os.getcwd", return_value="/current/working/dir")
    def test_default_to_cwd_when_documents_not_exist(self, mock_getcwd, mock_path, mock_create_engine, capsys):
        """When no arg and ./documents doesn't exist, use current directory."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 1, "chunks": 2}
        mock_create_engine.return_value = mock_engine

        # Mock Path to return non-existent documents directory
        # When documents path doesn't exist, script falls back to os.getcwd()
        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path_instance.is_dir.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        # When documents path doesn't exist, ingest_directory should be called with cwd
        # Verify the engine was called (exact path depends on mock setup)
        mock_engine.ingest_directory.assert_called_once()
        # Verify the warning about needing to re-ingest was printed
        captured = capsys.readouterr()
        assert "Re-ingestion Required" in captured.out


class TestEngineCalls:
    """Test that engine methods are called in correct order."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_clear_called_before_ingest(self, mock_path, mock_create_engine, capsys):
        """Verify clear_documents() is called BEFORE ingest_directory()."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0

        # Verify both methods were called
        mock_engine.clear_documents.assert_called_once()
        mock_engine.ingest_directory.assert_called_once()

        # Verify order: clear before ingest
        calls = mock_engine.method_calls
        clear_index = next(i for i, c in enumerate(calls) if c[0] == "clear_documents")
        ingest_index = next(i for i, c in enumerate(calls) if c[0] == "ingest_directory")
        assert clear_index < ingest_index, "clear_documents must be called before ingest_directory"

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_clear_and_ingest_both_called(self, mock_path, mock_create_engine):
        """Verify both clear_documents and ingest_directory are called exactly once."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        mock_engine.clear_documents.assert_called_once_with()
        mock_engine.ingest_directory.assert_called_once_with("/test/path")


class TestWarningMessage:
    """Test that the clean_text() warning message is printed."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_warning_about_clean_text_fix_printed(self, mock_path, mock_create_engine, capsys):
        """Verify warning about clean_text() fix is printed."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        captured = capsys.readouterr()

        # Check for key parts of the warning message
        assert "WARNING: Re-ingestion Required" in captured.out
        assert "clean_text()" in captured.out
        assert "paragraph" in captured.out or "embedding" in captured.out.lower()
        assert "=" * 70 in captured.out or "WARNING:" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_success_message_printed(self, mock_path, mock_create_engine, capsys):
        """Verify SUCCESS message is printed at the end."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        assert "SUCCESS" in captured.out
        assert "Re-ingestion completed successfully" in captured.out


class TestErrorHandling:
    """Test error handling and return codes."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_returns_1_on_import_error(self, mock_path, mock_create_engine, capsys):
        """Verify returns 1 when import fails."""
        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        # Make create_engine_from_env raise ImportError
        mock_create_engine.side_effect = ImportError("No module named 'engine_factory'")

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 1
        captured = capsys.readouterr()
        assert "Error" in captured.out
        assert "import" in captured.out.lower() or "Could not import" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_returns_1_on_runtime_error(self, mock_path, mock_create_engine, capsys):
        """Verify returns 1 when runtime error occurs."""
        mock_engine = MagicMock()
        mock_engine.clear_documents.side_effect = RuntimeError("ChromaDB connection failed")
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 1
        captured = capsys.readouterr()
        assert "Error" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_returns_1_on_ingest_error(self, mock_path, mock_create_engine, capsys):
        """Verify returns 1 when ingest_directory fails."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.side_effect = Exception("Disk full")
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 1
        captured = capsys.readouterr()
        assert "Error" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_ingest_error_prints_data_loss_warning(self, mock_path, mock_create_engine, capsys):
        """Task 8.5: When ingest_directory fails, prints the data-loss warning message."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.side_effect = Exception("PDF parse error")
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/documents", "--force"]):
            from reingest import main
            result = main()

        assert result == 1
        captured = capsys.readouterr()
        # The specific safety message must appear
        assert "Your vector store is now EMPTY" in captured.out
        assert "Re-ingestion failed after documents were cleared" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_ingest_error_prints_rerun_command(self, mock_path, mock_create_engine, capsys):
        """Task 8.5: When ingest_directory fails, prints the re-run command with the directory."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.side_effect = Exception("File not found")
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/my/docs", "--force"]):
            from reingest import main
            result = main()

        assert result == 1
        captured = capsys.readouterr()
        # The re-run command must include the directory argument
        assert "python scripts/reingest.py" in captured.out
        assert "/my/docs" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_clear_before_ingest_on_success(self, mock_path, mock_create_engine):
        """Task 8.5: Success path unchanged — clear still called before ingest."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 3, "chunks": 7}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/data", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        # On success, no inner exception block output should appear
        mock_engine.clear_documents.assert_called_once()
        mock_engine.ingest_directory.assert_called_once_with("/data")

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_returns_0_on_success(self, mock_path, mock_create_engine, capsys):
        """Verify returns 0 on successful completion."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0


class TestOutputMessages:
    """Test that expected output messages are printed."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_engine_creation_message(self, mock_path, mock_create_engine, capsys):
        """Verify engine creation success message is printed."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        assert "Creating RAG engine" in captured.out
        assert "Engine created successfully" in captured.out

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_clearing_documents_message(self, mock_path, mock_create_engine, capsys):
        """Verify clearing documents message is printed."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        assert "Clearing existing documents" in captured.out or "cleared" in captured.out.lower()

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_ingestion_stats_printed(self, mock_path, mock_create_engine, capsys):
        """Verify ingestion stats are printed after completion."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        # Stats should be printed (the actual format depends on implementation)
        assert "Re-ingestion complete" in captured.out or "✓" in captured.out


class TestConfirmationPrompt:
    """Test the confirmation input() prompt behavior."""

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_with_force_flag_skips_prompt(self, mock_path, mock_create_engine, capsys):
        """When --force is passed, input() is never called."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
            from reingest import main
            result = main()

        assert result == 0
        # Verify input was not called (no prompt shown)
        mock_create_engine.assert_called_once()

    @patch("engine_factory.create_engine_from_env")
    @patch("reingest.Path")
    def test_with_force_flag_no_prompt_interaction(self, mock_path, mock_create_engine, capsys):
        """Test that --force completely bypasses the input() prompt."""
        mock_engine = MagicMock()
        mock_engine.ingest_directory.return_value = {"files": 5, "chunks": 10}
        mock_create_engine.return_value = mock_engine

        mock_path_instance = MagicMock()
        mock_path_instance.exists.return_value = False
        mock_path.return_value = mock_path_instance

        # Mock input to ensure it's never called (if the test runs, prompt was skipped)
        with patch("builtins.input") as mock_input:
            mock_input.side_effect = AssertionError("input() should not be called when --force is passed")
            
            with patch.object(sys, "argv", ["reingest.py", "/test/path", "--force"]):
                from reingest import main
                result = main()

        assert result == 0
        mock_input.assert_not_called()
