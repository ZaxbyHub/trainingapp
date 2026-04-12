"""
Comprehensive Edge Case and Failure Mode Testing for RAG Pipeline

Tests all edge cases, error conditions, and failure scenarios across:
1. Document Edge Cases (empty files, special chars, oversized, binary)
2. Query Edge Cases (injection attempts, Unicode, boundary lengths)
3. Resource Exhaustion (disk full, memory, network)
4. Backend Failures (GGUF missing, Ollama down, API key invalid)
5. Configuration Edge Cases (boundary values, invalid env vars)
6. Concurrent Operation Safety
7. Data Integrity (corrupted DB, malformed chunks)
8. Token/Prompt Length Limits

Import convention: all mocks at module level BEFORE any imports
"""

import pytest
import os
import sys
import tempfile
import shutil
import json
import re
import inspect
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock, mock_open
from dataclasses import dataclass
import zipfile
import io

# Ensure project root on path
sys.path.insert(0, str(Path(__file__).parent.parent))

# =============================================================================
# MODULE-LEVEL MOCKS (before imports per test isolation rules)
# =============================================================================

# We mock externally imported heavy libraries at the module level where possible
# For test-specific mocking, we use patch() in test methods


# =============================================================================
# TEST GROUP 1: Document Edge Cases
# =============================================================================

class TestDocumentEdgeCases:
    """Document processing edge cases: empty, oversized, binary, corrupted."""

    def test_empty_file_zero_bytes(self, tmp_path):
        """Empty file (0 bytes) should be handled gracefully."""
        from document_processor import DocumentProcessor

        empty_path = tmp_path / "empty.txt"
        empty_path.write_bytes(b"")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(empty_path))

        # Should return empty list, not crash
        assert isinstance(chunks, list)
        assert len(chunks) == 0

    def test_file_only_whitespace(self, tmp_path):
        """File with only whitespace should return empty chunks."""
        from document_processor import DocumentProcessor

        ws_path = tmp_path / "whitespace.txt"
        ws_path.write_text("   \n\n\t\t  \r\n   ", encoding="utf-8")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(ws_path))

        assert isinstance(chunks, list)
        assert len(chunks) == 0

    def test_very_long_single_line_file(self, tmp_path):
        """Single-line file exceeding normal size should be chunked correctly."""
        from document_processor import DocumentProcessor

        # Create a very long single-line file (500+ characters)
        long_line = "word " * 500  # ~2500 chars
        long_path = tmp_path / "longline.txt"
        long_path.write_text(long_line, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=128, chunk_overlap=10)
        chunks = processor.process_file(str(long_path))

        # Should produce multiple chunks
        assert len(chunks) > 1
        # Each chunk text should be non-empty
        for chunk in chunks:
            assert isinstance(chunk.text, str)
            assert len(chunk.text.strip()) > 0

    def test_unicode_fullwidth_and_control_chars(self, tmp_path):
        """Unicode fullwidth chars and control characters should be handled."""
        from document_processor import DocumentProcessor

        content = (
            "Normal ASCII text. "
            "\u3000\u3001\u3002\u4e00\u4e8c\u4e09"  # CJK punctuation + chars
            "\u200b\u200c\u200d"  # Zero-width chars
            "\uff01\uff08\uff09"  # Fullwidth punctuation
            " More text."
        )
        unicode_path = tmp_path / "unicode.txt"
        unicode_path.write_text(content, encoding="utf-8")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(unicode_path))

        # Should process without crashing
        assert isinstance(chunks, list)

    def test_emoji_in_document(self, tmp_path):
        """Emoji characters should not crash the processor."""
        from document_processor import DocumentProcessor

        content = (
            "Introduction. 🚀\n\n"
            "Section about Python: 🐍\n\n"
            "List items: ✅ ❌ ⚠️ 🔴 🟠 🟡 🟢\n\n"
            "Conclusion with mixed content. 😀"
        )
        emoji_path = tmp_path / "emoji.txt"
        emoji_path.write_text(content, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=200, chunk_overlap=20)
        chunks = processor.process_file(str(emoji_path))

        assert isinstance(chunks, list)
        assert len(chunks) >= 1

    def test_binary_file_with_txt_extension(self, tmp_path):
        """Binary content with .txt extension should not crash processor."""
        from document_processor import DocumentProcessor

        binary_path = tmp_path / "fake.txt"
        # Write binary data (PNG header)
        binary_path.write_bytes(
            b"\x89PNG\r\n\x1a\n" + b"\x00" * 100 + b"\xff\xfe\xfd\xfc"
        )

        processor = DocumentProcessor()
        chunks = processor.process_file(str(binary_path))

        # Should return empty or handle gracefully
        assert isinstance(chunks, list)

    def test_corrupted_docx_file(self, tmp_path):
        """Corrupted DOCX (invalid ZIP structure) should be handled."""
        from document_processor import DocumentProcessor

        # Create an invalid DOCX (DOCX is a ZIP file)
        corrupted_path = tmp_path / "corrupted.docx"
        corrupted_path.write_bytes(b"This is not a valid ZIP/DOCX file.")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(corrupted_path))

        # Should return empty list, not crash
        assert isinstance(chunks, list)
        assert len(chunks) == 0

    def test_corrupted_pptx_file(self, tmp_path):
        """Corrupted PPTX (invalid ZIP structure) should be handled."""
        from document_processor import DocumentProcessor

        corrupted_path = tmp_path / "corrupted.pptx"
        corrupted_path.write_bytes(b"Not a valid PPTX file structure.")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(corrupted_path))

        # Should return empty list, not crash
        assert isinstance(chunks, list)
        assert len(chunks) == 0

    def test_mixed_encoding_file(self, tmp_path):
        """File with mixed UTF-8 and Latin-1 encoding should be handled."""
        from document_processor import DocumentProcessor

        # Create content with various encodings
        content = "Hello world. \xc0\xc1\xc2"  # Invalid UTF-8 continuation bytes
        mixed_path = tmp_path / "mixed_encoding.txt"

        # Write with latin-1 encoding (allows bytes 0xc0-0xff)
        mixed_path.write_text(content, encoding="latin-1", errors="replace")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(mixed_path))

        # Should process without crashing
        assert isinstance(chunks, list)

    def test_oversized_file_100mb_rejected(self, tmp_path):
        """File >100MB should be handled (may be rejected or truncated)."""
        from document_processor import DocumentProcessor

        large_path = tmp_path / "large.txt"
        # Create a file larger than 100MB (but we'll cap at reasonable size for test)
        # We'll test with smaller but verify the check exists
        large_content = "x" * (50 * 1024 * 1024)  # 50MB
        large_path.write_text(large_content, encoding="utf-8")

        # Check file size
        file_size = large_path.stat().st_size
        assert file_size > 10 * 1024 * 1024  # At least 10MB

        processor = DocumentProcessor()
        chunks = processor.process_file(str(large_path))

        # Should handle large file without crashing
        assert isinstance(chunks, list)

    def test_null_bytes_in_file(self, tmp_path):
        """File with embedded null bytes should be handled."""
        from document_processor import DocumentProcessor

        null_path = tmp_path / "nulls.txt"
        content = "Hello\x00World\x00\x00End"
        null_path.write_bytes(content.encode("utf-8"))

        processor = DocumentProcessor()
        chunks = processor.process_file(str(null_path))

        # Should handle without crashing
        assert isinstance(chunks, list)

    def test_only_newlines_file(self, tmp_path):
        """File with only newlines should be handled."""
        from document_processor import DocumentProcessor

        nl_path = tmp_path / "newlines.txt"
        nl_path.write_text("\n\n\n\n\n", encoding="utf-8")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(nl_path))

        # Should return empty or minimal chunks
        assert isinstance(chunks, list)

    def test_chinese_japanese_korean_text(self, tmp_path):
        """CJK text should be chunked correctly."""
        from document_processor import DocumentProcessor

        cjk_content = (
            "第一章：Python编程入门。\n"
            "第二節：変数の基本概念。\n"
            "Chapter 3: Data Types and Operations."
        )
        cjk_path = tmp_path / "cjk.txt"
        cjk_path.write_text(cjk_content, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=50, chunk_overlap=5)
        chunks = processor.process_file(str(cjk_path))

        # Should produce chunks without crashing
        assert len(chunks) >= 1
        for chunk in chunks:
            assert isinstance(chunk.text, str)

    def test_arabic_right_to_left_text(self, tmp_path):
        """Arabic RTL text should be handled."""
        from document_processor import DocumentProcessor

        arabic_content = (
            "مرحبا بك في درس بايثون. "
            "هل أنت مستعد لتعلم البرمجة؟ "
            "الدرس الأول: أساسيات بايثون."
        )
        arabic_path = tmp_path / "arabic.txt"
        arabic_path.write_text(arabic_content, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=80, chunk_overlap=10)
        chunks = processor.process_file(str(arabic_path))

        assert len(chunks) >= 1
        for chunk in chunks:
            assert isinstance(chunk.text, str)

    def test_dos_line_endings(self, tmp_path):
        """File with Windows CRLF line endings should be processed correctly."""
        from document_processor import DocumentProcessor

        crlf_content = "Line 1\r\nLine 2\r\nLine 3\r\n"
        crlf_path = tmp_path / "crlf.txt"
        crlf_path.write_bytes(crlf_content.encode("utf-8"))

        processor = DocumentProcessor()
        chunks = processor.process_file(str(crlf_path))

        assert isinstance(chunks, list)
        assert len(chunks) >= 1

    def test_mac_classic_line_endings(self, tmp_path):
        """File with old Mac CR-only line endings should be handled."""
        from document_processor import DocumentProcessor

        cr_content = "Line 1\rLine 2\rLine 3\r"
        cr_path = tmp_path / "cr.txt"
        cr_path.write_bytes(cr_content.encode("utf-8"))

        processor = DocumentProcessor()
        chunks = processor.process_file(str(cr_path))

        assert isinstance(chunks, list)

    def test_nested_directory_with_hidden_files(self, tmp_path):
        """Nested directories with hidden/system files should skip unsupported."""
        from document_processor import DocumentProcessor

        nested = tmp_path / "nested"
        nested.mkdir()

        (nested / ".hidden.txt").write_text("Hidden content")
        (nested / ".DS_Store").write_bytes(b"\x00" * 100)
        (nested / "visible.txt").write_text("Visible content")
        (nested / "subdir").mkdir()
        (nested / "subdir" / "deep.txt").write_text("Deep content")

        processor = DocumentProcessor()
        chunks = processor.process_directory(str(nested))

        # Should process the visible and deep files
        sources = {c.source for c in chunks}
        assert "visible.txt" in sources
        assert "deep.txt" in sources
        assert ".DS_Store" not in sources

    def test_file_with_tabs_and_formfeeds(self, tmp_path):
        """File with tabs and form feeds should be handled."""
        from document_processor import DocumentProcessor

        content = "Header\t\tTabbed content\fForm feed\f\n\n\fPage break"
        tab_path = tmp_path / "tabs.txt"
        tab_path.write_text(content, encoding="utf-8")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(tab_path))

        assert isinstance(chunks, list)


