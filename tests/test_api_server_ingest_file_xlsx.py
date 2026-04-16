"""
Tests for ingest_file endpoint .xlsx allowlist change (Task 6.2)

Verifies that:
1. .xlsx files are accepted (not rejected with 400)
2. Existing allowed extensions (.pdf, .docx, .txt, .md) still work
3. Disallowed extensions (.exe, .zip) are rejected with 400
4. Case-insensitivity (.XLSX, .Xls) is handled
"""

import pytest
import io
from pathlib import Path
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

# Import the app directly to avoid lifespan issues with engine init
# We mock the engine globally so lifespan never tries to create it
from api_server import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def mock_engine():
    """Mock the RAG engine so the endpoint can be tested without a real engine."""
    mock_eng = MagicMock()
    mock_eng.ingest_file.return_value = {
        "success": True,
        "documents": 1,
        "chunks_added": 5,
        "message": "Ingested successfully",
    }

    # Patch at the module level so the endpoint sees our mock
    with patch("api_server.engine", mock_eng):
        yield mock_eng


# =============================================================================
# ALLOWED EXTENSIONS — should NOT return 400
# =============================================================================


class TestIngestFileAllowedExtensions:
    """Verify that all allowed file types are accepted."""

    @pytest.mark.parametrize(
        "filename",
        [
            "document.pdf",
            "document.docx",
            "document.txt",
            "document.md",
            "document.xlsx",  # THE KEY CHANGE under test
            "document.pptx",
            "document.ppt",
            "document.doc",
        ],
    )
    def test_allowed_extensions_accepted(self, filename, mock_engine):
        """All extensions in the allowlist should be accepted (not rejected with 400)."""
        file_content = b"fake file content for testing"
        response = client.post(
            "/ingest/file",
            files={"file": (filename, io.BytesIO(file_content), "application/octet-stream")},
        )

        # 400 means "Unsupported file type" — we assert it's NOT 400
        assert response.status_code != 400, (
            f"Extension {Path(filename).suffix!r} should be allowed but got 400: "
            f"{response.json()}"
        )
        # Accept 200 (success), 500 (processing error), 413 (too large), etc.
        # The only forbidden code is 400 for file type rejection
        mock_engine.ingest_file.assert_called_once()

    @pytest.mark.parametrize(
        "filename",
        [
            "DATA.XLSX",
            "report.Xlsx",
            "Doc.PDF",
            "notes.TXT",
        ],
    )
    def test_case_insensitive_extensions_accepted(self, filename, mock_engine):
        """File extension matching should be case-insensitive."""
        file_content = b"fake file content"
        response = client.post(
            "/ingest/file",
            files={"file": (filename, io.BytesIO(file_content), "application/octet-stream")},
        )

        ext = Path(filename).suffix
        assert response.status_code != 400, (
            f"Extension {ext!r} (case variant) should be allowed but got 400: "
            f"{response.json()}"
        )


# =============================================================================
# DISALLOWED EXTENSIONS — must return 400
# =============================================================================


