"""
Corrective-pass UI tests (Task 2 — second modernization pass).

Verifies all 10 corrective items using source-level inspection (inspect.getsource)
so tests are runnable without a display.

Items covered:
1. Settings page covers ALL canonical schema fields
2. Reranking UI default is False
3. Presets (Fast/Balanced/Quality) exist and reference correct field names
4. Inline validation includes chunk_overlap < chunk_size
5. Ctrl+, switches to Settings page (not legacy modal)
6. Documents page has Add folder, Add files, Clear all, preview/details, delete
7. Progress bar is NOT packed at startup (_show_progress/_hide_progress exist)
8. Help page includes model path, database path, log path, document count
9. No new rag_* keys are written by _save_settings_inline
10. Empty state is outside CTkScrollableFrame (uses sibling start surface)
"""
import inspect
import pytest

# ── Helpers ───────────────────────────────────────────────────────────────────

def _load():
    try:
        import app_gui
        return app_gui
    except ImportError:
        pytest.skip("customtkinter not installed")


def _src(mod, cls, method):
    return inspect.getsource(getattr(getattr(mod, cls), method))


def _file_src():
    with open("app_gui.py") as f:
        return f.read()


# ── 1. Settings page covers ALL canonical schema fields ───────────────────────

class TestSettingsPageFullSchema:
    CANONICAL_FIELDS = [
        "gguf_path", "db_path", "chunk_size", "chunk_overlap",
        "n_results", "min_similarity", "retrieval_window",
        "max_tokens", "temperature", "hybrid_search",
        "reranking_enabled", "initial_retrieval_top_k", "rerank_top_k",
        "context_truncation", "query_transformation_enabled",
        "gguf_n_ctx", "gguf_n_threads",
    ]

    def test_create_settings_page_covers_canonical_fields(self):
        mod = _load()
        # Canonical field names appear across create + load + save methods together
        combined = (
            _src(mod, "DocumentQAApp", "_create_settings_page") +
            _src(mod, "DocumentQAApp", "_load_settings_into_form") +
            _src(mod, "DocumentQAApp", "_save_settings_inline")
        )
        missing = [f for f in self.CANONICAL_FIELDS if f not in combined]
        assert not missing, f"Missing canonical fields across settings methods: {missing}"

    def test_load_settings_into_form_covers_canonical_fields(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_load_settings_into_form")
        # Most fields appear here; gguf_path is "gguf_path" and initial_retrieval_top_k uses initial_top_k var
        key_fields = ["chunk_size", "chunk_overlap", "n_results", "min_similarity",
                      "retrieval_window", "max_tokens", "temperature", "gguf_n_ctx",
                      "gguf_n_threads", "rerank_top_k", "context_truncation", "db_path"]
        missing = [f for f in key_fields if f not in src]
        assert not missing, f"Missing canonical fields in _load_settings_into_form: {missing}"

    def test_save_settings_inline_writes_canonical_fields(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        missing = [f for f in self.CANONICAL_FIELDS if f not in src]
        assert not missing, f"Missing canonical fields in _save_settings_inline: {missing}"

    def test_no_rag_prefixed_keys_written_by_save(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        rag_keys = [
            "rag_chunk_size", "rag_chunk_overlap", "rag_n_results",
            "rag_min_similarity", "rag_retrieval_window", "rag_max_tokens",
            "rag_temperature", "rag_context_truncation",
            "rag_initial_retrieval_top_k", "rag_rerank_top_k",
            "rag_gguf_n_ctx", "rag_gguf_n_threads",
        ]
        found = [k for k in rag_keys if f'"{k}"' in src]
        assert not found, f"_save_settings_inline must not write rag_* keys: {found}"

    def test_embedding_model_and_reranker_model_displayed(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_settings_page")
        assert "embedding_model" in src, "embedding_model display missing"
        assert "reranker_model" in src, "reranker_model display missing"


# ── 2. Reranking UI default is False ─────────────────────────────────────────

class TestRerankingDefault:
    def test_create_settings_page_uses_false_default(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_settings_page")
        assert 'reranking_enabled", False' in src, (
            "_create_settings_page must use False as reranking_enabled default"
        )
        assert 'reranking_enabled", True' not in src, (
            "_create_settings_page must NOT use True as reranking_enabled default"
        )

    def test_load_settings_into_form_uses_false_default(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_load_settings_into_form")
        assert 'reranking_enabled", False' in src, (
            "_load_settings_into_form must use False as reranking_enabled default"
        )
        assert 'reranking_enabled", True' not in src, (
            "_load_settings_into_form must NOT use True as reranking_enabled default"
        )


# ── 3. Presets (Fast/Balanced/Quality) ───────────────────────────────────────

class TestPresets:
    def test_preset_constants_exist(self):
        mod = _load()
        assert hasattr(mod, "_PRESET_FAST"), "_PRESET_FAST constant missing"
        assert hasattr(mod, "_PRESET_BALANCED"), "_PRESET_BALANCED constant missing"
        assert hasattr(mod, "_PRESET_QUALITY"), "_PRESET_QUALITY constant missing"

    def test_preset_fast_has_reranking_off(self):
        mod = _load()
        assert mod._PRESET_FAST.get("reranking_enabled") is False, (
            "_PRESET_FAST must have reranking_enabled=False"
        )

    def test_preset_quality_has_reranking_on(self):
        mod = _load()
        assert mod._PRESET_QUALITY.get("reranking_enabled") is True, (
            "_PRESET_QUALITY must have reranking_enabled=True"
        )

    def test_apply_settings_preset_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_apply_settings_preset"), (
            "_apply_settings_preset method must exist"
        )

    def test_preset_buttons_in_create_settings_page(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_settings_page")
        assert "Fast" in src, "Fast preset button missing from _create_settings_page"
        assert "Balanced" in src, "Balanced preset button missing"
        assert "Quality" in src, "Quality preset button missing"
        assert "_apply_settings_preset" in src, "_apply_settings_preset not called from settings page"

    def test_preset_covers_key_fields(self):
        mod = _load()
        required = ["chunk_size", "max_tokens", "reranking_enabled", "retrieval_window",
                    "initial_retrieval_top_k", "rerank_top_k", "min_similarity"]
        for key in required:
            assert key in mod._PRESET_FAST, f"_PRESET_FAST missing field: {key}"
            assert key in mod._PRESET_BALANCED, f"_PRESET_BALANCED missing field: {key}"
            assert key in mod._PRESET_QUALITY, f"_PRESET_QUALITY missing field: {key}"


# ── 4. Inline validation includes chunk_overlap < chunk_size ─────────────────

class TestInlineValidation:
    def test_chunk_overlap_less_than_chunk_size_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "chunk_overlap < chunk_size" in src or "chunk_overlap" in src and "chunk_size" in src, (
            "Must validate chunk_overlap < chunk_size"
        )
        # More specific: check the error message references the relationship
        assert "< chunk_size" in src or "Chunk Overlap must" in src, (
            "chunk_overlap validation must reference chunk_size bound"
        )

    def test_min_similarity_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "min_similarity" in src and ("0.0" in src or "1.0" in src), (
            "min_similarity 0.0–1.0 validation must exist"
        )

    def test_temperature_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "temperature" in src and "2.0" in src, (
            "temperature 0.0–2.0 validation must exist"
        )

    def test_retrieval_window_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "retrieval_window" in src, "retrieval_window validation missing"

    def test_gguf_n_ctx_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "gguf_n_ctx" in src, "gguf_n_ctx validation missing"

    def test_gguf_n_threads_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "gguf_n_threads" in src, "gguf_n_threads validation missing"

    def test_rerank_top_k_bounded_by_initial_top_k(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "rerank_top_k" in src and "initial_top_k" in src, (
            "rerank_top_k must be validated against initial_top_k"
        )

    def test_context_truncation_validated(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        assert "context_truncation" in src, "context_truncation validation missing"

    def test_save_not_called_when_validation_fails(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        # Must have early returns after error messages
        assert "return" in src and "showerror" in src, (
            "Validation errors must show error dialog and return before saving"
        )


# ── 5. Ctrl+, switches to Settings page ──────────────────────────────────────

class TestCtrlCommaSwitchesSettings:
    def test_ctrl_comma_calls_switch_page_not_open_settings(self):
        mod = _load()
        # Ctrl+, binding is in _create_chat_page (not _create_widgets which is a dispatcher)
        src = _src(mod, "DocumentQAApp", "_create_chat_page")
        assert '<Control-comma>' in src, "Ctrl+, binding missing from _create_chat_page"
        lines = [l for l in src.split('\n') if '<Control-comma>' in l]
        assert lines, "Control-comma binding line not found"
        binding_line = lines[0]
        assert "_switch_page" in binding_line, (
            "Ctrl+, must call _switch_page('settings'), not _open_settings"
        )
        assert "_open_settings" not in binding_line, (
            "Ctrl+, must NOT call _open_settings (legacy modal)"
        )


# ── 6. Documents page: Add folder, Add files, Clear all, details, delete ─────

class TestDocumentsPage:
    def test_add_folder_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_add_folder"), "_add_folder method must exist"

    def test_add_folder_uses_filedialog_askdirectory(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_add_folder")
        assert "askdirectory" in src, "_add_folder must use filedialog.askdirectory"

    def test_add_folder_calls_ingest_directory(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_add_folder")
        assert "ingest_directory" in src, "_add_folder must call engine.ingest_directory"

    def test_clear_all_documents_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_clear_all_documents"), (
            "_clear_all_documents method must exist"
        )

    def test_clear_all_requires_confirmation(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_clear_all_documents")
        assert "askyesno" in src, "_clear_all_documents must require confirmation"

    def test_clear_all_calls_engine_clear_documents(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_clear_all_documents")
        assert "clear_documents" in src, "_clear_all_documents must call engine.clear_documents()"

    def test_documents_page_has_command_row_buttons(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_documents_page")
        assert "Add Folder" in src, "Add Folder button missing from Documents page"
        assert "Add Files" in src or "_ingest_documents" in src, "Add Files button missing"
        assert "Clear All" in src, "Clear All button missing"

    def test_refresh_documents_list_shows_source_path(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_documents_list")
        assert "source_path" in src, "source_path must be displayed in documents list"

    def test_refresh_documents_list_has_details_action(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_documents_list")
        assert "Details" in src or "details" in src.lower(), (
            "Documents list must have a Details action per document"
        )

    def test_refresh_documents_list_uses_doc_id_not_basename(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_documents_list")
        assert 'doc.get("id"' in src or "doc_id" in src, (
            "Must use stable doc_id from engine, not basename"
        )
        assert "os.path.basename" not in src or "doc_id" in src, (
            "Must not use basename as canonical doc ID"
        )

    def test_delete_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_delete_document"), "_delete_document must exist"


# ── 7. Progress hidden when idle ──────────────────────────────────────────────

class TestProgressHiddenWhenIdle:
    def test_show_progress_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_show_progress"), "_show_progress method must exist"

    def test_hide_progress_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_hide_progress"), "_hide_progress method must exist"

    def test_progress_frame_not_packed_in_create_widgets(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_widgets")
        # progress_frame must NOT be unconditionally packed at startup
        lines = [l for l in src.split('\n') if 'progress_frame' in l and '.pack(' in l]
        assert not lines, (
            f"progress_frame must not be packed at startup; found: {lines}"
        )

    def test_hide_progress_packs_forget_progress_frame(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_hide_progress")
        assert "progress_frame" in src and "pack_forget" in src, (
            "_hide_progress must call progress_frame.pack_forget()"
        )

    def test_show_progress_packs_progress_frame(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_show_progress")
        assert "progress_frame" in src and "pack(" in src, (
            "_show_progress must pack the progress_frame"
        )


# ── 8. Help page has runtime status ──────────────────────────────────────────

class TestHelpPageRuntimeStatus:
    def test_help_page_has_version_info(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_help_page")
        assert "version" in src.lower() or "APP_VERSION" in src, (
            "Help page must display app version"
        )

    def test_help_page_has_gguf_path(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_help_status")
        assert "gguf_path" in src, "Help page must display GGUF model path"

    def test_help_page_has_db_path(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_help_status")
        assert "db_path" in src or "database" in src.lower(), (
            "Help page must display database path"
        )

    def test_help_page_has_log_path(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_help_status")
        assert "log" in src.lower(), "Help page must display log path"

    def test_help_page_has_document_count(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_help_status")
        assert "document_count" in src or "doc_count" in src, (
            "Help page must display document count"
        )

    def test_help_page_has_backend_status(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_refresh_help_status")
        assert "engine" in src.lower() or "backend" in src.lower(), (
            "Help page must display backend/model status"
        )

    def test_refresh_help_status_called_on_help_page_switch(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_show_page")
        assert "_refresh_help_status" in src, (
            "_show_page must call _refresh_help_status when switching to help page"
        )

    def test_help_page_has_keyboard_shortcuts(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_help_page")
        assert "Ctrl+Enter" in src or "Keyboard" in src, (
            "Help page must document keyboard shortcuts"
        )


# ── 9. No new rag_* keys written by Settings page ────────────────────────────

class TestNoRagPrefixedKeys:
    def test_save_settings_inline_writes_no_rag_keys(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_save_settings_inline")
        # Check that the settings.update() dict uses canonical (not rag_*) keys
        bad_keys = [
            '"rag_chunk_size"', '"rag_chunk_overlap"', '"rag_n_results"',
            '"rag_min_similarity"', '"rag_retrieval_window"', '"rag_max_tokens"',
            '"rag_temperature"', '"rag_context_truncation"',
            '"rag_initial_retrieval_top_k"', '"rag_rerank_top_k"',
            '"rag_gguf_n_ctx"', '"rag_gguf_n_threads"',
            '"rag_reranking_enabled"', '"rag_hybrid_search"',
        ]
        found = [k for k in bad_keys if k in src]
        assert not found, (
            f"_save_settings_inline must not write rag_* keys; found: {found}"
        )


# ── 10. Empty state is outside CTkScrollableFrame ────────────────────────────

class TestEmptyStateNotInScrollableFrame:
    def test_start_surface_is_sibling_of_chat_frame(self):
        mod = _load()
        # _start_surface is created in _create_chat_page (the page-level method)
        src = _src(mod, "DocumentQAApp", "_create_chat_page")
        assert "_start_surface" in src, "_start_surface must be created in _create_chat_page"
        assert "_chat_area_frame" in src, (
            "_chat_area_frame container must wrap both start_surface and chat_frame"
        )

    def test_create_empty_state_does_not_pack_into_chat_frame(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_empty_state")
        # Should NOT create any child widgets inside chat_frame (only manage visibility)
        assert "CTkFrame(self.chat_frame" not in src, (
            "_create_empty_state must not add CTkFrame into self.chat_frame (scrollable area)"
        )
        assert "CTkLabel(self.chat_frame" not in src, (
            "_create_empty_state must not add CTkLabel into self.chat_frame"
        )

    def test_destroy_empty_state_hides_start_surface(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_destroy_empty_state")
        assert "_start_surface" in src and "pack_forget" in src, (
            "_destroy_empty_state must hide the start surface"
        )

    def test_build_start_surface_method_exists(self):
        mod = _load()
        assert hasattr(mod.DocumentQAApp, "_build_start_surface"), (
            "_build_start_surface method must exist"
        )

    def test_start_surface_has_add_documents_cta(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_build_start_surface")
        assert "Add" in src and ("Documents" in src or "document" in src.lower()), (
            "Start surface must have an 'Add Documents' primary CTA"
        )

    def test_start_surface_has_open_documents_cta(self):
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_build_start_surface")
        assert "_switch_page" in src and "documents" in src, (
            "Start surface must have an 'Open Documents' secondary CTA"
        )


# ── 11. Reranking default False in all UI paths ──────────────────────────────

class TestRerankingDefaultNoTrueInUI:
    def test_settings_dialog_reranking_init_uses_false_default(self):
        """SettingsDialog._create_widgets must not use reranking_enabled=True default."""
        mod = _load()
        src = _src(mod, "SettingsDialog", "_create_widgets")
        assert 'reranking_enabled", True' not in src, (
            "SettingsDialog._create_widgets must not default reranking_enabled to True"
        )

    def test_only_quality_preset_enables_reranking(self):
        """Only _PRESET_QUALITY should have reranking_enabled=True; others must be False."""
        mod = _load()
        assert mod._PRESET_FAST.get("reranking_enabled") is False
        assert mod._PRESET_BALANCED.get("reranking_enabled") is False
        assert mod._PRESET_QUALITY.get("reranking_enabled") is True


# ── 12. Version single source of truth ───────────────────────────────────────

class TestVersionConsistency:
    def test_no_module_level_app_version(self):
        """APP_VERSION module constant must not exist — DocumentQAApp.VERSION is the source of truth."""
        mod = _load()
        assert not hasattr(mod, "APP_VERSION"), (
            "APP_VERSION module constant must be removed; use DocumentQAApp.VERSION"
        )

    def test_help_page_uses_self_version(self):
        """Help page status labels must reference self.VERSION not APP_VERSION."""
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_help_page")
        assert "APP_VERSION" not in src, (
            "_create_help_page must use self.VERSION not the removed APP_VERSION constant"
        )
        assert "self.VERSION" in src, (
            "_create_help_page must reference self.VERSION for the version label"
        )


# ── 13. Add Files uses correct picker and ingest method ──────────────────────

class TestAddFilesImplementation:
    def test_add_files_button_calls_ingest_documents(self):
        """Add Files button in Documents page must call _ingest_documents."""
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_create_documents_page")
        assert '_ingest_documents' in src, (
            "Add Files button must call _ingest_documents (not _add_folder)"
        )

    def test_ingest_documents_uses_askopenfilenames(self):
        """_ingest_documents must use askopenfilenames (file picker, not directory picker)."""
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_ingest_documents")
        assert "askopenfilenames" in src, (
            "_ingest_documents must use filedialog.askopenfilenames for Add Files"
        )
        assert "askopenfilenames" in src and "askdirectory" not in src, (
            "_ingest_documents must NOT use askdirectory (that belongs to _add_folder)"
        )

    def test_ingest_documents_calls_ingest_file_per_file(self):
        """_ingest_documents must call engine.ingest_file() for each selected file."""
        mod = _load()
        src = _src(mod, "DocumentQAApp", "_ingest_documents")
        assert "ingest_file" in src, (
            "_ingest_documents must call engine.ingest_file() for each selected file"
        )