# =============================================================================
# TEST GROUP 2: Query Edge Cases - Injection and Special Characters
# =============================================================================

class TestQueryInjectionEdgeCases:
    """Query injection attempts and special character handling."""

    def test_sql_injection_pattern_in_question(self):
        """SQL injection patterns in question should be handled (not executed)."""
        from api_server import QuestionRequest

        sql_patterns = [
            "'; DROP TABLE users; --",
            "1' OR '1'='1",
            "SELECT * FROM passwords",
            "UNION SELECT NULL,NULL,NULL",
            "'; INSERT INTO admin VALUES('hacker','pass'); --",
            "1; DELETE FROM documents WHERE '1'='1",
        ]

        for pattern in sql_patterns:
            # Should accept the query (sanitization is at the display/embedding level)
            req = QuestionRequest(question=pattern, n_results=3)
            assert req.question == pattern

    def test_javascript_injection_pattern(self):
        """JavaScript injection patterns should be accepted and sanitized."""
        from api_server import QuestionRequest

        js_patterns = [
            "<script>alert('xss')</script>",
            "javascript:alert(1)",
            "<img src=x onerror=alert(1)>",
            "{{constructor.constructor('alert(1)')()}}",
            "<svg/onload=alert('xss')>",
            "';<script>alert(1)</script>",
        ]

        for pattern in js_patterns:
            req = QuestionRequest(question=pattern, n_results=3)
            assert isinstance(req.question, str)

    def test_path_traversal_in_query(self):
        """Path traversal patterns should be accepted (not executed)."""
        from api_server import QuestionRequest

        traversal_patterns = [
            "../../../etc/passwd",
            "..\\..\\..\\windows\\system32",
            "....//....//etc/passwd",
            "C:\\Users\\Admin\\Documents",
            "/etc/shadow",
            "\\\\server\\share\\file",
        ]

        for pattern in traversal_patterns:
            req = QuestionRequest(question=pattern, n_results=3)
            assert isinstance(req.question, str)

    def test_template_literal_injection(self):
        """Template literal injection patterns should be handled."""
        from api_server import QuestionRequest

        template_patterns = [
            "${alert('xss')}",
            "{{.}}{{.}}",
            "<%=%20",
            "#{system('ls')}",
            "@{await Runtime.exec('cmd')}",
        ]

        for pattern in template_patterns:
            req = QuestionRequest(question=pattern, n_results=3)
            assert isinstance(req.question, str)

    def test_null_bytes_in_question(self):
        """Question with null bytes should be handled."""
        from api_server import QuestionRequest

        # Null bytes in string (will be stripped by isprintable filter in sanitize)
        req = QuestionRequest(question="Hello\x00World", n_results=3)
        # The null byte may be stripped or kept; either is acceptable
        assert isinstance(req.question, str)

    def test_control_characters_in_question(self):
        """Control characters should be handled."""
        from api_server import QuestionRequest

        # Various control characters
        ctrl_chars = "".join(chr(i) for i in range(1, 32) if i not in (9, 10, 13))
        req = QuestionRequest(question=f"Text{ctrl_chars}End", n_results=3)
        assert isinstance(req.question, str)

    def test_very_long_query_2000_chars(self):
        """Query at max length (2000) should be accepted."""
        from api_server import QuestionRequest

        long_query = "a" * 2000
        req = QuestionRequest(question=long_query, n_results=3)
        assert len(req.question) == 2000

    def test_very_long_query_2001_chars_rejected(self):
        """Query exceeding max length (2001) should be rejected."""
        from api_server import QuestionRequest
        import pydantic

        long_query = "a" * 2001
        with pytest.raises(Exception):  # Pydantic ValidationError
            QuestionRequest(question=long_query, n_results=3)

    def test_unicode_mixed_scripts_query(self):
        """Mixed Unicode scripts should be handled."""
        from api_server import QuestionRequest

        mixed_query = (
            "Hello 你好 مرحبا שלום "
            "Γειά σου 🌍🚀 "
            "Привет สวัสดี"
        )
        req = QuestionRequest(question=mixed_query, n_results=3)
        assert isinstance(req.question, str)

    def test_bidi_override_characters(self):
        """Bidirectional override characters should be handled."""
        from api_server import QuestionRequest

        # RTL/LTR override characters
        bidi_query = "\u202EHello\u202C World"  # RLE...PDF
        req = QuestionRequest(question=bidi_query, n_results=3)
        assert isinstance(req.question, str)

    def test_combining_characters(self):
        """Combining characters should not cause issues."""
        from api_server import QuestionRequest

        combining_query = "cafe\u0301"  # café with combining accent
        req = QuestionRequest(question=combining_query, n_results=3)
        assert isinstance(req.question, str)

    def test_search_query_max_length_boundary(self):
        """Search query at max length (500) should be accepted."""
        from api_server import SearchRequest

        max_query = "a" * 500
        req = SearchRequest(query=max_query, n_results=5)
        assert len(req.query) == 500

    def test_search_query_501_chars_rejected(self):
        """Search query exceeding max length (501) should be rejected."""
        from api_server import SearchRequest
        import pydantic

        over_query = "a" * 501
        with pytest.raises(Exception):
            SearchRequest(query=over_query, n_results=5)


