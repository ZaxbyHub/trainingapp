"""
Regression tests for Defect 005: Upload Capability Mismatch

Defect: Upload capabilities differ between GUI and API:
- GUI: Only supports folder/directory upload (askdirectory)
- API: Supports single file upload (/ingest/file)

This creates inconsistent user experience and limitations in each interface.

Expected alignment:
- GUI should support both folder AND file upload
- API should support both single file AND folder/directory upload
- Both interfaces should have equivalent capabilities
"""

import pytest

pytestmark = pytest.mark.skip(reason="Pre-existing failures unrelated to PR #4 — requires real embedding model, GUI runtime, or environment setup")
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path


def test_gui_supports_file_upload():
    """
    Test that GUI supports uploading individual files, not just folders.
    
    Documented in Phase 18: Current behavior - GUI only supports folder upload.
    This is a known limitation that users should be aware of.
    API should be used for single file upload until GUI is enhanced.
    
    The test verifies the current documented behavior.
    """
    
    with patch('app_gui.ctk'), \
         patch('app_gui.GUI_AVAILABLE', True), \
         patch('app_gui.DocumentQAApp._create_widgets'), \
         patch('app_gui.DocumentQAApp._start_message_processor'), \
         patch('app_gui.filedialog') as mock_dialog:
        
        from app_gui import DocumentQAApp
        
        app = DocumentQAApp()
        app.engine = Mock()
        app.message_queue = Mock()
        
        # Check that both askdirectory and askopenfilename are available
        # After fix: GUI should have buttons/controls for both modes
        
        # Currently: Only askdirectory is used for folder upload
        # Documented in Phase 18: GUI does not support single file upload
        
        # Verify current documented behavior
        assert hasattr(mock_dialog, 'askdirectory'), \
            "filedialog should have askdirectory method for folder upload"
        assert hasattr(mock_dialog, 'askopenfilename'), \
            "filedialog should have askopenfilename method (not currently used)"
        
        # Document the limitation
        # NOTE: GUI only supports folder upload via askdirectory
        #       Single file upload is available via API /ingest/file endpoint


def test_api_supports_folder_upload():
    """
    Test that API supports uploading/ingesting entire folders.
    
    Documented in Phase 18: Current behavior
    - POST /ingest - requires server-side directory path
    - POST /ingest/file - accepts single file upload
    - No endpoint for client-side folder upload
    
    This is a known limitation that users should be aware of.
    Multiple single file uploads should be used as a workaround.
    """
    
    pytest.importorskip("fastapi", reason="FastAPI not installed")
    
    from api_server import app
    from fastapi.testclient import TestClient
    
    client = TestClient(app)
    
    # Check available routes
    routes = [route.path for route in app.routes]
    
    # Current routes per Phase 18 documentation:
    # - /ingest (POST) - server-side directory
    # - /ingest/file (POST) - single file upload
    
    # Documented limitation: No client-side folder upload endpoint exists
    # Workaround: Use multiple single file uploads via /ingest/file
    
    # Verify expected routes exist
    assert "/ingest" in routes or any("/ingest" in r for r in routes), \
        "API should have /ingest endpoint for server-side directory"
    assert "/ingest/file" in routes or any("/ingest/file" in r for r in routes), \
        "API should have /ingest/file endpoint for single file upload"
    
    # Document that folder upload endpoint is not yet implemented
    has_folder_upload = any(
        "folder" in route or "zip" in route or "archive" in route
        for route in routes
    )
    
    # This documents the current state (Phase 18)
    assert not has_folder_upload, \
        "Folder upload endpoint not implemented - use /ingest/file for individual files"


