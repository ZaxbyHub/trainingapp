"""
Tests for UI/UX modernization features (Windows 11 Fluent Design).

Verifies:
- Navigation rail with 4 pages (Chat, Documents, Settings, Help)
- Multiline message composer (Ctrl+Enter=submit, Enter=newline)
- Documents page with delete functionality
- Settings page with collapsible Advanced section
- Help page with keyboard shortcuts
- Copy button on assistant messages
- Retrieved chunks expandable preview
"""

import pytest
import inspect


class TestNavigationRail:
    """Navigation rail must have 4 icon buttons for page switching."""

    def test_navigation_rail_exists(self):
        """Nav rail must be created in _create_widgets."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert 'nav_rail' in source, "Navigation rail variable not found"

    def test_four_nav_buttons_exist(self):
        """Must have buttons for Chat, Documents, Settings, Help."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        # Check for icon buttons with text labels
        assert '💬' in source or 'Chat' in source, "Chat button not found"
        assert '📄' in source or 'Documents' in source, "Documents button not found"
        assert '⚙' in source or 'Settings' in source, "Settings button not found"
        assert '?' in source or 'Help' in source, "Help button not found"


class TestDocumentsPage:
    """Documents page must display loaded documents and allow deletion."""

    def test_documents_page_exists(self):
        """Documents page must be created."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert '_create_documents_page' in source, "Documents page creation method not called"
        assert hasattr(app_gui.DocumentQAApp, '_create_documents_page')

    def test_delete_document_method_exists(self):
        """_delete_document method must exist."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        assert hasattr(app_gui.DocumentQAApp, '_delete_document'), \
            "_delete_document method must exist"

    def test_delete_requires_confirmation(self):
        """Document deletion must require user confirmation."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._delete_document)
        assert 'askyesno' in source or 'confirm' in source.lower(), \
            "Delete must require confirmation"

    def test_documents_frame_created(self):
        """Documents list frame must be created in documents page."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_documents_page)
        assert 'self.documents_frame' in source, "documents_frame not created"


class TestSettingsPage:
    """Settings page with inline form and collapsible Advanced section."""

    def test_settings_page_exists(self):
        """Settings page must be created."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert '_create_settings_page' in source, "Settings page creation not called"
        assert hasattr(app_gui.DocumentQAApp, '_create_settings_page')

    def test_advanced_settings_present(self):
        """Advanced Settings section must be present in settings page."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_settings_page)
        assert 'advanced' in source.lower() or 'retrieval' in source.lower(), (
            "Advanced/retrieval settings must be in _create_settings_page"
        )

    def test_settings_fields_present(self):
        """All canonical settings fields must be present."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_settings_page)
        required_fields = ['chunk_size', 'n_results', 'max_tokens', 'temperature',
                           'reranking_enabled', 'retrieval_window']
        for field in required_fields:
            assert field in source.lower(), f"Settings field '{field}' not found"


class TestHelpPage:
    """Help page must display keyboard shortcuts and usage info."""

    def test_help_page_exists(self):
        """Help page must be created."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_widgets)
        assert '_create_help_page' in source, "Help page creation not called"
        assert hasattr(app_gui.DocumentQAApp, '_create_help_page')

    def test_help_page_method_exists(self):
        """_create_help_page method must exist."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        assert hasattr(app_gui.DocumentQAApp, '_create_help_page'), \
            "_create_help_page method must exist"

    def test_help_contains_keyboard_shortcuts(self):
        """Help page must document keyboard shortcuts."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_help_page)
        assert 'Keyboard Shortcuts' in source or 'Ctrl+' in source, \
            "Help page must include keyboard shortcuts"
        assert 'Ctrl+Enter' in source, "Ctrl+Enter shortcut must be documented"


class TestCopyButton:
    """Assistant messages must have copy buttons."""

    def test_copy_button_created_for_assistant_messages(self):
        """_add_message must create copy button for assistant messages."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert 'copy' in source.lower(), "Copy button implementation not found"

    def test_add_message_has_copy_button_logic(self):
        """_add_message must have logic for copy button."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert '_make_button' in source, "Copy button must be created with _make_button"


class TestRetrievedChunksExpander:
    """Retrieved chunks must be expandable/collapsible."""

    def test_retrieved_chunks_expander_method_exists(self):
        """_create_retrieved_chunks_expander method must exist."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        assert hasattr(app_gui.DocumentQAApp, '_create_retrieved_chunks_expander'), \
            "_create_retrieved_chunks_expander method must exist"

    def test_add_message_creates_chunks_expander(self):
        """_add_message must call _create_retrieved_chunks_expander when chunks present."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._add_message)
        assert 'retrieved_chunks' in source, "retrieved_chunks parameter not used"
        assert '_create_retrieved_chunks_expander' in source, \
            "Must call _create_retrieved_chunks_expander for chunks"


class TestPageSwitching:
    """Navigation rail buttons must switch between pages."""

    def test_page_switching_methods_exist(self):
        """_switch_page and _show_page methods must exist."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        assert hasattr(app_gui.DocumentQAApp, '_switch_page'), \
            "_switch_page method must exist"
        assert hasattr(app_gui.DocumentQAApp, '_show_page'), \
            "_show_page method must exist"

    def test_current_page_tracking(self):
        """App must track current page."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._switch_page)
        assert '_current_page' in source, "Must track current page with _current_page"


class TestMultilineComposer:
    """Message composer must be multiline with Ctrl+Enter to submit."""

    def test_multiline_textbox_used(self):
        """Message composer must use CTkTextbox for multiline input."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_chat_page)
        assert 'CTkTextbox' in source, "Must use CTkTextbox for multiline input"
        assert 'self.question_entry = CTkTextbox' in source, \
            "question_entry must be a CTkTextbox"

    def test_ctrl_enter_submits_in_multiline(self):
        """Ctrl+Enter must submit in multiline mode."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_chat_page)
        assert 'bind("<Control-Return>"' in source, "Ctrl+Return binding required"
        assert '_ask_question' in source, "Ctrl+Return must call _ask_question"

    def test_enter_allows_newline(self):
        """Regular Enter must allow newlines (not submit)."""
        try:
            import app_gui
        except ImportError:
            pytest.skip("customtkinter not installed")

        source = inspect.getsource(app_gui.DocumentQAApp._create_chat_page)
        assert 'bind("<Return>"' in source, "Return key binding required"
        # Should NOT call _ask_question for regular Return
        assert 'lambda e: None' in source, "Return should not submit"