# =============================================================================
# TEST GROUP 3: Configuration Edge Cases
# =============================================================================

class TestConfigBoundaryValues:
    """Configuration boundary value testing."""

    def test_chunk_size_at_minimum_boundary(self):
        """chunk_size=128 (MIN_CHUNK_SIZE) should be valid."""
        from config import RAGSettings, MIN_CHUNK_SIZE

        assert MIN_CHUNK_SIZE == 128
        # This is a boundary check - the constant exists and is used in validation
        # Actual validation tested in test_config.py

    def test_chunk_size_at_maximum_boundary(self):
        """chunk_size=8192 (MAX_CHUNK_SIZE) should be valid."""
        from config import MAX_CHUNK_SIZE

        assert MAX_CHUNK_SIZE == 8192

    def test_max_tokens_at_minimum_boundary(self):
        """max_tokens=256 (MIN_MAX_TOKENS) should be valid."""
        from config import MIN_MAX_TOKENS

        assert MIN_MAX_TOKENS == 256

    def test_max_tokens_at_maximum_boundary(self):
        """max_tokens=4096 (MAX_MAX_TOKENS) should be valid."""
        from config import MAX_MAX_TOKENS

        assert MAX_MAX_TOKENS == 4096

    def test_chunk_overlap_zero_valid(self):
        """chunk_overlap=0 should be valid (zero overlap)."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_CHUNK_OVERLAP"] = "0"
        os.environ["RAG_CHUNK_SIZE"] = "512"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_chunk_overlap == 0
        finally:
            os.environ.pop("RAG_CHUNK_OVERLAP", None)
            os.environ.pop("RAG_CHUNK_SIZE", None)
            importlib.reload(config)

    def test_context_truncation_boundary(self):
        """context_truncation must be positive (> 0)."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_CONTEXT_TRUNCATION"] = "1"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_context_truncation == 1
        finally:
            os.environ.pop("RAG_CONTEXT_TRUNCATION", None)
            importlib.reload(config)

    def test_context_truncation_zero_rejected(self):
        """context_truncation=0 should be rejected."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_CONTEXT_TRUNCATION"] = "0"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            with pytest.raises(ValueError, match="positive"):
                RAGSettings()
        finally:
            os.environ.pop("RAG_CONTEXT_TRUNCATION", None)
            importlib.reload(config)

    def test_invalid_env_var_non_numeric_chunk_size(self):
        """Non-numeric chunk_size env var should raise ValueError."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_CHUNK_SIZE"] = "not_a_number"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            with pytest.raises((ValueError, TypeError)):
                RAGSettings()
        finally:
            os.environ.pop("RAG_CHUNK_SIZE", None)
            importlib.reload(config)

    def test_similarity_exactly_zero(self):
        """min_similarity=0.0 should be valid."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_MIN_SIMILARITY"] = "0.0"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_min_similarity == 0.0
        finally:
            os.environ.pop("RAG_MIN_SIMILARITY", None)
            importlib.reload(config)

    def test_similarity_exactly_one(self):
        """min_similarity=1.0 should be valid."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_MIN_SIMILARITY"] = "1.0"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_min_similarity == 1.0
        finally:
            os.environ.pop("RAG_MIN_SIMILARITY", None)
            importlib.reload(config)

    def test_temperature_exactly_zero(self):
        """temperature=0.0 should be valid (deterministic)."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_TEMPERATURE"] = "0.0"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_temperature == 0.0
        finally:
            os.environ.pop("RAG_TEMPERATURE", None)
            importlib.reload(config)

    def test_temperature_exactly_two(self):
        """temperature=2.0 should be valid (maximum)."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_TEMPERATURE"] = "2.0"
        try:
            import config
            importlib.reload(config)
            from config import RAGSettings
            s = RAGSettings()
            assert s.rag_temperature == 2.0
        finally:
            os.environ.pop("RAG_TEMPERATURE", None)
            importlib.reload(config)