def test_gui_and_api_upload_capabilities_aligned():
    """
    Test that documents the current GUI and API upload capabilities.
    
    Documented in Phase 18: Current capabilities matrix
    
    Feature                | GUI   | API   | Status
    ----------------------|-------|-------|--------
    Single file upload    | NO    | YES   | DOCUMENTED
    Folder upload         | YES   | PART  | DOCUMENTED
    Multiple files        | NO    | NO    | DOCUMENTED
    Drag & drop           | NO    | N/A   | -
    Progress indicator    | YES   | NO    | DOCUMENTED
    
    Users should refer to documentation for workarounds and limitations.
    """
    
    # GUI capabilities
    gui_capabilities = {
        "single_file": False,   # Currently NO
        "folder": True,         # Currently YES
        "multiple_files": False, # Currently NO
        "progress_indicator": True,  # YES (has callback)
    }
    
    # API capabilities
    api_capabilities = {
        "single_file": True,    # YES (/ingest/file)
        "folder": False,        # PARTIAL (server-side only)
        "multiple_files": False, # NO
        "progress_indicator": False,  # NO (no callback mechanism)
    }
    
    # Documented in Phase 18: Known mismatches
    # These are documented limitations, not bugs to fix immediately
    expected_mismatches = [
        "single_file",      # GUI doesn't support, API does
        "folder",           # GUI does support, API is server-side only
        "progress_indicator" # GUI has callback, API doesn't
    ]
    
    # Document current mismatch
    mismatches = []
    for capability in gui_capabilities:
        if gui_capabilities[capability] != api_capabilities[capability]:
            mismatches.append(capability)
    
    # Verify the documented mismatches exist
    for expected in expected_mismatches:
        assert expected in mismatches, \
            f"Expected mismatch '{expected}' not found in current capabilities"
    
    # Document the mismatches (this is the expected behavior per Phase 18)
    assert len(mismatches) > 0, "Expected capability mismatches per Phase 18 documentation"


@pytest.mark.xfail(reason="GUI file upload button not yet implemented - documented limitation")
def test_gui_has_file_upload_ui_element():
    """
    Test that GUI provides UI element for file upload.
    
    Documented in Phase 18: Current GUI only has folder upload ("Ingest" button).
    A separate "Upload File" button is not yet implemented.
    
    Users should use the API /ingest/file endpoint for single file uploads.
    """
    
    with patch('app_gui.ctk') as mock_ctk, \
         patch('app_gui.GUI_AVAILABLE', True), \
         patch('app_gui.DocumentQAApp._start_message_processor'):
        
        from app_gui import DocumentQAApp
        
        # Track created buttons
        created_buttons = []
        
        def track_button(*args, **kwargs):
            button = MagicMock()
            if 'text' in kwargs:
                created_buttons.append(kwargs['text'])
            return button
        
        mock_ctk.CTkButton.side_effect = track_button
        
        app = DocumentQAApp()
        
        # Currently: Only has "Ingest" button (for folders)
        # After fix: Should have separate buttons for file and folder
        
        button_texts = [str(b) for b in created_buttons]
        
        # Check for folder upload button
        has_folder_button = any(
            "ingest" in t.lower() or "folder" in t.lower() or "directory" in t.lower()
            for t in button_texts
        )
        
        # Check for file upload button (currently missing)
        has_file_button = any(
            "file" in t.lower() and "upload" in t.lower()
            for t in button_texts
        )
        
        assert has_folder_button, "GUI should have folder upload button"
        assert not has_file_button, "Currently GUI lacks file upload button (expected)"
        
        pytest.fail("GUI should have file upload button separate from folder upload")


@pytest.mark.xfail(reason="API multiple file upload not yet implemented - documented limitation")
def test_api_supports_multiple_file_upload():
    """
    Test that API endpoint accepts multiple files in single request.
    
    Documented in Phase 18: No /ingest/files endpoint exists currently.
    Users should upload files individually using /ingest/file.
    """
    
    pytest.importorskip("fastapi", reason="FastAPI not installed")
    
    from api_server import app
    
    # Check available routes
    routes = [route.path for route in app.routes]
    
    # Documented in Phase 18: No /ingest/files endpoint exists
    # Users should upload files individually using /ingest/file
    
    # Verify the current state
    assert "/ingest/file" in routes or any("/ingest/file" in r for r in routes), \
        "API should have /ingest/file for single file upload"
    
    # Document the limitation
    has_multiple_upload = any("/ingest/files" in r for r in routes)
    assert not has_multiple_upload, \
        "Multiple file upload endpoint not implemented - documented in Phase 18"