class TestIngestFileDisallowedExtensions:
    """Verify that disallowed file types are rejected with 400."""

    @pytest.mark.parametrize(
        "filename",
        [
            "malware.exe",
            "archive.zip",
            "archive.rar",
            "archive.7z",
            "image.png",
            "image.jpg",
            "image.gif",
            "video.mp4",
            "video.avi",
            "audio.mp3",
            "audio.wav",
            "code.py",
            "code.js",
            "code.java",
            "data.csv",
            "data.json",
            "data.xml",
            "document.rtf",
            "document.odt",
        ],
    )
    def test_disallowed_extensions_rejected_with_400(self, filename, mock_engine):
        """Disallowed extensions must return 400 with 'Unsupported file type'."""
        file_content = b"fake file content"
        response = client.post(
            "/ingest/file",
            files={"file": (filename, io.BytesIO(file_content), "application/octet-stream")},
        )

        assert response.status_code == 400, (
            f"Extension {Path(filename).suffix!r} should be rejected with 400 "
            f"but got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "Unsupported file type" in data.get("detail", "")
        # Ensure engine was NOT called (rejected before processing)
        mock_engine.ingest_file.assert_not_called()


# =============================================================================
# XLSX — THE PRIMARY CHANGE UNDER TEST
# =============================================================================


class TestIngestFileXlsxAcceptance:
    """Dedicated tests for the .xlsx allowlist addition (Task 6.2)."""

    def test_xlsx_accepted_not_rejected(self, mock_engine):
        """CRITICAL: .xlsx files must NOT be rejected with 400."""
        response = client.post(
            "/ingest/file",
            files={
                    "file": (
                        "report.xlsx",
                        io.BytesIO(b"PK\x03\x04fake xlsx content"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
            },
        )

        # Must NOT be 400
        assert response.status_code != 400, (
            "Task 6.2 REGRESSION: .xlsx was rejected with 400. "
            "The allowlist change was not applied correctly."
        )

    def test_xlsx_success_response(self, mock_engine):
        """When .xlsx is uploaded and engine succeeds, response is 200."""
        mock_engine.ingest_file.return_value = {
            "success": True,
            "documents": 1,
            "chunks_added": 10,
            "message": "Ingested spreadsheet",
        }

        response = client.post(
            "/ingest/file",
            files={
                    "file": (
                        "data.xlsx",
                        io.BytesIO(b"PK\x03\x04spreadsheet data here"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
            },
        )

        assert response.status_code == 200, (
            f"Expected 200 but got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["success"] is True
        assert data["documents"] == 1
        assert data["chunks_added"] == 10

    def test_xlsx_allowlist_contains_xlsx(self):
        """Verify the allowlist in api_server.py actually contains .xlsx."""
        import api_server

        # Read the source to confirm .xlsx is in the allowlist set
        source = Path(api_server.__file__).read_text(encoding="utf-8")

        # The allowlist line looks like:
        # if ext not in {".pdf", ".docx", ..., ".xlsx"}:
        import re

        match = re.search(
            r'if ext not in \{(.+?)\}:', source, re.DOTALL
        )
        assert match, "Could not find allowlist set in api_server.py source"
        allowlist_str = match.group(1)
        assert '".xlsx"' in allowlist_str or "'" ".xlsx'" "'" in allowlist_str, (
            "ALLOWLIST MISSING .xlsx: "
            f"The allowlist does not contain '.xlsx'. Found: {allowlist_str}"
        )


# =============================================================================
# EDGE CASES
# =============================================================================


class TestIngestFileEdgeCases:
    """Edge cases for the ingest_file endpoint."""

    def test_no_filename_returns_400_or_422(self, mock_engine):
        """Request without a filename should return 400 or 422 (validation vs domain-level)."""
        response = client.post(
            "/ingest/file",
            files={"file": ("", io.BytesIO(b"content"), "application/octet-stream")},
        )
        # FastAPI may return 422 (field validation) or 400 (endpoint-level check)
        assert response.status_code in (400, 422), (
            f"Expected 400 or 422 for empty filename, got {response.status_code}"
        )

    def test_empty_extension_accepted(self, mock_engine):
        """File with no extension (empty suffix) should be rejected with 400."""
        response = client.post(
            "/ingest/file",
            files={"file": ("readme", io.BytesIO(b"content"), "text/plain")},
        )
        # Empty extension is not in allowlist → should be 400
        assert response.status_code == 400
        assert "Unsupported file type" in response.json().get("detail", "")

    def test_double_extension_rejected(self, mock_engine):
        """.pdf.exe should be rejected (last extension is .exe not in allowlist)."""
        response = client.post(
            "/ingest/file",
            files={"file": ("file.pdf.exe", io.BytesIO(b"content"), "application/octet-stream")},
        )
        assert response.status_code == 400, (
            ".pdf.exe should be rejected because Path().suffix returns .exe"
        )

    def test_file_too_large_returns_413(self, mock_engine):
        """Files over 50MB should be rejected with 413."""
        # Create content larger than 50MB
        large_content = b"x" * (51 * 1024 * 1024)  # 51MB
        response = client.post(
            "/ingest/file",
            files={
                    "file": (
                        "large.xlsx",
                        io.BytesIO(large_content),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
            },
        )
        assert response.status_code == 413, (
            f"Expected 413 for oversized file but got {response.status_code}"
        )