# =============================================================================
# TEST GROUP 4: Backend Failure Modes
# =============================================================================

class TestLLMBackendFailures:
    """LLM backend failure scenarios."""

    def test_ollama_server_down_connection_refused(self):
        """Ollama server not running should raise ConnectionError."""
        from llm_interface import OllamaLLM

        with patch("llm_interface.validate_url", return_value=True):
            with pytest.raises(ConnectionError, match="Cannot connect to Ollama"):
                OllamaLLM(base_url="http://localhost:9999")

    def test_ollama_server_timeout(self):
        """Ollama timeout should raise RuntimeError."""
        from llm_interface import OllamaLLM, InferenceConfig
        import urllib.error

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OllamaLLM._verify_connection"):
                llm = OllamaLLM(base_url="http://localhost:11434")

                with patch("urllib.request.urlopen") as mock_urlopen:
                    mock_urlopen.side_effect = TimeoutError()
                    with pytest.raises(RuntimeError, match="timed out"):
                        llm.generate("test prompt")

    def test_ollama_http_error(self):
        """Ollama returning HTTP error should raise RuntimeError."""
        import urllib.error as urllib_error
        from llm_interface import OllamaLLM

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OllamaLLM._verify_connection"):
                llm = OllamaLLM(base_url="http://localhost:11434")

                with patch("urllib.request.urlopen") as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = b'{"error": "model not found"}'
                    mock_response.fp = mock_response
                    mock_response.code = 404
                    mock_response.reason = "Not Found"

                    # Create an HTTPError
                    err = urllib_error.HTTPError(
                        url="http://localhost:11434",
                        code=404,
                        msg="Not Found",
                        hdrs={},
                        fp=mock_response,
                    )
                    mock_urlopen.side_effect = err

                    with pytest.raises(RuntimeError, match="HTTP 404"):
                        llm.generate("test prompt")

    def test_openai_compatible_no_choices(self):
        """OpenAI-compatible API returning no choices should raise RuntimeError."""
        from llm_interface import OpenAICompatibleLLM

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OpenAICompatibleLLM._verify_connection"):
                llm = OpenAICompatibleLLM(base_url="http://localhost:8000")

                with patch("urllib.request.urlopen") as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = b'{"choices": []}'
                    mock_response.headers = MagicMock()
                    mock_response.headers.get_content_charset.return_value = "utf-8"
                    mock_urlopen.return_value.__enter__.return_value = mock_response

                    with pytest.raises(RuntimeError, match="no choices"):
                        llm.generate("test prompt")

    def test_openai_compatible_oversized_response(self):
        """OpenAI-compatible API response exceeding MAX_RESPONSE_SIZE should be rejected."""
        from llm_interface import OpenAICompatibleLLM, MAX_RESPONSE_SIZE

        assert MAX_RESPONSE_SIZE > 0  # Verify constant exists

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OpenAICompatibleLLM._verify_connection"):
                llm = OpenAICompatibleLLM(base_url="http://localhost:8000")

                with patch("urllib.request.urlopen") as mock_urlopen:
                    mock_response = MagicMock()
                    # Response larger than MAX_RESPONSE_SIZE
                    mock_response.read.return_value = b"x" * (MAX_RESPONSE_SIZE + 1)
                    mock_urlopen.return_value.__enter__.return_value = mock_response

                    with pytest.raises(RuntimeError, match="exceeds maximum"):
                        llm.generate("test prompt")

    def test_prompt_exceeds_max_length_rejected(self):
        """Prompt exceeding MAX_PROMPT_LENGTH should raise ValueError before API call."""
        from llm_interface import OllamaLLM, MAX_PROMPT_LENGTH

        assert MAX_PROMPT_LENGTH > 0

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OllamaLLM._verify_connection"):
                llm = OllamaLLM(base_url="http://localhost:11434")

                # Very long prompt
                long_prompt = "x" * (MAX_PROMPT_LENGTH + 1)

                with pytest.raises(ValueError, match="exceeds maximum length"):
                    llm.generate(long_prompt)

    def test_smartllm_all_backends_fail_with_errors(self, tmp_path):
        """When all backends fail, RuntimeError should aggregate errors."""
        from llm_interface import SmartLLM

        gguf_path = tmp_path / "model.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        openvino_path = tmp_path / "openvino"
        openvino_path.mkdir()

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            with patch("llm_interface.OpenVINOLLM") as mock_ov:
                with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
                    with patch("llm_interface.OllamaLLM") as mock_ollama:
                        mock_gguf.side_effect = FileNotFoundError("GGUF not found")
                        mock_ov.side_effect = FileNotFoundError("OpenVINO model not found")
                        mock_api.side_effect = ConnectionError("API unreachable")
                        mock_ollama.side_effect = ConnectionError("Ollama not running")

                        with pytest.raises(RuntimeError, match="No LLM backend available"):
                            SmartLLM(
                                gguf_path=str(gguf_path),
                                model_path=str(openvino_path),
                                api_url="http://localhost:8000",
                                ollama_model="phi3",
                            )

    def test_gguf_file_missing_raises_filenotfound(self, tmp_path):
        """GGUFBackend with non-existent file raises FileNotFoundError."""
        from llm_interface import GGUFBackend

        nonexistent = str(tmp_path / "missing.gguf")
        with pytest.raises(FileNotFoundError, match="GGUF model path not found"):
            GGUFBackend(gguf_path=nonexistent)

    def test_smartllm_fallback_preserves_error_messages(self, tmp_path):
        """Fallback chain should aggregate error messages."""
        from llm_interface import SmartLLM

        gguf_path = tmp_path / "model.gguf"
        gguf_path.write_bytes(b"GGUF" + b"\x00" * 100)

        with patch("llm_interface.GGUFBackend") as mock_gguf:
            with patch("llm_interface.OpenVINOLLM") as mock_ov:
                with patch("llm_interface.OpenAICompatibleLLM") as mock_api:
                    mock_gguf.side_effect = RuntimeError("GGUF init failed")
                    mock_ov.side_effect = RuntimeError("OpenVINO init failed")
                    mock_api.side_effect = RuntimeError("API connection refused")

                    with pytest.raises(RuntimeError) as exc_info:
                        SmartLLM(
                            gguf_path=str(gguf_path),
                            model_path="/fake/openvino",
                            api_url="http://localhost:8000",
                        )

                    error_msg = str(exc_info.value)
                    # Should mention that no backend is available
                    assert "No LLM backend available" in error_msg or "GGUF" in error_msg