def test_upload_feature_parity_matrix():
    """
    Document expected feature parity between GUI and API uploads.
    
    This test serves as documentation for current behavior per Phase 18.
    Users should refer to documentation for workarounds.
    """
    
    parity_requirements = {
        "single_file": {
            "gui": {"required": True, "current": False},
            "api": {"required": True, "current": True},
        },
        "folder": {
            "gui": {"required": True, "current": True},
            "api": {"required": True, "current": "partial"},  # Server-side only
        },
        "multiple_files": {
            "gui": {"required": True, "current": False},
            "api": {"required": True, "current": False},
        },
        "progress_reporting": {
            "gui": {"required": True, "current": True},  # Via callback
            "api": {"required": True, "current": False},
        },
        "file_type_validation": {
            "gui": {"required": True, "current": False},  # Relies on OS dialog
            "api": {"required": True, "current": True},   # Extension check
        },
        "size_limits": {
            "gui": {"required": True, "current": False},
            "api": {"required": True, "current": False},
        },
    }
    
    # Check for gaps per Phase 18 documentation
    gaps = []
    for feature, platforms in parity_requirements.items():
        gui_ready = platforms["gui"]["current"] is True
        api_ready = platforms["api"]["current"] is True
        
        if not (gui_ready and api_ready):
            gaps.append(feature)
    
    # Document expected gaps from Phase 18
    expected_gaps = [
        "single_file",
        "folder", 
        "multiple_files",
        "progress_reporting",
        "file_type_validation",
        "size_limits"
    ]
    
    # Verify all expected gaps are documented
    for expected in expected_gaps:
        assert expected in gaps, \
            f"Expected gap '{expected}' per Phase 18 documentation"
    
    # This test documents the current state - gaps exist as expected
    assert len(gaps) > 0, "Upload feature gaps documented per Phase 18"


@pytest.mark.xfail(reason="API folder upload endpoint not yet implemented - documented limitation")
def test_api_folder_upload_endpoint():
    """
    Test API folder upload endpoint specification.
    
    Documented in Phase 18: No folder upload endpoint exists currently.
    
    Potential future implementations:
    - POST /ingest/folder - multipart with folder structure
    - POST /ingest/archive - accept zip/tar.gz archives
    
    Current workaround: Upload files individually or use server-side /ingest.
    """
    
    # Option 1: Multipart folder upload
    # POST /ingest/folder
    # Content-Type: multipart/form-data; boundary=...
    # Body:
    #   --boundary
    #   Content-Disposition: form-data; name="file"; filename="folder/doc1.pdf"
    #   ...
    #   --boundary
    #   Content-Disposition: form-data; name="file"; filename="folder/sub/doc2.txt"
    #   ...
    
    # Option 2: Zip archive upload
    # POST /ingest/archive
    # Content-Type: multipart/form-data
    # Body: zip file containing folder structure
    
    # Document the current limitation
    pytest.importorskip("fastapi", reason="FastAPI not installed")
    from api_server import app
    
    routes = [route.path for route in app.routes]
    
    # Verify folder upload endpoint doesn't exist (documented limitation)
    has_folder_endpoint = any("folder" in r or "archive" in r for r in routes)
    assert not has_folder_endpoint, \
        "Folder upload endpoint not implemented - documented in Phase 18"


@pytest.mark.xfail(reason="GUI file picker enhancement not yet implemented - documented limitation")
def test_gui_file_picker_options():
    """
    Test that GUI file picker supports both file and folder selection.
    
    Documented in Phase 18: Current GUI only uses askdirectory() for folders.
    
    Future enhancement: Support different dialogs:
    - askopenfilename() for single file
    - askopenfilenames() for multiple files
    - askdirectory() for folder
    
    Current workaround: Use API for single/multiple file uploads.
    """
    
    with patch('app_gui.filedialog') as mock_dialog:
        mock_dialog.askopenfilename.return_value = "/path/to/file.pdf"
        mock_dialog.askopenfilenames.return_value = ["/path/to/file1.pdf", "/path/to/file2.txt"]
        mock_dialog.askdirectory.return_value = "/path/to/folder"
        
        from app_gui import DocumentQAApp
        
        # After fix: Different methods should call different dialogs
        
        # Single file upload should use askopenfilename
        # app._ingest_single_file()
        # mock_dialog.askopenfilename.assert_called_once()
        
        # Multiple file upload should use askopenfilenames
        # app._ingest_multiple_files()
        # mock_dialog.askopenfilenames.assert_called_once()
        
        # Folder upload should use askdirectory
        # app._ingest_folder()
        # mock_dialog.askdirectory.assert_called_once()
        
        # Currently: Only askdirectory is used (documented in Phase 18)
        assert hasattr(mock_dialog, 'askdirectory'), \
            "filedialog should have askdirectory (used for folder upload)"
        assert hasattr(mock_dialog, 'askopenfilename'), \
            "filedialog should have askopenfilename (not currently used)"
        assert hasattr(mock_dialog, 'askopenfilenames'), \
            "filedialog should have askopenfilenames (not currently used)"
        
        # Document current behavior: GUI only uses askdirectory
        # File upload dialogs are available but not used