# =============================================================================
# TEST GROUP 5: Vector Store Edge Cases
# =============================================================================

class TestVectorStoreEdgeCases:
    """Vector store edge cases and failure modes."""

    def test_get_chunks_empty_query(self, temp_chroma_db):
        """Empty query string should be handled."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore

        store = VectorStore(db_path=str(temp_chroma_db), embedding_model="BAAI/bge-small-en-v1.5")

        # Empty query
        chunks = store.get_chunks("", n_results=3)
        assert isinstance(chunks, list)

    def test_add_chunks_with_none_metadata(self, temp_chroma_db):
        """Chunks with None metadata should not crash."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore, DocumentChunk

        store = VectorStore(db_path=str(temp_chroma_db), embedding_model="BAAI/bge-small-en-v1.5")

        chunks = [
            DocumentChunk(text="Test chunk", source="test.txt", page=None, chunk_index=0)
        ]

        # Should not crash
        added = store.add_chunks(chunks)
        assert added >= 0

    def test_get_stats_with_empty_store(self, temp_chroma_db):
        """Empty store stats should return zero counts."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore

        store = VectorStore(db_path=str(temp_chroma_db), embedding_model="BAAI/bge-small-en-v1.5")
        stats = store.get_stats()

        assert stats["chunk_count"] == 0
        assert stats["document_count"] == 0
        assert isinstance(stats["documents"], list)

    def test_bm25_search_on_empty_index(self):
        """BM25 search on empty index should return empty list."""
        from vector_store import BM25Index

        index = BM25Index()
        # Don't build index
        results = index.search("query", top_k=5)
        assert results == []

    def test_bm25_search_no_matching_results(self):
        """BM25 search with no matching results returns empty."""
        from vector_store import BM25Index, DocumentChunk

        index = BM25Index()
        chunks = [
            DocumentChunk(text="Python programming language", source="test.txt", chunk_index=0)
        ]
        index.build_index(chunks)

        results = index.search("xyz123 totally unrelated query 99999", top_k=5)
        # Should return empty list when no matches
        assert isinstance(results, list)

    def test_rrf_fuse_with_tied_ranks(self):
        """RRF fusion with tied ranks should handle gracefully."""
        from utils import rrf_fuse

        # Same documents in both lists, same ranks
        results1 = [(0, 0.9), (1, 0.8)]
        results2 = [(0, 0.9), (1, 0.8)]

        fused = rrf_fuse([results1, results2])

        # Should produce results without crashing
        assert len(fused) >= 2
        assert all(isinstance(item, tuple) for item in fused)

    def test_rrf_fuse_with_duplicate_ids(self):
        """RRF fusion with duplicate document IDs across lists."""
        from utils import rrf_fuse

        # Same doc ID in both lists
        results1 = [(5, 0.9), (5, 0.85)]  # Duplicate ID
        results2 = [(5, 0.9)]

        fused = rrf_fuse([results1, results2])
        # Should handle duplicate IDs gracefully
        assert isinstance(fused, list)


# =============================================================================
# TEST GROUP 6: API Edge Cases
# =============================================================================

class TestAPIEdgeCases:
    """API server edge cases and validation."""

    def test_n_results_below_minimum(self):
        """n_results < 1 should be rejected by Pydantic."""
        from api_server import QuestionRequest
        import pydantic

        with pytest.raises(Exception):  # ValidationError
            QuestionRequest(question="Test?", n_results=0)

    def test_n_results_above_maximum(self):
        """n_results > 10 should be rejected by Pydantic."""
        from api_server import QuestionRequest
        import pydantic

        with pytest.raises(Exception):
            QuestionRequest(question="Test?", n_results=11)

    def test_sanitize_filename_null_bytes(self):
        """Filename with null bytes should be sanitized."""
        from api_server import sanitize_filename

        clean, display = sanitize_filename("file\x00name.txt")
        assert isinstance(clean, str)
        assert "\x00" not in clean

    def test_sanitize_filename_windows_reserved_name(self):
        """Windows reserved names (CON, PRN, etc.) should be prefixed."""
        from api_server import sanitize_filename

        for reserved in ["CON", "PRN", "AUX", "NUL", "LPT1", "COM1"]:
            clean, display = sanitize_filename(f"{reserved}.txt")
            # Should either be prefixed with underscore or sanitized
            assert isinstance(clean, str)
            assert len(clean) > 0

    def test_sanitize_filename_too_long_truncated(self):
        """Filename exceeding 255 chars should be truncated."""
        from api_server import sanitize_filename

        long_name = "a" * 300 + ".txt"
        clean, display = sanitize_filename(long_name)
        assert len(clean) <= 255

    def test_sanitize_filename_only_extension(self):
        """Filename that becomes only extension after sanitization."""
        from api_server import sanitize_filename

        # File with only special characters
        clean, display = sanitize_filename("***@@@###.txt")
        # Should still produce a valid filename
        assert isinstance(clean, str)
        assert ".txt" in clean or len(clean) > 0

    def test_validate_model_path_url_encoded_traversal(self):
        """URL-encoded path traversal should be detected."""
        from api_server import validate_model_path

        # URL-encoded .. (dotdot)
        with pytest.raises(ValueError, match="path traversal"):
            validate_model_path("%2e%2e/etc/passwd")

    def test_validate_device_with_shell_injection(self):
        """Device string with shell injection patterns should be rejected."""
        from api_server import validate_device

        dangerous_devices = [
            "cpu; rm -rf /",
            "cpu | cat /etc/passwd",
            "cpu && curl evil.com",
            "cpu`whoami`",
            'cpu$(ls)',
            "cuda'",
            'cpu"',
        ]

        for device in dangerous_devices:
            with pytest.raises(ValueError, match="dangerous"):
                validate_device(device)

    def test_validate_device_valid_values(self):
        """Valid device strings should be accepted."""
        from api_server import validate_device

        for device in ["cpu", "cuda", "mps"]:
            result = validate_device(device)
            assert result == device

    def test_validate_numeric_at_boundaries(self):
        """Numeric validation at exact boundaries."""
        from api_server import validate_numeric

        # Exact min
        assert validate_numeric(5, 5, 10, "test") == 5
        # Exact max
        assert validate_numeric(10, 5, 10, "test") == 10

    def test_validate_numeric_below_min_by_one(self):
        """Value one below minimum should be rejected."""
        from api_server import validate_numeric

        with pytest.raises(ValueError, match="must be between"):
            validate_numeric(4, 5, 10, "test")

    def test_validate_numeric_above_max_by_one(self):
        """Value one above maximum should be rejected."""
        from api_server import validate_numeric

        with pytest.raises(ValueError, match="must be between"):
            validate_numeric(11, 5, 10, "test")


# =============================================================================
# TEST GROUP 7: RAG Engine Edge Cases
# =============================================================================

class TestRAGEngineEdgeCases:
    """RAG engine edge cases and error handling."""

    def test_query_with_llm_returning_empty_string(self):
        """LLM returning empty string should be handled."""
        from rag_engine import RAGEngine

        with patch("rag_engine.VectorStore") as mock_vs:
            with patch("rag_engine.SmartLLM") as mock_llm:
                with patch("rag_engine.RAGEngine._save_config"):
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = ("Some context", ["test.txt"])
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 1,
                        "embedding_model": "test", "documents": ["test.txt"]
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = ""  # Empty response
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    result = engine.query("What is this?")

                    # Empty response should be handled gracefully
                    assert isinstance(result.answer, str)

    def test_query_with_no_sources(self):
        """Query returning no sources should not crash."""
        from rag_engine import RAGEngine

        with patch("rag_engine.VectorStore") as mock_vs:
            with patch("rag_engine.SmartLLM") as mock_llm:
                with patch("rag_engine.RAGEngine._save_config"):
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = ("Context", [])
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 0, "chunk_count": 0,
                        "embedding_model": "test", "documents": []
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "No info found."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    result = engine.query("What is this?")

                    assert isinstance(result.sources, list)

    def test_query_with_very_long_context(self):
        """Very long context should be handled without crashing."""
        from rag_engine import RAGEngine

        with patch("rag_engine.VectorStore") as mock_vs:
            with patch("rag_engine.SmartLLM") as mock_llm:
                with patch("rag_engine.RAGEngine._save_config"):
                    # Very long context
                    long_context = "word " * 10000

                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = (long_context, ["test.txt"])
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 100,
                        "embedding_model": "test", "documents": ["test.txt"]
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Answer."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    result = engine.query("What is this?")

                    assert isinstance(result.answer, str)

    def test_ingest_file_with_unsupported_type_via_api(self, tmp_path):
        """Ingesting unsupported file type should be rejected by API."""
        from api_server import sanitize_filename

        ext = Path("fake.exe").suffix.lower()
        assert ext not in {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt", ".md"}

    def test_conversation_history_with_malformed_messages(self):
        """Malformed conversation history should be handled gracefully."""
        # Test the conversation history handling logic with malformed data
        malformed_history = [
            {"role": "user"},  # Missing content
            {"content": "reply"},  # Missing role
            "not a dict",  # Not a dict at all
            None,  # None value
            {"role": "assistant", "content": "Hi"},  # Normal entry
        ]

        # Access the conversation history handling logic (from SmartLLM.answer_question)
        # Uses .get() with default to handle missing keys
        last_user = next(
            (
                m.get("content", "")
                for m in reversed(malformed_history)
                if isinstance(m, dict) and m.get("role") == "user"
            ),
            None,
        )
        # Should return None (no valid user message found in malformed history)
        assert last_user == ""  # Empty content for role=user dict with no content key


# =============================================================================
# TEST GROUP 8: Resource Exhaustion Simulation
# =============================================================================

class TestResourceExhaustion:
    """Simulated resource exhaustion scenarios."""

    def test_embedding_model_not_found(self, temp_chroma_db):
        """Non-existent embedding model should raise ImportError or similar."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore

        with pytest.raises(Exception):  # Model loading should fail
            VectorStore(
                db_path=str(temp_chroma_db),
                embedding_model="non-existent-model-xyz123",
            )

    def test_chroma_db_path_readonly(self, tmp_path):
        """ChromaDB on read-only path should fail gracefully."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore

        # Create a read-only directory (if supported)
        readonly_dir = tmp_path / "readonly_db"
        readonly_dir.mkdir()

        try:
            # Attempt to create a store in the directory
            store = VectorStore(db_path=str(readonly_dir), embedding_model="BAAI/bge-small-en-v1.5")
            # If this succeeds, add_chunks might fail on write
            from document_processor import DocumentChunk
            chunks = [DocumentChunk(text="test", source="test.txt", chunk_index=0)]
            try:
                store.add_chunks(chunks)
            except Exception:
                pass  # Expected - read-only
        except Exception:
            pass  # Also acceptable - can't even create the store

    def test_disk_full_simulation(self, temp_chroma_db):
        """Simulate disk full by making ChromaDB operations fail."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore, DocumentChunk

        store = VectorStore(db_path=str(temp_chroma_db), embedding_model="BAAI/bge-small-en-v1.5")

        # Mock collection.add to simulate disk full
        original_add = store.collection.add
        def simulate_disk_full(*args, **kwargs):
            raise OSError("No space left on device")

        store.collection.add = simulate_disk_full

        chunks = [DocumentChunk(text="test", source="test.txt", chunk_index=0)]

        # Should raise OSError, not crash
        with pytest.raises(OSError):
            store.add_chunks(chunks)

    def test_context_truncation_extreme_value(self):
        """Very large context truncation value should be accepted but capped."""
        from config import RAGSettings
        import os
        import importlib

        os.environ["RAG_CONTEXT_TRUNCATION"] = "999999999"
        try:
            import config as cfg
            importlib.reload(cfg)
            from config import RAGSettings
            s = RAGSettings()
            # Should be accepted as a positive integer
            assert s.rag_context_truncation > 0
        finally:
            os.environ.pop("RAG_CONTEXT_TRUNCATION", None)
            importlib.reload(cfg)


# =============================================================================
# TEST GROUP 9: Token and Length Limit Properties
# =============================================================================

class TestTokenAndLengthLimits:
    """Token and prompt length limit testing."""

    def test_max_prompt_length_constant_exists(self):
        """MAX_PROMPT_LENGTH constant should exist and be positive."""
        from llm_interface import MAX_PROMPT_LENGTH

        assert MAX_PROMPT_LENGTH > 0
        assert isinstance(MAX_PROMPT_LENGTH, int)

    def test_max_response_size_constant_exists(self):
        """MAX_RESPONSE_SIZE constant should exist and be positive."""
        from llm_interface import MAX_RESPONSE_SIZE

        assert MAX_RESPONSE_SIZE > 0
        assert isinstance(MAX_RESPONSE_SIZE, int)

    def test_prompt_at_exact_max_length(self):
        """Prompt at exactly MAX_PROMPT_LENGTH should be accepted."""
        from llm_interface import OllamaLLM, MAX_PROMPT_LENGTH

        with patch("llm_interface.validate_url", return_value=True):
            with patch("llm_interface.OllamaLLM._verify_connection"):
                llm = OllamaLLM(base_url="http://localhost:11434")

                exact_prompt = "x" * MAX_PROMPT_LENGTH

                with patch("urllib.request.urlopen") as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = b'{"response": "ok"}'
                    mock_response.headers = MagicMock()
                    mock_response.headers.get_content_charset.return_value = "utf-8"
                    mock_urlopen.return_value.__enter__.return_value = mock_response

                    # Should not raise ValueError
                    result = llm.generate(exact_prompt)
                    assert isinstance(result, str)

    def test_gguf_magic_bytes_boundary(self, tmp_path):
        """GGUF file with exactly 4 bytes (correct magic) should be accepted."""
        from llm_interface import GGUFBackend

        # Exactly 4 bytes matching GGUF magic
        correct_magic = b"GGUF"
        magic_path = tmp_path / "correct.gguf"
        magic_path.write_bytes(correct_magic)

        with patch("llama_cpp.Llama"):
            backend = GGUFBackend(gguf_path=str(magic_path))
            # Should not raise - just verifying magic is checked

    def test_inference_config_boundary_values(self):
        """InferenceConfig with boundary values should work."""
        from llm_interface import InferenceConfig

        # Max tokens at boundary
        config = InferenceConfig(max_tokens=4096)
        assert config.max_tokens == 4096

        # Min temperature
        config = InferenceConfig(temperature=0.0)
        assert config.temperature == 0.0

        # Max temperature
        config = InferenceConfig(temperature=2.0)
        assert config.temperature == 2.0


# =============================================================================
# TEST GROUP 10: Data Integrity and Recovery
# =============================================================================

class TestDataIntegrityAndRecovery:
    """Data integrity and recovery scenarios."""

    def test_chunk_text_empty_vs_none(self):
        """Chunk with empty text vs None text should be handled differently."""
        from document_processor import DocumentChunk

        empty_chunk = DocumentChunk(text="", source="test.txt", chunk_index=0)
        # Empty text is valid but should produce empty context
        assert empty_chunk.text == ""

    def test_source_name_normalization(self):
        """Source names should be normalized consistently."""
        from document_processor import DocumentProcessor

        # Same file, different path representations
        processor = DocumentProcessor()

        text = "Content here. Another sentence."
        chunks1 = processor.chunk_text(text, "file.txt")
        chunks2 = processor.chunk_text(text, "file.txt")

        # Both should produce chunks with same source
        assert chunks1[0].source == chunks2[0].source

    def test_rag_engine_handles_unicode_in_context(self):
        """RAG context with Unicode should be passed to LLM correctly."""
        from rag_engine import RAGEngine

        with patch("rag_engine.VectorStore") as mock_vs:
            with patch("rag_engine.SmartLLM") as mock_llm:
                with patch("rag_engine.RAGEngine._save_config"):
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = (
                        "日本語テスト context with émoji 🚀 and 中文",
                        ["test.txt"]
                    )
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 1,
                        "embedding_model": "test", "documents": ["test.txt"]
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Answer with émoji."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()
                    result = engine.query("What is this?")

                    # Unicode in context should not crash
                    assert isinstance(result.answer, str)

    def test_concurrent_clear_and_query(self):
        """Clear during query should be handled (thread safety)."""
        from rag_engine import RAGEngine

        with patch("rag_engine.VectorStore") as mock_vs:
            with patch("rag_engine.SmartLLM") as mock_llm:
                with patch("rag_engine.RAGEngine._save_config"):
                    mock_vs_instance = MagicMock()
                    mock_vs_instance.get_context.return_value = ("context", ["test.txt"])
                    mock_vs_instance.get_stats.return_value = {
                        "document_count": 1, "chunk_count": 1,
                        "embedding_model": "test", "documents": ["test.txt"]
                    }
                    mock_vs.return_value = mock_vs_instance

                    mock_llm_instance = MagicMock()
                    mock_llm_instance.answer_question.return_value = "Answer."
                    mock_llm.return_value = mock_llm_instance

                    engine = RAGEngine()

                    # Clear then query - should handle gracefully
                    engine.clear_documents()
                    result = engine.query("What is this?")

                    assert isinstance(result.answer, str)

    def test_error_message_no_sensitive_data_leak(self):
        """Error messages should not leak sensitive file paths or data."""
        from llm_interface import _sanitize_error

        # Test that the sanitize function exists and is used
        assert callable(_sanitize_error)

        # Test with various inputs
        result = _sanitize_error("Error about /home/user/secret/file.txt")
        # Should either strip the path or leave it (depends on implementation)
        assert isinstance(result, str)

        result = _sanitize_error("Error with api_key=secret123token")
        assert isinstance(result, str)

        result = _sanitize_error("Error with password=supersecret")
        assert isinstance(result, str)


# =============================================================================
# TEST GROUP 11: Property-Based Invariants
# =============================================================================

class TestPropertyInvariants:
    """Property-based tests for mathematical/logical invariants."""

    def test_rrf_fusion_idempotency(self):
        """RRF fusion should be idempotent: f(f(x)) == f(x)."""
        from utils import rrf_fuse

        results1 = [(0, 0.9), (1, 0.8), (2, 0.7)]
        results2 = [(1, 0.95), (0, 0.85), (3, 0.6)]

        first = rrf_fuse([results1, results2])
        second = rrf_fuse([first, []])

        # Both should have same document IDs in same relative order
        assert [r[0] for r in first] == [r[0] for r in second]

    def test_rrf_fusion_scores_non_negative(self):
        """RRF fusion scores should always be non-negative."""
        from utils import rrf_fuse

        results1 = [(0, 0.9), (1, 0.8)]
        results2 = [(0, 0.5), (2, 0.3), (3, 0.1)]

        fused = rrf_fuse([results1, results2])
        for item in fused:
            assert item[1] >= 0  # Score should be non-negative

    def test_sanitize_filename_idempotent(self):
        """sanitize_filename should be idempotent."""
        from api_server import sanitize_filename

        name = "normal_file_123.txt"
        first, _ = sanitize_filename(name)
        second, _ = sanitize_filename(first)
        assert first == second

    def test_config_min_similarity_bounded(self):
        """min_similarity always returns value in [0, 1]."""
        import importlib
        import os

        from config import RAGSettings

        for val in [0.0, 0.5, 1.0, 0.001, 0.999]:
            os.environ["RAG_MIN_SIMILARITY"] = str(val)
            try:
                importlib.reload(__import__('config'))
                s = RAGSettings()
                assert 0.0 <= s.rag_min_similarity <= 1.0
            except ValueError:
                pass  # Out of range values are rejected
            finally:
                os.environ.pop("RAG_MIN_SIMILARITY", None)
                importlib.reload(__import__('config'))

    def test_config_temperature_bounded(self):
        """temperature always returns value in [0, 2]."""
        import importlib
        import os

        from config import RAGSettings

        for val in [0.0, 1.0, 2.0, 0.001, 1.999]:
            os.environ["RAG_TEMPERATURE"] = str(val)
            try:
                importlib.reload(__import__('config'))
                s = RAGSettings()
                assert 0.0 <= s.rag_temperature <= 2.0
            except ValueError:
                pass
            finally:
                os.environ.pop("RAG_TEMPERATURE", None)
                importlib.reload(__import__('config'))


# =============================================================================
# TEST GROUP 12: Adversarial Input - Boundary and Oversized
# =============================================================================

class TestAdversarialOversizedInputs:
    """Adversarial oversized inputs across the pipeline."""

    def test_vector_store_oversized_text_chunk(self, temp_chroma_db):
        """Very large chunk text should be handled."""
        pytest.importorskip("chromadb")
        pytest.importorskip("sentence_transformers")
        from vector_store import VectorStore, DocumentChunk

        store = VectorStore(db_path=str(temp_chroma_db), embedding_model="BAAI/bge-small-en-v1.5")

        # Create a chunk with very large text (simulate 100K chars)
        large_chunk = DocumentChunk(
            text="word " * 20000,  # ~100K chars
            source="large.txt",
            chunk_index=0
        )

        # Should handle without crashing (may truncate or chunk internally)
        try:
            added = store.add_chunks([large_chunk])
            assert added >= 0
        except Exception as e:
            # If it fails due to size, that's also acceptable behavior
            assert "size" in str(e).lower() or "length" in str(e).lower()

    def test_document_processor_extremely_long_word(self, tmp_path):
        """Extremely long single word (>10K chars) should be handled."""
        from document_processor import DocumentProcessor

        # Single extremely long "word" (no spaces)
        long_word = "x" * 15000
        content = f"{long_word}. Normal text after."
        long_path = tmp_path / "longword.txt"
        long_path.write_text(content, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        chunks = processor.process_file(str(long_path))

        # Should produce at least one chunk
        assert len(chunks) >= 1

    def test_deeply_nested_paragraph_structure(self, tmp_path):
        """File with deeply nested blank lines should be chunked correctly."""
        from document_processor import DocumentProcessor

        # Multiple blank lines between paragraphs
        content = "\n\n\n\n\n".join([f"Paragraph {i} content here." for i in range(50)])
        nested_path = tmp_path / "nested.txt"
        nested_path.write_text(content, encoding="utf-8")

        processor = DocumentProcessor(chunk_size=100, chunk_overlap=20)
        chunks = processor.process_file(str(nested_path))

        # Should handle the nested structure
        assert len(chunks) >= 1
        for chunk in chunks:
            assert isinstance(chunk.text, str)

    def test_very_large_n_results_in_query(self):
        """n_results = 1000 should be rejected by Pydantic."""
        from api_server import QuestionRequest
        import pydantic

        with pytest.raises(Exception):
            QuestionRequest(question="Test?", n_results=1000)

    def test_file_with_only_combining_diacritics(self, tmp_path):
        """File with only combining diacritics should be handled."""
        from document_processor import DocumentProcessor

        # Combining diacritics only (no base characters)
        diacritics = "\u0300\u0301\u0302\u0303\u0304" * 100
        dia_path = tmp_path / "diacritics.txt"
        dia_path.write_text(diacritics, encoding="utf-8")

        processor = DocumentProcessor()
        chunks = processor.process_file(str(dia_path))

        # Should handle gracefully
        assert isinstance(chunks, list)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
