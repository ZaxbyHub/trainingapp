"""
Document Q&A Assistant - GUI Application
A user-friendly interface for the RAG-based document question answering system.
"""

import os
import sys
import json
import logging
import threading
import queue
from pathlib import Path
from typing import Optional
from datetime import datetime

from engine_factory import create_engine_from_settings

try:
    import customtkinter as ctk
    from customtkinter import CTk, CTkFrame, CTkLabel, CTkButton, CTkEntry, CTkTextbox
    from customtkinter import (
        CTkProgressBar,
        CTkOptionMenu,
        CTkScrollableFrame,
        CTkToplevel,
        CTkSwitch,
    )

    GUI_AVAILABLE = True
except ImportError:
    GUI_AVAILABLE = False
    print("customtkinter not installed. Run: pip install customtkinter")

try:
    from tkinter import filedialog, messagebox
    import tkinter as tk
except ImportError:
    pass

import app_paths
from config import MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, MIN_MAX_TOKENS, MAX_MAX_TOKENS, DEFAULT_MAX_TOKENS
from theme import ColorTokens, TypeScale, FONT_FAMILY, Spacing

# Canonical default values for UI presets (minimum-hardware safe)
_PRESET_FAST = {
    "chunk_size": 512, "chunk_overlap": 50, "n_results": 3,
    "min_similarity": 0.35,
    "max_tokens": 256, "temperature": 0.2, "hybrid_search": False,
    "reranking_enabled": False, "retrieval_window": 1,
    "initial_retrieval_top_k": 6, "rerank_top_k": 3,
    "context_truncation": 10000, "query_transformation_enabled": False,
    "gguf_n_ctx": 2048, "gguf_n_threads": 4,
}
_PRESET_BALANCED = {
    "chunk_size": 512, "chunk_overlap": 100, "n_results": 4,
    "min_similarity": 0.3,
    "max_tokens": 512, "temperature": 0.3, "hybrid_search": True,
    "reranking_enabled": False, "retrieval_window": 1,
    "initial_retrieval_top_k": 12, "rerank_top_k": 4,
    "context_truncation": 20000, "query_transformation_enabled": False,
    "gguf_n_ctx": 4096, "gguf_n_threads": 4,
}
_PRESET_QUALITY = {
    "chunk_size": 512, "chunk_overlap": 100, "n_results": 6,
    "min_similarity": 0.25,
    "max_tokens": 1024, "temperature": 0.3, "hybrid_search": True,
    "reranking_enabled": True, "retrieval_window": 2,
    "initial_retrieval_top_k": 20, "rerank_top_k": 6,
    "context_truncation": 30000, "query_transformation_enabled": True,
    "gguf_n_ctx": 4096, "gguf_n_threads": 8,
}

logger = logging.getLogger(__name__)

# Maps legacy rag_-prefixed keys to canonical equivalents
_LEGACY_KEY_MAP = {
    "rag_chunk_overlap": "chunk_overlap",
    "rag_min_similarity": "min_similarity",
    "rag_context_truncation": "context_truncation",
    "rag_db_path": "db_path",
    "rag_embedding_model": "embedding_model",
    "rag_reranker_model": "reranker_model",
    "model_path": "gguf_path",  # already handled, but include for completeness
}

def normalize_settings(settings: dict) -> dict:
    """Migrate legacy rag_*-prefixed keys to canonical equivalents.

    Canonical key takes precedence if both are present.
    """
    result = dict(settings)
    for legacy, canonical in _LEGACY_KEY_MAP.items():
        if legacy in result:
            if canonical not in result:
                result[canonical] = result.pop(legacy)
            else:
                del result[legacy]  # canonical present, drop legacy
    return result

# FR-708: Minimum button height for WCAG 2.5.5 compliance
DEFAULT_BUTTON_HEIGHT = 36  # 36px visual height meets 44px touch target with default CTkButton padding

# === CTkTooltip CLASS (add before SettingsDialog class) ===

TOOLTIP_DELAY_MS: int = 500
TOOLTIP_OFFSET_X: int = 10
TOOLTIP_OFFSET_Y: int = 10
TOOLTIP_MAX_WIDTH: int = 280

TOOLTIP_PAD_PX = (Spacing.SM, Spacing.MD, Spacing.SM, Spacing.MD)

# DD-006: Chat history bounds to prevent memory/performance degradation
CHAT_HISTORY_MAX_MESSAGES: int = 50
CHAT_HISTORY_PRUNE_COUNT: int = 10

SETTINGS_FIELD_HINTS: dict[str, str] = {
    "chunk_size": "Number of tokens per document chunk",
    "n_results": "How many retrieved chunks to include in context",
    "max_tokens": "Maximum tokens in LLM response",
    "temperature": "LLM creativity (0=exact, 1=creative)",
    "hybrid_search": "Combine dense and sparse retrieval",
    "reranking": "Re-rank results with cross-encoder",
    "retrieval_window": "Window of chunks around matched chunk",
    "initial_top_k": "Initial retrieval candidates before reranking",
    "rerank_top_k": "Final candidates after reranking",
    "chunk_overlap": "Token overlap between consecutive chunks to preserve context",
    "min_similarity": "Minimum cosine similarity threshold for retrieved chunks",
    "context_truncation": "Maximum characters of combined context sent to the LLM",
    "db_path": "Directory path for ChromaDB persistent storage",
}


class CTkTooltip:
    """Non-blocking hover tooltip using CTkToplevel."""

    def __init__(
        self,
        parent: ctk.CTkBaseClass,
        widget: ctk.CTkBaseClass,
        text: str,
        *,
        delay_ms: int = TOOLTIP_DELAY_MS,
        offset_x: int = TOOLTIP_OFFSET_X,
        offset_y: int = TOOLTIP_OFFSET_Y,
    ) -> None:
        self._parent = parent
        self._widget = widget
        self._text = text
        self._delay_ms = delay_ms
        self._offset_x = offset_x
        self._offset_y = offset_y
        self._tip_window: Optional[ctk.CTkToplevel] = None
        self._after_id: Optional[str] = None

        self._widget.bind("<Enter>", self._on_enter)
        self._widget.bind("<Leave>", self._on_leave)
        self._parent.bind("<Destroy>", self._on_parent_destroy)

    def show(self) -> None:
        self._cancel()
        self._create_and_show()

    def hide(self) -> None:
        self._cancel()
        if self._tip_window is not None:
            self._tip_window.destroy()
            self._tip_window = None

    def _on_enter(self, _event: tk.Event) -> None:
        self._cancel()
        self._after_id = self._widget.after(self._delay_ms, self._create_and_show)

    def _on_leave(self, _event: tk.Event) -> None:
        self.hide()

    def _on_parent_destroy(self, _event: tk.Event) -> None:
        self.hide()

    def _cancel(self) -> None:
        if self._after_id is not None:
            try:
                self._widget.after_cancel(self._after_id)
            except (tk.TclError, ValueError):
                pass
            self._after_id = None

    def _create_and_show(self) -> None:
        self._after_id = None
        if self._tip_window is not None:
            return

        self._tip_window = ctk.CTkToplevel(self._parent)
        self._tip_window.overrideredirect(True)
        self._tip_window.attributes("-topmost", True)
        try:
            self._tip_window.attributes("-focus", False)
        except tk.TclError:
            pass

        frame = ctk.CTkFrame(
            self._tip_window,
            corner_radius=Spacing.SM,
            fg_color="#3a3a4e",  # Dark surface — consistent across light/dark modes
        )
        frame.pack(fill="both", expand=True, padx=Spacing.XS, pady=Spacing.XS)

        label = ctk.CTkLabel(
            frame,
            text=self._text,
            font=TypeScale.small(),
            wraplength=TOOLTIP_MAX_WIDTH,
            justify="left",
            text_color="#ffffff",  # White text on dark surface — 12:1 contrast in both modes
        )
        label.pack(padx=TOOLTIP_PAD_PX[3], pady=TOOLTIP_PAD_PX[0])

        # Position below widget
        x = self._widget.winfo_rootx() + self._offset_x
        y = self._widget.winfo_rooty() + self._widget.winfo_height() + self._offset_y
        # Clamp to screen
        screen_w = self._widget.winfo_screenwidth()
        screen_h = self._widget.winfo_screenheight()
        geom = self._tip_window.geometry()
        w = int(geom.split("x")[0]) if geom else TOOLTIP_MAX_WIDTH + 20
        h = int(geom.split("+")[0].split("x")[1]) if geom else 50
        x = min(x, screen_w - w - 5)
        y = min(y, screen_h - h - 5)
        self._tip_window.geometry(f"+{x}+{y}")


def attach_field_tooltip(
    parent: ctk.CTkBaseClass,
    widget: ctk.CTkBaseClass,
    field_key: str,
) -> Optional[CTkTooltip]:
    """Attach a tooltip to a settings field."""
    hint = SETTINGS_FIELD_HINTS.get(field_key)
    if hint is None:
        return None
    return CTkTooltip(parent=parent, widget=widget, text=hint)

# === SOURCE PILL CONSTANTS ===
_SOURCE_PILL_MAX_CHARS = 30
_SOURCE_PILL_CORNER_RADIUS = 12


def _make_button(parent, text, command, **kwargs):
    """Create a CTkButton with minimum 36px height for WCAG 2.5.5 compliance.

    CTkButton default height is ~32px. Setting height=36 ensures the visual
    button area meets WCAG 2.5.5 target size guidelines when combined with
    the default widget padding.
    """
    kwargs.setdefault("height", DEFAULT_BUTTON_HEIGHT)
    kwargs.setdefault("border_width", 1)
    return CTkButton(parent, text=text, command=command, **kwargs)


def _classify_error(err: Exception, operation: str) -> str:
    """Return a user-friendly message for engine errors, classified by type."""
    msg = str(err)
    if operation == "ingest":
        if isinstance(err, (ConnectionError, OSError)) and "connect" in msg.lower():
            return "Could not load the model. Make sure the GGUF model path in Settings is correct and the file exists."
        if isinstance(err, FileNotFoundError):
            return f"File not found: {err}. Check the GGUF model path in Settings."
        if "token" in msg.lower() and ("limit" in msg.lower() or "exceed" in msg.lower()):
            return "Token limit exceeded. Try reducing Chunk Size or Results to Retrieve in Settings."
        return f"Ingestion failed. Check the document directory and try again.\n\nError: {err}"
    else:  # query
        if isinstance(err, (ConnectionError, TimeoutError)):
            return "Could not load the LLM. Make sure the GGUF model file exists and the path in Settings is correct."
        if "timeout" in msg.lower():
            return "Request timed out. Try reducing Max Tokens in Settings."
        if "token" in msg.lower() and ("limit" in msg.lower() or "exceed" in msg.lower()):
            return "Token limit exceeded. Try reducing Max Tokens in Settings."
        return f"Query failed. Make sure at least one LLM backend is configured in Settings.\n\nError: {err}"


def get_resource_path(relative_path: str) -> str:
    """Get absolute path to resource, works for dev and for PyInstaller."""
    try:
        base_path = sys._MEIPASS
    except AttributeError:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


class SettingsDialog(CTkToplevel):
    """Settings dialog for configuring the RAG engine."""

    def __init__(self, parent, current_settings: dict):
        super().__init__(parent)
        self.title("Settings")
        self.geometry("500x600")
        self.transient(parent)
        self.grab_set()

        self.settings = current_settings.copy()
        self.result = None

        self._create_widgets()
        self._populate_fields()
        self.model_path_entry.focus_set()

    def _create_widgets(self):
        # Main frame
        main_frame = CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=Spacing.XXL, pady=Spacing.XXL)

        # LLM Settings
        CTkLabel(main_frame, text="LLM Settings", font=TypeScale.h2()).pack(
            pady=(0, Spacing.LG)
        )

        # Model path
        CTkLabel(main_frame, text="GGUF Model Path:").pack(anchor="w")
        model_frame = CTkFrame(main_frame)
        model_frame.pack(fill="x", pady=(0, Spacing.LG))
        self.model_path_entry = CTkEntry(model_frame, width=350, placeholder_text="./model.gguf")
        self.model_path_entry.pack(side="left", padx=(0, Spacing.SM))
        _make_button(
            model_frame, text="Browse", command=self._browse_model, width=70
        ).pack(side="left")

        # Embedding Model (read-only)
        CTkLabel(main_frame, text="Embedding Model:").pack(anchor="w")
        self.embedding_model_label = CTkLabel(
            main_frame, text="", font=TypeScale.body(), text_color=ColorTokens.text_muted()
        )
        self.embedding_model_label.pack(anchor="w", pady=(0, Spacing.LG))

        # Reranker Model (read-only)
        CTkLabel(main_frame, text="Reranker Model:").pack(anchor="w")
        self.reranker_model_label = CTkLabel(
            main_frame, text="", font=TypeScale.body(), text_color=ColorTokens.text_muted()
        )
        self.reranker_model_label.pack(anchor="w", pady=(0, Spacing.LG))

        # RAG Settings
        CTkLabel(main_frame, text="RAG Settings", font=TypeScale.h2()).pack(
            pady=(Spacing.XXL, Spacing.LG)
        )

        settings_frame = CTkFrame(main_frame)
        settings_frame.pack(fill="x")

        CTkLabel(settings_frame, text="Chunk Size:").grid(
            row=0, column=0, sticky="w", pady=Spacing.SM
        )
        self.chunk_size_entry = CTkEntry(settings_frame, width=100, placeholder_text="512")
        self.chunk_size_entry.grid(row=0, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.chunk_size_entry, "chunk_size")

        CTkLabel(settings_frame, text="Results to Retrieve:").grid(
            row=1, column=0, sticky="w", pady=Spacing.SM
        )
        self.n_results_entry = CTkEntry(settings_frame, width=100, placeholder_text="6")
        self.n_results_entry.grid(row=1, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.n_results_entry, "n_results")

        CTkLabel(settings_frame, text="Max Tokens:").grid(
            row=2, column=0, sticky="w", pady=Spacing.SM
        )
        self.max_tokens_entry = CTkEntry(settings_frame, width=100, placeholder_text=str(DEFAULT_MAX_TOKENS))
        self.max_tokens_entry.grid(row=2, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.max_tokens_entry, "max_tokens")

        CTkLabel(settings_frame, text="Temperature:").grid(
            row=3, column=0, sticky="w", pady=Spacing.SM
        )
        self.temperature_entry = CTkEntry(settings_frame, width=100, placeholder_text="0.3")
        self.temperature_entry.grid(row=3, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.temperature_entry, "temperature")

        # Chunk Overlap
        CTkLabel(settings_frame, text="Chunk Overlap:").grid(
            row=4, column=0, sticky="w", pady=Spacing.SM
        )
        self.chunk_overlap_entry = CTkEntry(settings_frame, width=100, placeholder_text="0")
        self.chunk_overlap_entry.grid(row=4, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.chunk_overlap_entry, "chunk_overlap")

        # Min Similarity
        CTkLabel(settings_frame, text="Min Similarity:").grid(
            row=5, column=0, sticky="w", pady=Spacing.SM
        )
        self.min_similarity_entry = CTkEntry(settings_frame, width=100, placeholder_text="0.5")
        self.min_similarity_entry.grid(row=5, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(settings_frame, self.min_similarity_entry, "min_similarity")

        # Advanced RAG Settings
        CTkLabel(main_frame, text="Advanced RAG Settings", font=TypeScale.h2()).pack(
            pady=(Spacing.XXL, Spacing.LG)
        )

        advanced_frame = CTkFrame(main_frame)
        advanced_frame.pack(fill="x")

        # Hybrid Search toggle
        self.hybrid_search_var = tk.StringVar(
            value="on" if self.settings.get("hybrid_search", True) else "off"
        )
        self.hybrid_switch = CTkSwitch(
            advanced_frame,
            text="Enable Hybrid Search",
            variable=self.hybrid_search_var,
            onvalue="on",
            offvalue="off",
        )
        self.hybrid_switch.grid(row=0, column=0, columnspan=2, sticky="w", pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.hybrid_switch, "hybrid_search")

        # Window Expansion
        CTkLabel(advanced_frame, text="Window Expansion (chunks):").grid(
            row=1, column=0, sticky="w", pady=Spacing.SM
        )
        self.retrieval_window_entry = CTkEntry(advanced_frame, width=100, placeholder_text="2")
        self.retrieval_window_entry.grid(row=1, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.retrieval_window_entry, "retrieval_window")

        # Reranking toggle
        self.reranking_var = tk.StringVar(
            value="on" if self.settings.get("reranking_enabled", False) else "off"
        )
        self.reranking_switch = CTkSwitch(
            advanced_frame,
            text="Enable Reranking",
            variable=self.reranking_var,
            onvalue="on",
            offvalue="off",
        )
        self.reranking_switch.grid(row=2, column=0, columnspan=2, sticky="w", pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.reranking_switch, "reranking")

        # Initial Retrieval Top-K
        CTkLabel(advanced_frame, text="Initial Retrieval Top-K:").grid(
            row=3, column=0, sticky="w", pady=Spacing.SM
        )
        self.initial_retrieval_top_k_entry = CTkEntry(advanced_frame, width=100, placeholder_text="30")
        self.initial_retrieval_top_k_entry.grid(row=3, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.initial_retrieval_top_k_entry, "initial_top_k")

        # Rerank Top-K
        CTkLabel(advanced_frame, text="Rerank Top-K:").grid(
            row=4, column=0, sticky="w", pady=Spacing.SM
        )
        self.rerank_top_k_entry = CTkEntry(advanced_frame, width=100, placeholder_text="6")
        self.rerank_top_k_entry.grid(row=4, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.rerank_top_k_entry, "rerank_top_k")

        # Context Truncation
        CTkLabel(advanced_frame, text="Context Truncation:").grid(
            row=5, column=0, sticky="w", pady=Spacing.SM
        )
        self.context_truncation_entry = CTkEntry(advanced_frame, width=100, placeholder_text="20000")
        self.context_truncation_entry.grid(row=5, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(advanced_frame, self.context_truncation_entry, "context_truncation")

        # Database Settings
        CTkLabel(main_frame, text="Database", font=TypeScale.h2()).pack(
            pady=(Spacing.XXL, Spacing.LG)
        )

        db_frame = CTkFrame(main_frame)
        db_frame.pack(fill="x")

        CTkLabel(db_frame, text="Database Path:").grid(row=0, column=0, sticky="w", pady=Spacing.SM)
        self.db_path_entry = CTkEntry(db_frame, width=350, placeholder_text="./doc_qa_db")
        self.db_path_entry.grid(row=0, column=1, padx=Spacing.LG, pady=Spacing.SM)
        attach_field_tooltip(main_frame, self.db_path_entry, "db_path")
        _make_button(
            db_frame, text="Browse", command=self._browse_db_path, width=70
        ).grid(row=0, column=2, padx=Spacing.SM, pady=Spacing.SM)

        # Buttons
        button_frame = CTkFrame(main_frame)
        button_frame.pack(fill="x", pady=(Spacing.XXL, 0))

        _make_button(button_frame, "Cancel", self.destroy,
                    fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(), text_color=ColorTokens.text_on_secondary()).pack(
            side="right", padx=Spacing.SM
        )
        _make_button(button_frame, "Save", self._save,
                    fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(), text_color=ColorTokens.text_on_primary(), border_width=1).pack(
            side="right", padx=Spacing.SM
        )

    def _browse_model(self):
        path = filedialog.askopenfilename(
            title="Select GGUF Model File", filetypes=[("GGUF files", "*.gguf")]
        )
        if path:
            self.model_path_entry.delete(0, "end")
            self.model_path_entry.insert(0, path)

    def _browse_db_path(self):
        path = filedialog.askdirectory(title="Select Database Directory")
        if path:
            self.db_path_entry.delete(0, "end")
            self.db_path_entry.insert(0, path)

    def _populate_fields(self):
        gguf = self.settings.get("gguf_path") or self.settings.get("model_path", "")
        self.model_path_entry.insert(0, gguf)
        self.chunk_size_entry.insert(0, str(self.settings.get("chunk_size", DEFAULT_CHUNK_SIZE)))
        self.n_results_entry.insert(0, str(self.settings.get("n_results", 4)))
        self.max_tokens_entry.insert(0, str(self.settings.get("max_tokens", 512)))
        self.temperature_entry.insert(0, str(self.settings.get("temperature", 0.3)))
        self.hybrid_search_var.set(
            "on" if self.settings.get("hybrid_search", True) else "off"
        )
        self.retrieval_window_entry.insert(
            0, str(self.settings.get("retrieval_window", 1))
        )
        self.reranking_var.set(
            "on" if self.settings.get("reranking_enabled", False) else "off"
        )
        self.initial_retrieval_top_k_entry.insert(0, str(self.settings.get("initial_retrieval_top_k", 12)))
        self.rerank_top_k_entry.insert(0, str(self.settings.get("rerank_top_k", 4)))

        # Read-only model info
        embedding = self.settings.get("embedding_model", "default")
        reranker = self.settings.get("reranker_model", "none")
        self.embedding_model_label.configure(text=embedding)
        self.reranker_model_label.configure(text=reranker)

        # New fields
        self.chunk_overlap_entry.insert(0, str(self.settings.get("chunk_overlap", 100)))
        self.min_similarity_entry.insert(0, str(self.settings.get("min_similarity", 0.3)))
        self.context_truncation_entry.insert(0, str(self.settings.get("context_truncation", 20000)))
        self.db_path_entry.insert(0, str(self.settings.get("db_path", "./doc_qa_db")))

    def _save(self):
        # Validate numeric ranges
        errors = []

        try:
            chunk_size = int(self.chunk_size_entry.get() or DEFAULT_CHUNK_SIZE)
            if not (MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE):
                errors.append(f"Chunk Size must be between {MIN_CHUNK_SIZE} and {MAX_CHUNK_SIZE}")
        except ValueError:
            errors.append("Chunk Size must be a valid integer")

        try:
            n_results = int(self.n_results_entry.get() or 4)
            if not (1 <= n_results <= 20):
                errors.append(f"Results to Retrieve must be between 1 and 20")
        except ValueError:
            errors.append("Results to Retrieve must be a valid integer")

        try:
            max_tokens = int(self.max_tokens_entry.get() or 512)
            if not (MIN_MAX_TOKENS <= max_tokens <= MAX_MAX_TOKENS):
                errors.append(f"Max Tokens must be between {MIN_MAX_TOKENS} and {MAX_MAX_TOKENS}")
        except ValueError:
            errors.append("Max Tokens must be a valid integer")

        try:
            temperature = float(self.temperature_entry.get() or 0.3)
            if not (0.0 <= temperature <= 2.0):
                errors.append(f"Temperature must be between 0.0 and 2.0")
        except ValueError:
            errors.append("Temperature must be a valid number")

        try:
            retrieval_window = int(self.retrieval_window_entry.get() or 1)
            if not (0 <= retrieval_window <= 5):
                errors.append(f"Window Expansion must be between 0 and 5")
        except ValueError:
            errors.append("Window Expansion must be a valid integer")

        try:
            initial_retrieval_top_k = int(self.initial_retrieval_top_k_entry.get() or 12)
            if not (1 <= initial_retrieval_top_k <= 100):
                errors.append("Initial Retrieval Top-K must be between 1 and 100")
        except ValueError:
            errors.append("Initial Retrieval Top-K must be a valid integer")

        try:
            rerank_top_k = int(self.rerank_top_k_entry.get() or 4)
            if not (1 <= rerank_top_k <= 100):
                errors.append("Rerank Top-K must be between 1 and 100")
        except ValueError:
            errors.append("Rerank Top-K must be a valid integer")

        # Validate chunk overlap
        try:
            chunk_overlap = int(self.chunk_overlap_entry.get() or 0)
            if not (0 <= chunk_overlap <= 512):
                errors.append("Chunk Overlap must be between 0 and 512")
        except ValueError:
            errors.append("Chunk Overlap must be a valid integer")

        if errors:
            messagebox.showerror("Validation Error", "\n".join(errors))
            return

        if chunk_overlap >= chunk_size:
            messagebox.showerror(
                "Invalid Settings",
                f"Chunk overlap ({chunk_overlap}) must be less than chunk size ({chunk_size}).",
                parent=self
            )
            return

        # Validate min similarity
        try:
            min_similarity = float(self.min_similarity_entry.get() or 0.5)
            if not (0.0 <= min_similarity <= 1.0):
                errors.append("Min Similarity must be between 0.0 and 1.0")
        except ValueError:
            errors.append("Min Similarity must be a number between 0.0 and 1.0")

        # Validate context truncation
        try:
            context_truncation = int(self.context_truncation_entry.get() or 20000)
            if not (256 <= context_truncation <= 32768):
                errors.append("Context Truncation must be between 256 and 32768")
        except ValueError:
            errors.append("Context Truncation must be a valid integer")

        if errors:
            messagebox.showerror("Validation Error", "\n".join(errors))
            return

        self.result = {
            "gguf_path": self.model_path_entry.get(),
            "chunk_size": chunk_size,
            "n_results": n_results,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "hybrid_search": self.hybrid_search_var.get() == "on",
            "retrieval_window": retrieval_window,
            "reranking_enabled": self.reranking_var.get() == "on",
            "initial_retrieval_top_k": initial_retrieval_top_k,
            "rerank_top_k": rerank_top_k,
            "chunk_overlap": chunk_overlap,
            "min_similarity": min_similarity,
            "context_truncation": context_truncation,
            "db_path": self.db_path_entry.get(),
        }
        # Clean up old "model_path" key if present
        if "model_path" in self.result:
            del self.result["model_path"]
        self.destroy()


class DocumentQAApp(CTk):
    """Main application window with Windows 11-style navigation rail."""

    APP_NAME = "Document Q&A Assistant"
    VERSION = "2.2.0"
    SETTINGS_FILE = "app_settings.json"

    def __init__(self):
        super().__init__()

        self.title(self.APP_NAME)
        self.geometry("1200x800")
        self.minsize(900, 600)

        ctk.set_appearance_mode("system")
        ctk.set_default_color_theme("blue")

        # Defer settings + widget init to allow first render before blocking I/O
        self.engine = None
        self.conversation_history = []
        self.message_queue = queue.Queue()
        self._prev_settings = None
        self._current_page = "chat"  # Track current page
        self.after(50, self._load_settings_and_init)

    def _load_settings_and_init(self):
        """Load settings and initialize widgets (deferred to allow first render)."""
        self.settings = self._load_settings()
        self._create_widgets()

        # Dynamic wraplength tracking
        self._last_chat_width = 0

        # Bind chat_frame resize — deferred to avoid winfo_width() == 1 during first render
        self.after(50, self._bind_chat_resize)

        self._message_processor_shutdown = False
        self._start_message_processor()
        self.after(100, self._initialize_engine)

    def _get_settings_path(self) -> str:
        """Get path to settings file."""
        return str(app_paths.get_settings_path())

    def _load_settings(self) -> dict:
        """Load settings from file."""
        settings_path = self._get_settings_path()

        # Auto-detect bundled model if no settings file exists
        bundled_model = ""
        if not os.path.exists(settings_path):
            bundled_models = [
                Path("models") / "gemma-4-E2B-it-Q5_K-M.gguf",
            ]
            for model_file in bundled_models:
                if model_file.is_file():
                    bundled_model = str(model_file)
                    logger.info("Using bundled model: %s", model_file)
                    break

        default_settings = {
            "gguf_path": bundled_model,
            "chunk_size": 512,
            "n_results": 4,
            "max_tokens": 512,
            "temperature": 0.3,
            "db_path": str(Path(settings_path).parent / "doc_qa_db"),
            "chunk_overlap": 100,
            "min_similarity": 0.3,
            "context_truncation": 20000,
        }

        try:
            if os.path.exists(settings_path):
                with open(settings_path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                    # Backward compatibility: migrate old "model_path" to "gguf_path"
                    if "model_path" in saved and not saved.get("gguf_path"):
                        saved["gguf_path"] = saved.pop("model_path")
                    # Normalize legacy rag_* keys BEFORE merging so that the saved
                    # value correctly overrides the canonical default (not the reverse).
                    default_settings.update(normalize_settings(saved))
        except Exception:
            pass

        return default_settings

    def _save_settings(self):
        """Save settings to file."""
        try:
            settings_path = self._get_settings_path()
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=2)
        except Exception as e:
            print(f"Failed to save settings: {e}")

    def _create_widgets(self):
        """Create all UI widgets with Windows 11 navigation rail style."""
        # Main container with navigation rail
        main_container = CTkFrame(self)
        main_container.pack(fill="both", expand=True)

        # Left navigation rail (Windows 11 style)
        nav_rail = CTkFrame(main_container, fg_color=ColorTokens.bubble_system())
        nav_rail.pack(side="left", fill="y", padx=0, pady=0)

        # Navigation buttons
        nav_width = 80
        nav_btn_color = ColorTokens.secondary()
        nav_btn_hover = ColorTokens.secondary_hover()

        self.nav_chat_btn = _make_button(
            nav_rail, "💬\nChat", lambda: self._switch_page("chat"),
            width=nav_width, height=nav_width,
            fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(),
            text_color=ColorTokens.text_on_primary(),
        )
        self.nav_chat_btn.pack(pady=Spacing.SM, padx=Spacing.SM)

        self.nav_docs_btn = _make_button(
            nav_rail, "📄\nDocuments", lambda: self._switch_page("documents"),
            width=nav_width, height=nav_width,
            fg_color=nav_btn_color, hover_color=nav_btn_hover,
            text_color=ColorTokens.text_on_secondary(),
        )
        self.nav_docs_btn.pack(pady=Spacing.SM, padx=Spacing.SM)

        self.nav_settings_btn = _make_button(
            nav_rail, "⚙\nSettings", lambda: self._switch_page("settings"),
            width=nav_width, height=nav_width,
            fg_color=nav_btn_color, hover_color=nav_btn_hover,
            text_color=ColorTokens.text_on_secondary(),
        )
        self.nav_settings_btn.pack(pady=Spacing.SM, padx=Spacing.SM)

        self.nav_help_btn = _make_button(
            nav_rail, "?\nHelp", lambda: self._switch_page("help"),
            width=nav_width, height=nav_width,
            fg_color=nav_btn_color, hover_color=nav_btn_hover,
            text_color=ColorTokens.text_on_secondary(),
        )
        self.nav_help_btn.pack(pady=Spacing.SM, padx=Spacing.SM)

        # Content area
        self.content_frame = CTkFrame(main_container)
        self.content_frame.pack(side="right", fill="both", expand=True, padx=Spacing.LG, pady=Spacing.LG)

        # Initialize cancellation event before page creation (pages may reference it)
        self._operation_cancelled = threading.Event()

        # Create pages
        self._create_chat_page()
        self._create_documents_page()
        self._create_settings_page()
        self._create_help_page()

        # Show chat page by default
        self._show_page("chat")

    def _create_chat_page(self):
        """Create the chat page."""
        self.chat_page = CTkFrame(self.content_frame)

        # Top bar with status
        top_bar = CTkFrame(self.chat_page)
        top_bar.pack(fill="x", pady=(0, Spacing.LG))

        CTkLabel(top_bar, text="Chat", font=TypeScale.h2()).pack(side="left")

        # Status bar
        self.status_label = CTkLabel(
            top_bar, text="Initializing...", font=TypeScale.small()
        )
        self.status_label.pack(side="left", padx=Spacing.XXL)

        middle_frame = CTkFrame(top_bar)
        middle_frame.pack(side="left", expand=True, fill="x")

        self.model_label = CTkLabel(middle_frame, text="Model: None", font=TypeScale.small())
        self.model_label.pack(side="left", padx=Spacing.XXL)

        self.doc_count_label = CTkLabel(
            top_bar, text="Documents: 0", font=TypeScale.small()
        )
        self.doc_count_label.pack(side="right")

        # Progress bar — hidden when idle; shown via _show_progress()
        self.progress_frame = CTkFrame(self.chat_page)
        self.progress = CTkProgressBar(self.progress_frame)
        self.progress.pack(fill="x")
        self.progress.set(0)
        # progress_frame NOT packed at startup — remains hidden until _show_progress()

        # Progress label — also hidden when idle
        self.progress_label = CTkLabel(
            self.chat_page, text="", font=TypeScale.caption(), text_color=ColorTokens.text_muted()
        )
        # progress_label NOT packed at startup

        # Cancel button
        self.cancel_button = _make_button(
            self.chat_page, "Cancel", command=self._cancel_operation,
            width=60, height=24,
            font=TypeScale.small(),
            fg_color=ColorTokens.danger(),
            hover_color=ColorTokens.danger_hover(),
            text_color="#ffffff",
        )
        self.cancel_button.pack_forget()

        # Typing animation state
        self._typing_animation_id = None
        self._is_operation_active = False
        # _operation_cancelled is initialized in _create_widgets
        self._clear_confirm_timer = None
        self._clear_confirm_pending = False
        self._empty_state_visible = False
        self._empty_state_frame = None
        self._streaming_message_ref: Optional[CTkLabel] = None  # Reference to streaming message content label
        self._streaming_message_frame: Optional[CTkFrame] = None  # Reference to streaming message frame
        self._streaming_finalized: bool = False  # Guard: prevents tokens arriving after finalization from being processed

        # Start surface (shown when no messages; sibling of chat_frame, NOT inside it)
        self._chat_area_frame = CTkFrame(self.chat_page, fg_color="transparent")
        self._chat_area_frame.pack(fill="both", expand=True, pady=(0, Spacing.LG))

        self._start_surface = CTkFrame(self._chat_area_frame, fg_color="transparent")
        self._start_surface.pack(fill="both", expand=True)
        self._build_start_surface(self._start_surface)
        self._empty_state_visible = True

        # Chat area (hidden until first message)
        self.chat_frame = CTkScrollableFrame(self._chat_area_frame)
        # Not packed yet — shown when first message arrives

        # Input area with multiline textbox
        input_frame = CTkFrame(self.chat_page)
        input_frame.pack(fill="x", pady=(0, 0))

        # Multiline textbox for question input
        self.question_entry = CTkTextbox(
            input_frame, height=80, wrap="word"
        )
        self.question_entry.pack(side="left", fill="both", expand=True, padx=(0, Spacing.LG), pady=(Spacing.LG, 0))

        # Keyboard bindings for multiline textbox
        self.question_entry.bind("<Control-Return>", lambda e: self._ask_question() or "break")
        self.question_entry.bind("<Escape>", lambda e: self._handle_escape_key())
        self.question_entry.bind("<Return>", lambda e: None)  # Allow normal Enter for newline

        # Button frame
        button_frame = CTkFrame(input_frame, fg_color="transparent")
        button_frame.pack(side="left", fill="y", padx=(0, 0), pady=(Spacing.LG, 0))

        self.ask_button = _make_button(
            button_frame, text="Ask", command=self._ask_question,
            width=70, height=40, fg_color=ColorTokens.primary(),
            hover_color=ColorTokens.primary_hover(),
            text_color=ColorTokens.text_on_primary()
        )
        self.ask_button.pack(pady=(0, Spacing.SM))

        self.clear_button = _make_button(
            button_frame, text="Clear", command=self._confirm_clear_chat,
            width=70, height=40, fg_color=ColorTokens.secondary(),
            hover_color=ColorTokens.secondary_hover(),
            text_color=ColorTokens.text_on_secondary()
        )
        self.clear_button.pack(pady=(0, 0))

        # FR-702: Bind Ctrl+L to clear chat
        self.bind("<Control-l>", lambda e: self._confirm_clear_chat())
        # FR-703: Bind Ctrl+, to switch to Settings page
        self.bind("<Control-comma>", lambda e: self._switch_page("settings"))

        # FR-707: Bind WM_DELETE_WINDOW for close confirmation during active operations
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _create_documents_page(self):
        """Create the documents management page (real document library)."""
        self.documents_page = CTkFrame(self.content_frame)

        header_row = CTkFrame(self.documents_page, fg_color="transparent")
        header_row.pack(fill="x", pady=(0, Spacing.MD))
        CTkLabel(header_row, text="Documents", font=TypeScale.h2()).pack(side="left")

        # Command row
        cmd_row = CTkFrame(self.documents_page, fg_color="transparent")
        cmd_row.pack(fill="x", pady=(0, Spacing.LG))
        _make_button(cmd_row, text="Add Folder", command=self._add_folder,
                     fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(),
                     text_color=ColorTokens.text_on_primary()).pack(side="left", padx=(0, Spacing.SM))
        _make_button(cmd_row, text="Add Files", command=self._ingest_documents,
                     fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(),
                     text_color=ColorTokens.text_on_primary()).pack(side="left", padx=(0, Spacing.SM))
        _make_button(cmd_row, text="Clear All", command=self._clear_all_documents,
                     fg_color=ColorTokens.danger(), hover_color=ColorTokens.danger_hover(),
                     text_color="#ffffff").pack(side="left")

        # Documents list area
        self.documents_frame = CTkScrollableFrame(self.documents_page)
        self.documents_frame.pack(fill="both", expand=True)

    def _create_settings_page(self):
        """Create the inline settings page covering the full canonical schema."""
        self.settings_page = CTkScrollableFrame(self.content_frame)

        header_row = CTkFrame(self.settings_page, fg_color="transparent")
        header_row.pack(fill="x", pady=(0, Spacing.LG))
        CTkLabel(header_row, text="Settings", font=TypeScale.h2()).pack(side="left")

        # --- Preset buttons ---
        preset_row = CTkFrame(self.settings_page, fg_color="transparent")
        preset_row.pack(fill="x", pady=(0, Spacing.LG))
        CTkLabel(preset_row, text="Preset:", font=TypeScale.body()).pack(side="left", padx=(0, Spacing.SM))
        _make_button(preset_row, text="Fast", width=70,
                     command=lambda: self._apply_settings_preset(_PRESET_FAST),
                     fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(),
                     text_color=ColorTokens.text_on_secondary()).pack(side="left", padx=Spacing.SM)
        _make_button(preset_row, text="Balanced", width=80,
                     command=lambda: self._apply_settings_preset(_PRESET_BALANCED),
                     fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(),
                     text_color=ColorTokens.text_on_secondary()).pack(side="left", padx=Spacing.SM)
        _make_button(preset_row, text="Quality", width=80,
                     command=lambda: self._apply_settings_preset(_PRESET_QUALITY),
                     fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(),
                     text_color=ColorTokens.text_on_secondary()).pack(side="left", padx=Spacing.SM)

        # ── Model & Storage ────────────────────────────────────────────────
        CTkLabel(self.settings_page, text="Model & Storage", font=TypeScale.h3()).pack(anchor="w", pady=(0, Spacing.SM))
        model_store_frame = CTkFrame(self.settings_page)
        model_store_frame.pack(fill="x", pady=(0, Spacing.LG))

        CTkLabel(model_store_frame, text="GGUF Model Path:").pack(anchor="w")
        model_path_row = CTkFrame(model_store_frame, fg_color="transparent")
        model_path_row.pack(fill="x", pady=(0, Spacing.MD))
        self.settings_model_entry = CTkEntry(model_path_row, placeholder_text="./model.gguf")
        self.settings_model_entry.pack(side="left", fill="x", expand=True, padx=(0, Spacing.SM))
        _make_button(model_path_row, text="Browse", command=self._browse_settings_model, width=70).pack(side="left")

        CTkLabel(model_store_frame, text="Database Path:").pack(anchor="w")
        db_path_row = CTkFrame(model_store_frame, fg_color="transparent")
        db_path_row.pack(fill="x", pady=(0, Spacing.MD))
        self.settings_db_path_entry = CTkEntry(db_path_row, placeholder_text="./chroma_db")
        self.settings_db_path_entry.pack(side="left", fill="x", expand=True, padx=(0, Spacing.SM))
        _make_button(db_path_row, text="Browse", command=self._browse_settings_db_path, width=70).pack(side="left")

        CTkLabel(model_store_frame, text="Embedding Model (read-only):").pack(anchor="w")
        self.settings_embedding_model_label = CTkLabel(
            model_store_frame, text="—", font=TypeScale.body(), text_color=ColorTokens.text_muted(), anchor="w"
        )
        self.settings_embedding_model_label.pack(anchor="w", pady=(0, Spacing.MD))

        CTkLabel(model_store_frame, text="Reranker Model (read-only):").pack(anchor="w")
        self.settings_reranker_model_label = CTkLabel(
            model_store_frame, text="—", font=TypeScale.body(), text_color=ColorTokens.text_muted(), anchor="w"
        )
        self.settings_reranker_model_label.pack(anchor="w", pady=(0, Spacing.SM))

        # ── Basic RAG Parameters ───────────────────────────────────────────
        CTkLabel(self.settings_page, text="RAG Parameters", font=TypeScale.h3()).pack(anchor="w", pady=(Spacing.LG, Spacing.SM))
        rag_frame = CTkFrame(self.settings_page)
        rag_frame.pack(fill="x", pady=(0, Spacing.LG))

        for label, attr, placeholder in [
            ("Chunk Size:", "settings_chunk_size_entry", "512"),
            ("Chunk Overlap:", "settings_chunk_overlap_entry", "100"),
            ("Results to Retrieve:", "settings_n_results_entry", "4"),
            ("Min Similarity (0.0–1.0):", "settings_min_similarity_entry", "0.3"),
            ("Retrieval Window:", "settings_retrieval_window_entry", "1"),
        ]:
            CTkLabel(rag_frame, text=label).pack(anchor="w")
            entry = CTkEntry(rag_frame, placeholder_text=placeholder)
            entry.pack(fill="x", pady=(0, Spacing.MD))
            setattr(self, attr, entry)

        # ── LLM Parameters ─────────────────────────────────────────────────
        CTkLabel(self.settings_page, text="LLM Parameters", font=TypeScale.h3()).pack(anchor="w", pady=(Spacing.LG, Spacing.SM))
        llm_frame = CTkFrame(self.settings_page)
        llm_frame.pack(fill="x", pady=(0, Spacing.LG))

        for label, attr, placeholder in [
            ("Max Tokens:", "settings_max_tokens_entry", "512"),
            ("Temperature (0.0–2.0):", "settings_temperature_entry", "0.3"),
            ("GGUF Context Window (n_ctx):", "settings_gguf_n_ctx_entry", "4096"),
            ("GGUF Threads (n_threads):", "settings_gguf_n_threads_entry", "4"),
        ]:
            CTkLabel(llm_frame, text=label).pack(anchor="w")
            entry = CTkEntry(llm_frame, placeholder_text=placeholder)
            entry.pack(fill="x", pady=(0, Spacing.MD))
            setattr(self, attr, entry)

        # ── Advanced Retrieval ─────────────────────────────────────────────
        CTkLabel(self.settings_page, text="Advanced Retrieval", font=TypeScale.h3()).pack(anchor="w", pady=(Spacing.LG, Spacing.SM))
        adv_frame = CTkFrame(self.settings_page)
        adv_frame.pack(fill="x", pady=(0, Spacing.LG))

        for label, attr, placeholder in [
            ("Initial Retrieval Top-K:", "settings_initial_top_k_entry", "12"),
            ("Rerank Top-K:", "settings_rerank_top_k_entry", "4"),
            ("Context Truncation (chars):", "settings_context_truncation_entry", "20000"),
        ]:
            CTkLabel(adv_frame, text=label).pack(anchor="w")
            entry = CTkEntry(adv_frame, placeholder_text=placeholder)
            entry.pack(fill="x", pady=(0, Spacing.MD))
            setattr(self, attr, entry)

        # Toggle switches
        self.settings_hybrid_var = tk.StringVar(value="on" if self.settings.get("hybrid_search", True) else "off")
        CTkSwitch(adv_frame, text="Enable Hybrid Search",
                  variable=self.settings_hybrid_var, onvalue="on", offvalue="off").pack(anchor="w", pady=Spacing.SM)

        # Reranking default is False (minimum-hardware safe)
        self.settings_reranking_var = tk.StringVar(value="on" if self.settings.get("reranking_enabled", False) else "off")
        CTkSwitch(adv_frame, text="Enable Reranking",
                  variable=self.settings_reranking_var, onvalue="on", offvalue="off").pack(anchor="w", pady=Spacing.SM)

        self.settings_query_transform_var = tk.StringVar(value="on" if self.settings.get("query_transformation_enabled", False) else "off")
        CTkSwitch(adv_frame, text="Enable Query Transformation",
                  variable=self.settings_query_transform_var, onvalue="on", offvalue="off").pack(anchor="w", pady=Spacing.SM)

        # ── Action buttons ─────────────────────────────────────────────────
        action_row = CTkFrame(self.settings_page, fg_color="transparent")
        action_row.pack(fill="x", pady=(Spacing.LG, Spacing.XXXL))
        _make_button(action_row, text="Save Settings",
                     command=self._save_settings_inline,
                     fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(),
                     text_color=ColorTokens.text_on_primary()).pack(side="left", padx=(0, Spacing.SM))

    def _create_help_page(self):
        """Create the help/about page with runtime status and keyboard shortcuts."""
        self.help_page = CTkScrollableFrame(self.content_frame)

        CTkLabel(self.help_page, text="Help & About", font=TypeScale.h2()).pack(anchor="w", pady=(0, Spacing.LG))

        # Runtime Status section — labels updated dynamically in _refresh_help_status
        CTkLabel(self.help_page, text="Runtime Status", font=TypeScale.h3()).pack(anchor="w", pady=(0, Spacing.SM))
        status_frame = CTkFrame(self.help_page)
        status_frame.pack(fill="x", pady=(0, Spacing.LG))

        self._help_version_label = CTkLabel(status_frame, text=f"Version: {self.VERSION}", font=TypeScale.body(), anchor="w")
        self._help_version_label.pack(anchor="w", padx=Spacing.LG, pady=Spacing.SM)
        self._help_model_label = CTkLabel(status_frame, text="Model: —", font=TypeScale.body(), anchor="w")
        self._help_model_label.pack(anchor="w", padx=Spacing.LG)
        self._help_gguf_path_label = CTkLabel(status_frame, text="GGUF Path: not configured", font=TypeScale.body(), anchor="w", text_color=ColorTokens.text_muted())
        self._help_gguf_path_label.pack(anchor="w", padx=Spacing.LG)
        self._help_db_path_label = CTkLabel(status_frame, text="Database: —", font=TypeScale.body(), anchor="w", text_color=ColorTokens.text_muted())
        self._help_db_path_label.pack(anchor="w", padx=Spacing.LG)
        self._help_log_path_label = CTkLabel(status_frame, text="Log: —", font=TypeScale.body(), anchor="w", text_color=ColorTokens.text_muted())
        self._help_log_path_label.pack(anchor="w", padx=Spacing.LG)
        self._help_doc_count_label = CTkLabel(status_frame, text="Documents: 0", font=TypeScale.body(), anchor="w")
        self._help_doc_count_label.pack(anchor="w", padx=Spacing.LG, pady=(0, Spacing.SM))

        # Keyboard Shortcuts
        CTkLabel(self.help_page, text="Keyboard Shortcuts", font=TypeScale.h3()).pack(anchor="w", pady=(0, Spacing.SM))
        shortcuts_frame = CTkFrame(self.help_page)
        shortcuts_frame.pack(fill="x", pady=(0, Spacing.LG))
        shortcuts = [
            ("Ctrl+Enter", "Submit question"),
            ("Ctrl+L", "Clear chat history"),
            ("Ctrl+,", "Go to Settings page"),
            ("Escape", "Clear input / cancel"),
        ]
        for key, desc in shortcuts:
            row = CTkFrame(shortcuts_frame, fg_color="transparent")
            row.pack(fill="x", padx=Spacing.LG, pady=Spacing.SM)
            CTkLabel(row, text=key, font=TypeScale.body(), width=120, anchor="w",
                     fg_color=ColorTokens.source_pill_bg(), corner_radius=4).pack(side="left", padx=(0, Spacing.MD))
            CTkLabel(row, text=desc, font=TypeScale.body(), anchor="w").pack(side="left")

        # Workflow
        CTkLabel(self.help_page, text="Getting Started", font=TypeScale.h3()).pack(anchor="w", pady=(0, Spacing.SM))
        workflow_frame = CTkFrame(self.help_page)
        workflow_frame.pack(fill="x", pady=(0, Spacing.LG))
        steps = [
            "1. Go to Settings → set GGUF Model Path → Save Settings",
            "2. Go to Documents → Add Files or Add Folder",
            "3. Go to Chat → type a question → press Ctrl+Enter",
            "4. Adjust Settings presets (Fast/Balanced/Quality) to tune performance",
        ]
        for step in steps:
            CTkLabel(workflow_frame, text=step, font=TypeScale.body(), anchor="w",
                     justify="left").pack(anchor="w", padx=Spacing.LG, pady=Spacing.SM)

    def _refresh_help_status(self):
        """Update runtime status labels on the Help page."""
        if not hasattr(self, "_help_version_label"):
            return
        gguf = self.settings.get("gguf_path", "") or "not configured"
        db = self.settings.get("db_path", "") or app_paths.get_db_path()
        log_path = getattr(app_paths, "get_log_path", lambda: "—")()
        doc_count = 0
        if self.engine:
            try:
                stats = self.engine.get_stats()
                doc_count = stats.get("document_count", 0)
            except Exception:
                pass
        backend = "llama-cpp" if self.engine else "not loaded"
        self._help_model_label.configure(text=f"Backend: {backend}")
        self._help_gguf_path_label.configure(text=f"GGUF Path: {gguf}")
        self._help_db_path_label.configure(text=f"Database: {db}")
        self._help_log_path_label.configure(text=f"Log: {log_path}")
        self._help_doc_count_label.configure(text=f"Documents: {doc_count}")

    def _switch_page(self, page_name: str):
        """Switch to a different page."""
        self._current_page = page_name
        self._show_page(page_name)

    def _show_page(self, page_name: str):
        """Show a specific page and hide others."""
        if page_name == "chat":
            self.chat_page.pack(fill="both", expand=True)
            self.documents_page.pack_forget()
            self.settings_page.pack_forget()
            self.help_page.pack_forget()
            self.nav_chat_btn.configure(fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover())
            self.nav_docs_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_settings_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_help_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
        elif page_name == "documents":
            self.chat_page.pack_forget()
            self.documents_page.pack(fill="both", expand=True)
            self.settings_page.pack_forget()
            self.help_page.pack_forget()
            self._refresh_documents_list()
            self.nav_chat_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_docs_btn.configure(fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover())
            self.nav_settings_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_help_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
        elif page_name == "settings":
            self.chat_page.pack_forget()
            self.documents_page.pack_forget()
            self.settings_page.pack(fill="both", expand=True)
            self.help_page.pack_forget()
            self._load_settings_into_form()
            self.nav_chat_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_docs_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_settings_btn.configure(fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover())
            self.nav_help_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
        elif page_name == "help":
            self.chat_page.pack_forget()
            self.documents_page.pack_forget()
            self.settings_page.pack_forget()
            self.help_page.pack(fill="both", expand=True)
            self._refresh_help_status()
            self.nav_chat_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_docs_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_settings_btn.configure(fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover())
            self.nav_help_btn.configure(fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover())

    def _load_settings_into_form(self):
        """Load current settings into the inline settings form (all canonical fields)."""
        s = self.settings
        entry_map = {
            self.settings_model_entry: s.get("gguf_path", ""),
            self.settings_db_path_entry: s.get("db_path", ""),
            self.settings_chunk_size_entry: str(s.get("chunk_size", DEFAULT_CHUNK_SIZE)),
            self.settings_chunk_overlap_entry: str(s.get("chunk_overlap", 100)),
            self.settings_n_results_entry: str(s.get("n_results", 4)),
            self.settings_min_similarity_entry: str(s.get("min_similarity", 0.3)),
            self.settings_retrieval_window_entry: str(s.get("retrieval_window", 1)),
            self.settings_max_tokens_entry: str(s.get("max_tokens", DEFAULT_MAX_TOKENS)),
            self.settings_temperature_entry: str(s.get("temperature", 0.3)),
            self.settings_gguf_n_ctx_entry: str(s.get("gguf_n_ctx", 4096)),
            self.settings_gguf_n_threads_entry: str(s.get("gguf_n_threads", 4)),
            self.settings_initial_top_k_entry: str(s.get("initial_retrieval_top_k", 12)),
            self.settings_rerank_top_k_entry: str(s.get("rerank_top_k", 4)),
            self.settings_context_truncation_entry: str(s.get("context_truncation", 20000)),
        }
        for entry, value in entry_map.items():
            entry.delete(0, "end")
            entry.insert(0, value)

        # Read-only labels
        self.settings_embedding_model_label.configure(text=s.get("embedding_model", "default"))
        self.settings_reranker_model_label.configure(text=s.get("reranker_model", "default"))

        # Toggle switches — reranking defaults to False (minimum-hardware safe)
        self.settings_hybrid_var.set("on" if s.get("hybrid_search", True) else "off")
        self.settings_reranking_var.set("on" if s.get("reranking_enabled", False) else "off")
        self.settings_query_transform_var.set("on" if s.get("query_transformation_enabled", False) else "off")

    def _browse_settings_model(self):
        """Browse for GGUF model in inline settings."""
        path = filedialog.askopenfilename(
            title="Select GGUF Model File", filetypes=[("GGUF files", "*.gguf")]
        )
        if path:
            self.settings_model_entry.delete(0, "end")
            self.settings_model_entry.insert(0, path)

    def _apply_settings_preset(self, preset: dict):
        """Populate settings form fields from a preset dict (does not save)."""
        s = preset
        entry_map = {
            self.settings_chunk_size_entry: str(s.get("chunk_size", DEFAULT_CHUNK_SIZE)),
            self.settings_chunk_overlap_entry: str(s.get("chunk_overlap", 100)),
            self.settings_n_results_entry: str(s.get("n_results", 4)),
            self.settings_min_similarity_entry: str(s.get("min_similarity", 0.3)),
            self.settings_retrieval_window_entry: str(s.get("retrieval_window", 1)),
            self.settings_max_tokens_entry: str(s.get("max_tokens", DEFAULT_MAX_TOKENS)),
            self.settings_temperature_entry: str(s.get("temperature", 0.3)),
            self.settings_gguf_n_ctx_entry: str(s.get("gguf_n_ctx", 4096)),
            self.settings_gguf_n_threads_entry: str(s.get("gguf_n_threads", 4)),
            self.settings_initial_top_k_entry: str(s.get("initial_retrieval_top_k", 12)),
            self.settings_rerank_top_k_entry: str(s.get("rerank_top_k", 4)),
            self.settings_context_truncation_entry: str(s.get("context_truncation", 20000)),
        }
        for entry, value in entry_map.items():
            entry.delete(0, "end")
            entry.insert(0, value)
        self.settings_hybrid_var.set("on" if s.get("hybrid_search", False) else "off")
        self.settings_reranking_var.set("on" if s.get("reranking_enabled", False) else "off")
        self.settings_query_transform_var.set("on" if s.get("query_transformation_enabled", False) else "off")

    def _browse_settings_db_path(self):
        """Browse for ChromaDB directory in inline settings."""
        path = filedialog.askdirectory(title="Select ChromaDB Directory")
        if path:
            self.settings_db_path_entry.delete(0, "end")
            self.settings_db_path_entry.insert(0, path)

    def _save_settings_inline(self):
        """Save settings from inline form with full validation."""
        try:
            chunk_size = int(self.settings_chunk_size_entry.get() or DEFAULT_CHUNK_SIZE)
            chunk_overlap = int(self.settings_chunk_overlap_entry.get() or 100)
            n_results = int(self.settings_n_results_entry.get() or 4)
            min_similarity = float(self.settings_min_similarity_entry.get() or 0.3)
            retrieval_window = int(self.settings_retrieval_window_entry.get() or 1)
            max_tokens = int(self.settings_max_tokens_entry.get() or DEFAULT_MAX_TOKENS)
            temperature = float(self.settings_temperature_entry.get() or 0.3)
            gguf_n_ctx = int(self.settings_gguf_n_ctx_entry.get() or 4096)
            gguf_n_threads = int(self.settings_gguf_n_threads_entry.get() or 4)
            initial_top_k = int(self.settings_initial_top_k_entry.get() or 12)
            rerank_top_k = int(self.settings_rerank_top_k_entry.get() or 4)
            context_truncation = int(self.settings_context_truncation_entry.get() or 20000)
        except ValueError as e:
            messagebox.showerror("Validation Error", f"Invalid numeric value: {e}")
            return

        errors = []
        if not (MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE):
            errors.append(f"Chunk Size must be {MIN_CHUNK_SIZE}–{MAX_CHUNK_SIZE}")
        if not (0 <= chunk_overlap < chunk_size):
            errors.append("Chunk Overlap must be ≥ 0 and < Chunk Size")
        if chunk_overlap > 512:
            errors.append("Chunk Overlap must be ≤ 512")
        if not (1 <= n_results <= 20):
            errors.append("Results to Retrieve must be 1–20")
        if not (0.0 <= min_similarity <= 1.0):
            errors.append("Min Similarity must be 0.0–1.0")
        if not (1 <= retrieval_window <= 10):
            errors.append("Retrieval Window must be 1–10")
        if not (MIN_MAX_TOKENS <= max_tokens <= MAX_MAX_TOKENS):
            errors.append(f"Max Tokens must be {MIN_MAX_TOKENS}–{MAX_MAX_TOKENS}")
        if not (0.0 <= temperature <= 2.0):
            errors.append("Temperature must be 0.0–2.0")
        if not (512 <= gguf_n_ctx <= 131072):
            errors.append("GGUF n_ctx must be 512–131072")
        if not (1 <= gguf_n_threads <= 256):
            errors.append("GGUF n_threads must be 1–256")
        if not (1 <= initial_top_k <= 100):
            errors.append("Initial Retrieval Top-K must be 1–100")
        if not (1 <= rerank_top_k <= initial_top_k):
            errors.append("Rerank Top-K must be 1–Initial Retrieval Top-K")
        if not (1000 <= context_truncation <= 500000):
            errors.append("Context Truncation must be 1000–500000")

        if errors:
            messagebox.showerror("Validation Errors", "\n".join(f"• {e}" for e in errors))
            return

        prev_settings = dict(self.settings)
        self.settings.update({
            "gguf_path": self.settings_model_entry.get(),
            "db_path": self.settings_db_path_entry.get(),
            "chunk_size": chunk_size,
            "chunk_overlap": chunk_overlap,
            "n_results": n_results,
            "min_similarity": min_similarity,
            "retrieval_window": retrieval_window,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "hybrid_search": self.settings_hybrid_var.get() == "on",
            "reranking_enabled": self.settings_reranking_var.get() == "on",
            "query_transformation_enabled": self.settings_query_transform_var.get() == "on",
            "gguf_n_ctx": gguf_n_ctx,
            "gguf_n_threads": gguf_n_threads,
            "initial_retrieval_top_k": initial_top_k,
            "rerank_top_k": rerank_top_k,
            "context_truncation": context_truncation,
        })
        self._save_settings()

        if messagebox.askyesno("Restart Required", "Settings changed. Restart the engine now?"):
            self._prev_settings = prev_settings
            self._initialize_engine()

    def _refresh_documents_list(self):
        """Refresh the documents list display."""
        # Clear existing widgets
        for widget in self.documents_frame.winfo_children():
            widget.destroy()

        if not self.engine:
            CTkLabel(
                self.documents_frame, text="Engine not initialized",
                text_color=ColorTokens.text_muted()
            ).pack(pady=Spacing.LG)
            return

        try:
            docs = self.engine.get_all_documents()
            if not docs:
                CTkLabel(
                    self.documents_frame, text="No documents loaded. Use 'Ingest Documents' to add files.",
                    text_color=ColorTokens.text_muted()
                ).pack(pady=Spacing.LG)
                return

            for doc in docs:
                doc_id = doc.get("id", "")
                display_name = doc.get("source_display", "Unknown")
                source_path = doc.get("source_path", "")
                chunk_count = doc.get("chunk_count", doc.get("chunks", 0))
                added_at = doc.get("added_at", "Unknown")
                # Derive extension/type from source_path
                ext = Path(source_path).suffix.upper().lstrip(".") if source_path else "?"

                doc_frame = CTkFrame(self.documents_frame, fg_color=ColorTokens.bubble_system())
                doc_frame.pack(fill="x", pady=Spacing.SM)

                doc_info_frame = CTkFrame(doc_frame, fg_color="transparent")
                doc_info_frame.pack(fill="x", padx=Spacing.LG, pady=(Spacing.SM, 0))

                CTkLabel(
                    doc_info_frame, text=f"📄  {display_name}",
                    font=TypeScale.h3(), anchor="w"
                ).pack(anchor="w")

                meta_parts = [f"{ext}", f"{chunk_count} chunks"]
                if added_at and added_at != "Unknown":
                    meta_parts.append(f"indexed {added_at}")
                CTkLabel(
                    doc_info_frame,
                    text="  ·  ".join(meta_parts),
                    font=TypeScale.small(), text_color=ColorTokens.text_muted()
                ).pack(anchor="w")

                if source_path:
                    CTkLabel(
                        doc_info_frame, text=source_path,
                        font=TypeScale.small(), text_color=ColorTokens.text_muted(), anchor="w"
                    ).pack(anchor="w", pady=(0, Spacing.SM))

                action_row = CTkFrame(doc_info_frame, fg_color="transparent")
                action_row.pack(anchor="w", pady=(Spacing.SM, Spacing.SM))
                _make_button(
                    action_row, text="Details", width=70,
                    command=lambda dn=display_name, sp=source_path, cc=chunk_count, aa=added_at:
                        messagebox.showinfo("Document Details",
                            f"Name: {dn}\nPath: {sp}\nChunks: {cc}\nIndexed: {aa}"),
                    fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(),
                    text_color=ColorTokens.text_on_secondary()
                ).pack(side="left", padx=(0, Spacing.SM))
                _make_button(
                    action_row, text="Delete", width=70,
                    fg_color=ColorTokens.danger(), hover_color=ColorTokens.danger_hover(),
                    text_color="#ffffff",
                    command=lambda did=doc_id: self._delete_document(did)
                ).pack(side="left")
        except Exception as e:
            CTkLabel(
                self.documents_frame, text=f"Error loading documents: {e}",
                text_color=ColorTokens.danger()
            ).pack(pady=Spacing.LG)

    def _delete_document(self, doc_id: str):
        """Delete a document from the database."""
        if not messagebox.askyesno("Confirm Delete", "Are you sure you want to delete this document?"):
            return

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        try:
            if self.engine.delete_document(doc_id):
                messagebox.showinfo("Success", "Document deleted successfully")
                self._refresh_documents_list()
                # Update document count
                stats = self.engine.get_stats()
                self.message_queue.put(("doc_count", stats.get("document_count", 0)))
            else:
                messagebox.showerror("Error", "Failed to delete document")
        except Exception as e:
            messagebox.showerror("Error", f"Error deleting document: {e}")

    def _add_folder(self):
        """Ingest an entire folder of documents."""
        folder = filedialog.askdirectory(title="Select Folder to Ingest")
        if not folder:
            return
        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        self._destroy_empty_state()
        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True
        self._operation_cancelled.clear()
        self.message_queue.put(("cancel_button_show",))

        def ingest():
            try:
                def callback(msg, progress):
                    self.message_queue.put(("status", msg))
                    self.message_queue.put(("progress_show", progress))
                    self.message_queue.put(("progress_label", f"{progress}% — {msg}"))

                result = self.engine.ingest_directory(folder, callback=callback)
                docs = result.get("documents", 0)
                chunks = result.get("chunks_total", 0)
                t = result.get("time_seconds", 0)
                self.message_queue.put(("message", "system", f"✓ Ingested {docs} files ({chunks} chunks) in {t:.1f}s from {folder}"))
                stats = self.engine.get_stats()
                self.message_queue.put(("doc_count", stats.get("document_count", 0)))
            except Exception as e:
                self.message_queue.put(("message", "system", f"✗ Folder ingest failed: {e}"))
            finally:
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))
                self.message_queue.put(("enable_input", True))
                self.message_queue.put(("progress_hide",))

        threading.Thread(target=ingest, daemon=True).start()

    def _clear_all_documents(self):
        """Clear all documents from the database."""
        if not messagebox.askyesno("Clear All Documents",
                                   "This will delete ALL documents from the database. Continue?"):
            return
        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return
        try:
            self.engine.clear_documents()
            self._refresh_documents_list()
            self.message_queue.put(("doc_count", 0))
            messagebox.showinfo("Cleared", "All documents have been removed from the database.")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to clear documents: {e}")

    def _truncate_filename(self, filename: str, max_chars: int = _SOURCE_PILL_MAX_CHARS) -> str:
        """Truncate filename to max_chars with ellipsis."""
        if len(filename) <= max_chars:
            return filename
        return filename[: max_chars - 1] + "…"

    def _create_source_pills(self, parent: CTkFrame, sources: list, role: str) -> None:
        """Create a horizontal row of clickable source pill badges."""
        if not sources:
            return

        if not hasattr(self, "_expanded_pills"):
            self._expanded_pills: dict[str, bool] = {}

        sources_container = CTkFrame(parent, fg_color="transparent")
        sources_container.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))

        pills_row = CTkFrame(sources_container, fg_color="transparent")
        pills_row.pack(anchor="w")

        for idx, source_item in enumerate(sources):
            self._create_source_pill(
                parent=pills_row,
                source_item=source_item,
                role=role,
                is_last=(idx == len(sources) - 1),
            )

    def _create_source_pill(
        self,
        parent: CTkFrame,
        source_item: object,
        role: str,
        is_last: bool = False,
    ) -> None:
        """Create a single interactive source pill badge."""
        if isinstance(source_item, dict):
            filename = str(source_item.get("source", ""))
            snippet = source_item.get("text", "")
        else:
            filename = str(source_item)
            snippet = ""

        if not filename:
            return

        pill_key = filename

        pill_frame = CTkFrame(
            parent,
            fg_color=ColorTokens.source_pill_bg(),
            corner_radius=_SOURCE_PILL_CORNER_RADIUS,
        )
        pill_frame.pack(side="left", padx=(0, 0 if is_last else Spacing.SM))

        inner_pad = CTkFrame(pill_frame, fg_color="transparent")
        inner_pad.pack(padx=Spacing.MD, pady=Spacing.SM)

        display_name = self._truncate_filename(filename)
        pill_label = CTkLabel(
            inner_pad,
            text=f"\U0001F4C4 {display_name}",
            font=TypeScale.small(),
            text_color=ColorTokens.text_muted(),
            cursor="hand2",
        )
        pill_label.pack()

        def _on_pill_click(
            event: object,
            _frame: CTkFrame = pill_frame,
            _key: str = pill_key,
            _filename: str = filename,
            _snippet: str = snippet,
            _parent: CTkFrame = parent,
        ) -> None:
            self._toggle_pill_expand(_frame, _key, _filename, _snippet, _parent, role)

        for widget in (pill_frame, inner_pad, pill_label):
            widget.bind("<Button-1>", _on_pill_click)

        pill_frame.bind("<Enter>", lambda e, f=pill_frame: f.configure(cursor="hand2"))
        pill_frame.bind("<Leave>", lambda e, f=pill_frame: f.configure(cursor=""))

    def _toggle_pill_expand(
        self,
        pill_frame: CTkFrame,
        pill_key: str,
        filename: str,
        snippet: str,
        parent: CTkFrame,
        role: str,
    ) -> None:
        """Toggle inline snippet card below pill row."""
        snippet_attr = f"_snippet_frame_{id(pill_frame)}"
        current_snippet = getattr(self, snippet_attr, None)

        is_expanded = self._expanded_pills.get(pill_key, False)

        if is_expanded:
            if current_snippet is not None and current_snippet.winfo_exists():
                current_snippet.destroy()
            self._expanded_pills[pill_key] = False
        else:
            for attr_name in list(vars(self)):
                if attr_name.startswith("_snippet_frame_"):
                    existing = getattr(self, attr_name, None)
                    if existing is not None and existing.winfo_exists():
                        existing.destroy()
            for k in self._expanded_pills:
                self._expanded_pills[k] = False

            snippet_card = CTkFrame(
                parent.master,
                fg_color=ColorTokens.source_pill_bg(),
                corner_radius=Spacing.SM,
            )
            snippet_card.pack(fill="x", pady=(Spacing.SM, 0))
            setattr(self, snippet_attr, snippet_card)

            CTkLabel(
                snippet_card,
                text=filename,
                font=TypeScale.small(),
                text_color=ColorTokens.text_muted(),
                anchor="w",
            ).pack(fill="x", padx=Spacing.LG, pady=(Spacing.MD, 0))

            snippet_text = snippet.strip() if snippet else "No preview available"
            CTkLabel(
                snippet_card,
                text=snippet_text,
                font=TypeScale.body(),
                text_color=ColorTokens.text_on_bubble(role),
                wraplength=self._get_wraplength() - Spacing.LG * 2 - Spacing.XL * 2,
                justify="left",
                anchor="w",
            ).pack(fill="x", padx=Spacing.LG, pady=(Spacing.SM, Spacing.MD))

            self._expanded_pills[pill_key] = True

    def _add_message(self, role: str, content: str, sources: list = None, timestamp: str = None, retrieved_chunks: list = None):
        """Add a message to the chat area with role header and timestamp."""
        msg_frame = CTkFrame(self.chat_frame)
        msg_frame.pack(fill="x", pady=Spacing.SM, padx=Spacing.SM)

        if role == "user":
            bg_color = ColorTokens.bubble_user()
            display_role = "You"
        elif role == "assistant":
            bg_color = ColorTokens.bubble_assistant()
            display_role = "Assistant"
        else:
            bg_color = ColorTokens.bubble_system()
            display_role = "System"

        msg_frame.configure(fg_color=bg_color)

        # Generate timestamp if not provided
        timestamp = timestamp or datetime.now().strftime("%H:%M")

        # Role header row with timestamp
        header_label = CTkLabel(
            msg_frame,
            text=f"{display_role}  ·  {timestamp}",
            font=TypeScale.small(),
            text_color=ColorTokens.text_muted(),
        )
        header_label.pack(fill="x", padx=Spacing.LG, pady=(Spacing.MD, 0))

        # Content label
        text_label = CTkLabel(
            msg_frame,
            text=content,
            wraplength=self._get_wraplength(),
            justify="left",
            anchor="w",
            text_color=ColorTokens.text_on_bubble(role),
        )
        text_label.pack(fill="x", padx=Spacing.LG, pady=Spacing.LG)

        # Copy button for assistant messages
        if role == "assistant":
            copy_btn = _make_button(
                msg_frame, text="Copy", width=60,
                command=lambda: self._copy_to_clipboard(content),
                fg_color=ColorTokens.secondary(),
                hover_color=ColorTokens.secondary_hover(),
                text_color=ColorTokens.text_on_secondary()
            )
            copy_btn.pack(anchor="w", padx=Spacing.LG, pady=(0, Spacing.SM))

        if sources:
            self._create_source_pills(msg_frame, sources, role)

        if retrieved_chunks:
            self._create_retrieved_chunks_expander(msg_frame, retrieved_chunks)

        self.chat_frame._parent_canvas.yview_moveto(1.0)

        # DD-006: Prune oldest messages if chat history exceeds limit
        children = self.chat_frame.winfo_children()
        if len(children) > CHAT_HISTORY_MAX_MESSAGES:
            for widget in children[:-CHAT_HISTORY_MAX_MESSAGES]:
                widget.destroy()

    def _create_retrieved_chunks_expander(self, parent: CTkFrame, chunks: list):
        """Create an expander for retrieved chunks."""
        # Simple expander implementation
        expander_frame = CTkFrame(parent, fg_color="transparent")
        expander_frame.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))

        expanded_state = [False]  # Use list to allow modification in nested function

        def toggle_expander():
            if expanded_state[0]:
                chunks_frame.pack_forget()
                expander_label.configure(text="Show Retrieved Chunks")
                expanded_state[0] = False
            else:
                chunks_frame.pack(fill="x", pady=(Spacing.SM, 0))
                expander_label.configure(text="Hide Retrieved Chunks")
                expanded_state[0] = True

        expander_label = CTkLabel(
            expander_frame, text="Show Retrieved Chunks",
            font=TypeScale.small(),
            text_color=ColorTokens.primary(),
            cursor="hand2"
        )
        expander_label.pack(anchor="w")
        expander_label.bind("<Button-1>", lambda e: toggle_expander())

        chunks_frame = CTkFrame(parent, fg_color=ColorTokens.bubble_system(), corner_radius=Spacing.SM)

        for i, chunk in enumerate(chunks[:5], 1):  # Show first 5 chunks
            chunk_text = chunk.get("text", "") if isinstance(chunk, dict) else str(chunk)
            CTkLabel(
                chunks_frame,
                text=f"Chunk {i}: {chunk_text[:100]}...",
                font=TypeScale.small(),
                text_color=ColorTokens.text_muted(),
                justify="left",
                anchor="w",
                wraplength=400
            ).pack(fill="x", padx=Spacing.LG, pady=Spacing.SM)

    def _copy_to_clipboard(self, text: str):
        """Copy text to clipboard."""
        try:
            self.clipboard_clear()
            self.clipboard_append(text)
            messagebox.showinfo("Copied", "Message copied to clipboard")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to copy: {e}")

    def _bind_chat_resize(self):
        """Bind <Configure> to chat_frame after first render."""
        if hasattr(self, "chat_frame") and self.chat_frame.winfo_exists():
            self.chat_frame.bind("<Configure>", self._on_chat_resize)

    def _get_wraplength(self) -> int:
        """Return wraplength based on current chat_frame width."""
        width = self.chat_frame.winfo_width()
        if width <= 1:
            return 750
        return max(200, width - 80)

    def _on_chat_resize(self, event):
        """Track chat_frame width changes."""
        new_width = self.chat_frame.winfo_width()
        if new_width <= 1:
            return
        if abs(new_width - self._last_chat_width) <= 20:
            return
        self._last_chat_width = new_width

    def _build_start_surface(self, parent: CTkFrame):
        """Populate the start surface with centered empty-state content."""
        center = CTkFrame(parent, fg_color="transparent")
        center.place(relx=0.5, rely=0.5, anchor="center")

        CTkLabel(center, text="📄", font=(FONT_FAMILY, 48)).pack(pady=(0, Spacing.MD))
        CTkLabel(center, text="No documents yet", font=TypeScale.h2()).pack(pady=(0, Spacing.SM))
        CTkLabel(
            center,
            text="Get started by adding documents, then ask questions about their content.",
            font=TypeScale.body(), text_color=ColorTokens.text_muted(),
            justify="center", wraplength=400,
        ).pack(pady=(0, Spacing.XXL))

        _make_button(
            center, text="📂  Add Documents",
            command=self._ingest_documents,
            fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(),
            text_color=ColorTokens.text_on_primary(), width=200,
        ).pack(pady=(0, Spacing.SM))
        _make_button(
            center, text="Open Documents Page",
            command=lambda: self._switch_page("documents"),
            fg_color="transparent", text_color=ColorTokens.primary(),
            hover_color=ColorTokens.bubble_system(), width=200,
        ).pack()

    def _create_empty_state(self):
        """Show the start surface (empty state outside the scrollable chat frame)."""
        if self._empty_state_visible:
            return
        self.chat_frame.pack_forget()
        self._start_surface.pack(fill="both", expand=True)
        self._empty_state_visible = True

    def _destroy_empty_state(self):
        """Hide the start surface and reveal the chat scrollable frame."""
        if not self._empty_state_visible:
            return
        self._start_surface.pack_forget()
        self.chat_frame.pack(fill="both", expand=True)
        self._empty_state_visible = False

    def _on_sample_question(self, question: str):
        """Handle a sample-question button click."""
        if hasattr(self, "question_entry") and self.question_entry.winfo_exists():
            self.question_entry.delete("1.0", "end")
            self.question_entry.insert("1.0", question)
            self._ask_question()

    def _do_clear_chat(self):
        """Clear the chat history - actual implementation."""
        for widget in self.chat_frame.winfo_children():
            widget.destroy()

        # FR-011, SC-008: Clean up expanded pills state
        if hasattr(self, "_expanded_pills"):
            self._expanded_pills.clear()

        # FR-011, SC-008: Clean up orphaned snippet frame attributes
        keys_to_delete = [k for k in self.__dict__ if k.startswith("_snippet_frame_")]
        for k in keys_to_delete:
            del self.__dict__[k]

        # DD-002: Reset streaming state refs to prevent dangling widget access
        self._streaming_message_ref = None
        self._streaming_message_frame = None
        self._streaming_finalized = False

    def _confirm_clear_chat(self):
        """Inline two-click confirm pattern for clearing chat."""
        if self._clear_confirm_pending:
            self._revert_clear_button()
            # DD-002: Reset streaming guard before clearing to handle stream-in-progress case
            self._streaming_finalized = False
            self._do_clear_chat()
            return

        self._clear_confirm_pending = True
        self.clear_button.configure(
            text="Confirm?",
            fg_color=ColorTokens.danger(),
            hover_color=ColorTokens.danger_hover(),
            text_color="#ffffff",
        )
        self._clear_confirm_timer = self.after(
            3000, self._revert_clear_button
        )

    def _revert_clear_button(self):
        """Revert clear button from confirm-pending back to normal state."""
        self._clear_confirm_pending = False
        self._clear_confirm_timer = None
        if hasattr(self, "clear_button") and self.clear_button.winfo_exists():
            self.clear_button.configure(
                text="Clear",
                fg_color=ColorTokens.secondary(),
                hover_color=ColorTokens.secondary_hover(),
                text_color=ColorTokens.text_on_secondary(),
            )

    def _cancel_clear_confirm(self):
        """Cancel any pending clear-confirm timer and reset flag."""
        self._clear_confirm_pending = False
        if self._clear_confirm_timer is not None:
            self.after_cancel(self._clear_confirm_timer)
            self._clear_confirm_timer = None

    def _handle_escape_key(self):
        """Handle Escape key in multiline textbox."""
        if self._clear_confirm_pending:
            self._cancel_clear_confirm()
            self._revert_clear_button()
            return "break"
        self.question_entry.delete("1.0", "end")
        return "break"

    def _show_progress(self, stage: str = "", progress: Optional[float] = None):
        """Show the progress bar and label; set value if given."""
        if not self.progress_frame.winfo_ismapped():
            self.progress_frame.pack(fill="x", pady=(0, Spacing.SM))
        if not self.progress_label.winfo_ismapped():
            self.progress_label.pack(fill="x", pady=(0, Spacing.SM))
        if progress is not None:
            self.progress.set(progress / 100)
        if stage:
            self.progress_label.configure(text=stage)

    def _hide_progress(self):
        """Hide the progress bar and clear its label."""
        self.progress_frame.pack_forget()
        self.progress_label.pack_forget()
        self.progress_label.configure(text="")
        self.progress.set(0)

    def _cancel_operation(self):
        """Cancel the currently running operation."""
        self._operation_cancelled.set()
        self._is_operation_active = False

        self._hide_typing_indicator()
        self.after(100, lambda: self.cancel_button.pack_forget())
        self._destroy_empty_state()
        self.message_queue.put(("enable_input", True))

    def _start_message_processor(self):
        """Start background message processor."""

        def process():
            try:
                while not self._message_processor_shutdown:
                    # DD-004: Validate message tuple structure before processing
                    msg = self.message_queue.get_nowait()
                    if not isinstance(msg, tuple) or len(msg) < 1 or not isinstance(msg[0], str):
                        # Log and skip malformed messages to prevent crashes
                        logging.getLogger("app_gui").warning(f"Skipping malformed message: {type(msg).__name__}")
                        continue
                    if msg[0] == "status":
                        if self.winfo_exists() and hasattr(self, "status_label"):
                            self.status_label.configure(text=msg[1])
                    elif msg[0] == "progress":
                        if self.winfo_exists():
                            self._show_progress(progress=msg[1])
                    elif msg[0] == "progress_show":
                        if self.winfo_exists():
                            self._show_progress(progress=msg[1])
                    elif msg[0] == "progress_hide":
                        if self.winfo_exists():
                            self._hide_progress()
                    elif msg[0] == "progress_label":
                        if self.winfo_exists() and hasattr(self, "progress_label"):
                            self._show_progress(stage=msg[1])
                    elif msg[0] == "progress_clear":
                        if self.winfo_exists():
                            self._hide_progress()
                    elif msg[0] == "progress_clear_delayed":
                        if self.winfo_exists():
                            self.after(3000, lambda: self._hide_progress())
                    elif msg[0] == "cancel_button_show":
                        if self.winfo_exists() and hasattr(self, "cancel_button"):
                            self.cancel_button.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))
                    elif msg[0] == "cancel_button_hide":
                        if self.winfo_exists() and hasattr(self, "cancel_button"):
                            self.cancel_button.pack_forget()
                    elif msg[0] == "assistant_token":
                        # Handle streaming token — append to pending assistant message
                        if self.winfo_exists():
                            self._handle_streaming_token(msg[1])
                    elif msg[0] == "message":
                        if self.winfo_exists():
                            # Handle cancelled queries - display "Cancelled" instead of empty bubble
                            role = msg[1]
                            content = msg[2]
                            if role == "assistant" and content == "[Cancelled]":
                                self._add_message(role, "Cancelled", *msg[3:])
                            else:
                                self._add_message(*msg[1:])
                    elif msg[0] == "doc_count":
                        if self.winfo_exists() and hasattr(self, "doc_count_label"):
                            self.doc_count_label.configure(text=f"Documents: {msg[1]}")
                        if msg[1] > 0:
                            self._destroy_empty_state()
                        elif not self._empty_state_visible:
                            self._create_empty_state()
                    elif msg[0] == "enable_input":
                        if self.winfo_exists():
                            self._hide_typing_indicator()
                            if hasattr(self, "ask_button"):
                                self.ask_button.configure(state="normal")
                            if hasattr(self, "question_entry"):
                                self.question_entry.configure(state="normal")
                    elif msg[0] == "hide_typing":
                        if self.winfo_exists():
                            self._hide_typing_indicator()
                    elif msg[0] == "stream_end":
                        self._finalize_streaming_message(self._get_streaming_text(), destroy_frame=True)
                    elif msg[0] == "stream_destroy":
                        self._finalize_streaming_message(self._get_streaming_text(), destroy_frame=True)
                    elif msg[0] == "model_label":
                        if self.winfo_exists() and hasattr(self, "model_label"):
                            self.model_label.configure(text=msg[1])
            except queue.Empty:
                pass
            if self.winfo_exists():
                self.after(100, process)

        self.after(100, process)

    def _get_streaming_text(self) -> str:
        """Extract accumulated text from the streaming message widget."""
        if self._streaming_message_ref is not None:
            try:
                return self._streaming_message_ref.cget("text")
            except Exception as e:
                logging.getLogger("app_gui").debug(f"Failed to get streaming text: {e}")
        return ""

    def _finalize_streaming_message(self, accumulated_text: str, destroy_frame: bool = True) -> None:
        """Finalize and persist a streaming assistant message, then optionally destroy the frame."""
        if not accumulated_text:
            return
        try:
            self._add_message("assistant", accumulated_text, sources=None, timestamp=datetime.now().strftime("%H:%M"))
        except Exception as e:
            logging.getLogger("app_gui").error(f"Failed to add message to chat: {e}")
        if destroy_frame and self._streaming_message_frame is not None:
            try:
                if self._streaming_message_frame.winfo_exists():
                    self._streaming_message_frame.destroy()
            except Exception as e:
                logging.getLogger("app_gui").debug(f"Failed to destroy streaming frame: {e}")
            self._streaming_message_ref = None
            self._streaming_message_frame = None
        self._streaming_finalized = True

    def _initialize_engine(self):
        """Initialize the RAG engine in a background thread."""

        def init():
            self._is_operation_active = True
            self._operation_cancelled.clear()
            self.message_queue.put(("cancel_button_show",))
            try:
                self.message_queue.put(("status", "Initializing RAG engine..."))
                self.message_queue.put(("progress", 20))
                self.message_queue.put(("progress_label", "20% — Initializing RAG engine..."))

                if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
                    torch_lib = os.path.join(sys._MEIPASS, "torch", "lib")
                    logger.debug("Frozen mode detected, torch_lib exists=%s", os.path.isdir(torch_lib))
                    if os.path.isdir(torch_lib):
                        os.add_dll_directory(torch_lib)
                        os.environ["PATH"] = torch_lib + os.pathsep + os.environ.get("PATH", "")
                        logger.debug("torch DLL directory added to search path")

                if self._operation_cancelled.is_set():
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("enable_input", True))
                    return

                try:
                    self.engine = create_engine_from_settings(self.settings)
                except Exception as engine_error:
                    logger.error("Failed to initialize RAG engine: %s", engine_error)
                    # Rollback to previous settings if available
                    if hasattr(self, "_prev_settings") and self._prev_settings is not None:
                        self.settings = self._prev_settings
                        self._prev_settings = None
                        self._save_settings()
                    self.message_queue.put(("status", "Engine initialization failed"))
                    self.message_queue.put((
                        "message", "system",
                        f"Failed to initialize RAG engine: {engine_error}\n\n"
                        "Please check:\n"
                        "1. GGUF model path is correct in Settings\n\n"
                        "Go to Settings to configure.",
                        None,
                        datetime.now().strftime("%H:%M"),
                    ))
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("enable_input", True))
                    return

                stats = self.engine.get_stats()
                doc_count = stats.get("document_count", 0)

                self.message_queue.put(("doc_count", doc_count))
                self.message_queue.put(("progress", 100))
                self.message_queue.put(("progress_label", "80% — Engine ready, loading stats..."))

                backend = "No LLM"
                model_name = ""
                if self.engine.llm:
                    info = self.engine.llm.get_info()
                    backend = info.get("backend", "Unknown")
                    model_name = info.get("model", "")

                if model_name:
                    self.message_queue.put(("status", f"Ready ({backend} / {model_name})"))
                else:
                    self.message_queue.put(("status", f"Ready ({backend})"))
                self.message_queue.put(("progress_label", "100% — Ready"))
                self.message_queue.put(("enable_input", True))
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))

                self.message_queue.put(("progress_clear_delayed",))

                gguf_path = self.settings.get("gguf_path", "")
                if gguf_path:
                    try:
                        file_size = os.path.getsize(gguf_path)
                        size_mb = file_size / (1024 * 1024)
                        filename = os.path.basename(gguf_path)
                        self.message_queue.put(("model_label", f"Model: {filename} ({size_mb:.1f}MB)"))
                    except Exception as e:
                        logger.warning(
                            "Could not read model file info for %s: %s", gguf_path, e
                        )
                        self.message_queue.put(("model_label", "Model: Unknown"))
                else:
                    self.message_queue.put(("model_label", "Model: None"))

                # Clear backup settings after successful restart
                self._prev_settings = None
                # Clear conversation history on successful engine restart (Fix 6c)
                self.conversation_history = []

            except Exception as e:
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(
                    (
                        "message",
                        "system",
                        f"Failed to initialize: {e}\n\nPlease check Settings.",
                        None,
                        datetime.now().strftime("%H:%M"),
                    )
                )
                self.message_queue.put(("enable_input", True))

        threading.Thread(target=init, daemon=True).start()

    def _show_typing_indicator(self):
        """Show inline typing indicator in chat area."""
        if not hasattr(self, "chat_frame") or not self.chat_frame.winfo_exists():
            return
        self._hide_typing_indicator()

        self._typing_frame = CTkFrame(self.chat_frame, fg_color=ColorTokens.bubble_system())
        self._typing_frame.pack(fill="x", pady=Spacing.SM, padx=Spacing.SM)

        self._typing_label = CTkLabel(
            self._typing_frame,
            text="Thinking...",
            font=TypeScale.small(),
            text_color=ColorTokens.text_muted(),
        )
        self._typing_label.pack(padx=Spacing.LG, pady=Spacing.SM)

        self._typing_dots = 0
        self._animate_typing()

        if hasattr(self.chat_frame, "_parent_canvas"):
            self.chat_frame._parent_canvas.yview_moveto(1.0)

    def _animate_typing(self):
        """Animate typing indicator dots."""
        if not hasattr(self, "_typing_label") or not self._typing_label.winfo_exists():
            return
        self._typing_dots = (self._typing_dots + 1) % 4
        dots = "." * self._typing_dots
        self._typing_label.configure(text=f"Thinking{dots}")
        self._typing_animation_id = self.after(400, self._animate_typing)

    def _hide_typing_indicator(self):
        """Hide inline typing indicator and destroy its frame."""
        if hasattr(self, "_typing_animation_id") and self._typing_animation_id is not None:
            self.after_cancel(self._typing_animation_id)
            self._typing_animation_id = None
        if hasattr(self, "_typing_frame") and self._typing_frame.winfo_exists():
            self._typing_frame.destroy()
        if hasattr(self, "_typing_label"):
            del self._typing_label
        if hasattr(self, "_typing_frame"):
            del self._typing_frame

    def _handle_streaming_token(self, token: str):
        """Handle a streaming token from the LLM.
        
        Creates a new assistant message on first token, then appends subsequent
        tokens to the message content label. All UI updates happen on the main
        thread via this method being called from the message processor.
        
        Args:
            token: The token text to append to the current message.
        """
        # Guard: discard tokens after cancellation or after finalization
        if self._operation_cancelled.is_set():
            return
        if self._streaming_finalized:
            return
        
        if self._streaming_message_ref is None:
            # First token — create the assistant message structure
            self._streaming_message_frame = CTkFrame(self.chat_frame)
            self._streaming_message_frame.pack(fill="x", pady=Spacing.SM, padx=Spacing.SM)

            bg_color = ColorTokens.bubble_assistant()
            self._streaming_message_frame.configure(fg_color=bg_color)

            # Role header row with timestamp
            header_label = CTkLabel(
                self._streaming_message_frame,
                text="Assistant  ·  " + datetime.now().strftime("%H:%M"),
                font=TypeScale.small(),
                text_color=ColorTokens.text_muted(),
            )
            header_label.pack(fill="x", padx=Spacing.LG, pady=(Spacing.MD, 0))

            # Content label (starts empty)
            text_label = CTkLabel(
                self._streaming_message_frame,
                text=token,
                wraplength=self._get_wraplength(),
                justify="left",
                anchor="w",
                text_color=ColorTokens.text_on_bubble("assistant"),
            )
            text_label.pack(fill="x", padx=Spacing.LG, pady=Spacing.LG)

            self._streaming_message_ref = text_label

            # Scroll to bottom
            if hasattr(self.chat_frame, "_parent_canvas"):
                self.chat_frame._parent_canvas.yview_moveto(1.0)
        else:
            # Subsequent token — append to existing message
            current_text = self._streaming_message_ref.cget("text")
            self._streaming_message_ref.configure(text=current_text + token)

            # Scroll to bottom
            if hasattr(self.chat_frame, "_parent_canvas"):
                self.chat_frame._parent_canvas.yview_moveto(1.0)

    def _on_close(self):
        """Handle window close — confirm before closing during active operations."""
        if self._is_operation_active:
            if not messagebox.askyesno(
                "Confirm Close",
                "An operation is still running. Are you sure you want to close?"
            ):
                return
        self._cancel_clear_confirm()
        self._hide_typing_indicator()
        self._message_processor_shutdown = True
        self.destroy()

    def _open_settings(self):
        """Open settings dialog."""
        dialog = SettingsDialog(self, self.settings)
        self.wait_window(dialog)

        if dialog.result:
            prev_settings = dict(self.settings)
            self.settings.update(dialog.result)
            self._save_settings()

            if "gguf_path" in dialog.result:
                gguf_path = dialog.result["gguf_path"]
                if gguf_path:
                    try:
                        file_size = os.path.getsize(gguf_path)
                        size_mb = file_size / (1024 * 1024)
                        filename = os.path.basename(gguf_path)
                        self.model_label.configure(
                            text=f"Model: {filename} ({size_mb:.1f}MB)"
                        )
                    except Exception as e:
                        logger.warning(
                            "Could not read model file info for %s: %s", gguf_path, e
                        )
                        self.model_label.configure(text="Model: Unknown")
                else:
                    self.model_label.configure(text="Model: None")

            if messagebox.askyesno(
                "Restart Required", "Settings changed. Restart the engine now?"
            ):
                self._prev_settings = prev_settings
                self._initialize_engine()

    def _ingest_documents(self):
        """Open file picker and ingest documents."""
        files = filedialog.askopenfilenames(
            title="Select Documents",
            filetypes=[
                ("Text files", "*.txt"),
                ("PDF files", "*.pdf"),
                ("Word files", "*.docx"),
                ("Markdown files", "*.md"),
                ("HTML files", "*.html"),
                ("JSON files", "*.json"),
                ("CSV files", "*.csv"),
                ("All files", "*.*"),
            ],
        )
        if not files:
            return

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        self._destroy_empty_state()
        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True
        self._operation_cancelled.clear()
        self.message_queue.put(("cancel_button_show",))

        def ingest():
            try:
                total_documents = 0
                total_chunks_added = 0
                total_time_seconds = 0.0
                failed_files = []

                def callback(msg, progress):
                    self.message_queue.put(("status", msg))
                    self.message_queue.put(("progress", progress))
                    self.message_queue.put(("progress_label", f"{progress}% — {msg}"))

                for i, file_path in enumerate(files, 1):
                    callback(f"Processing file {i} of {len(files)}: {os.path.basename(file_path)}", int((i / len(files)) * 100))

                    try:
                        source_name = os.path.basename(file_path)
                        file_stats = self.engine.ingest_file(file_path, source_name=source_name)
                        if file_stats.get("success"):
                            total_documents += 1
                            total_chunks_added += file_stats.get("chunks_added", 0)
                            total_time_seconds += file_stats.get("time_seconds", 0)
                        else:
                            failed_files.append((file_path, ValueError(file_stats.get("message", "No content extracted"))))
                            self.message_queue.put(
                                ("message", "system", f"Failed to ingest {os.path.basename(file_path)}: {file_stats.get('message', 'No content extracted')}", None, datetime.now().strftime("%H:%M"))
                            )
                    except Exception as file_error:
                        failed_files.append((file_path, file_error))
                        self.message_queue.put(
                            ("message", "system", f"Failed to ingest {os.path.basename(file_path)}: {file_error}", None, datetime.now().strftime("%H:%M"))
                        )

                    if self._operation_cancelled.is_set():
                        self.message_queue.put(("message", "system", "Ingest cancelled by user.", None, datetime.now().strftime("%H:%M")))
                        self.message_queue.put(("progress_clear",))
                        self._operation_cancelled.clear()
                        self._is_operation_active = False
                        self.message_queue.put(("cancel_button_hide",))
                        self.message_queue.put(("enable_input", True))
                        return

                if not failed_files:
                    self.message_queue.put(
                        (
                            "message",
                            "system",
                            f"✓ Ingested {total_documents} documents "
                            f"({total_chunks_added} new chunks) "
                            f"in {total_time_seconds:.1f}s",
                            None,
                            datetime.now().strftime("%H:%M"),
                        )
                    )
                    self.message_queue.put(
                        ("doc_count", self.engine.get_stats()["document_count"])
                    )
                    self.message_queue.put(("progress_clear",))
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("enable_input", True))
                else:
                    total_files = len(files)
                    successful_files = total_files - len(failed_files)
                    self.message_queue.put(
                        (
                            "message",
                            "system",
                            f"✓ Ingested {successful_files}/{total_files} files "
                            f"({total_documents} documents, {total_chunks_added} new chunks) "
                            f"in {total_time_seconds:.1f}s",
                            None,
                            datetime.now().strftime("%H:%M"),
                        )
                    )
                    self.message_queue.put(
                        ("doc_count", self.engine.get_stats()["document_count"])
                    )
                    self.message_queue.put(("progress_clear",))
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("enable_input", True))

            except Exception as e:
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", _classify_error(e, "ingest"), None, datetime.now().strftime("%H:%M")))
                self.message_queue.put(("enable_input", True))
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))

        threading.Thread(target=ingest, daemon=True).start()

    def _ask_question(self):
        """Process a user question."""
        question = self.question_entry.get("1.0", "end-1c").strip()
        if not question:
            return
        self._destroy_empty_state()

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        self.question_entry.delete("1.0", "end")
        self._add_message("user", question, timestamp=datetime.now().strftime("%H:%M"))

        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True
        self._operation_cancelled.clear()
        self._streaming_finalized = False
        self.message_queue.put(("cancel_button_show",))
        self._show_typing_indicator()

        # Streaming callback — puts tokens into the message queue for main-thread handling
        def on_token(token: str):
            if not self._operation_cancelled.is_set():
                self.message_queue.put(("assistant_token", token))

        def query():
            try:
                # Initialize LLM in background thread to avoid freezing GUI
                self.engine._ensure_llm()
                if not self.engine.llm:
                    # Queue error to run on main thread
                    self.message_queue.put(("message", "system", "No LLM backend available. Check Settings.", None, datetime.now().strftime("%H:%M")))
                    self.message_queue.put(("enable_input", True))
                    self.message_queue.put(("hide_typing",))
                    return

                # Pass stream_callback and cancellation_event to engine.query
                result = self.engine.query(
                    question,
                    conversation_history=self.conversation_history,
                    stream_callback=on_token,
                    cancellation_event=self._operation_cancelled
                )

                if self._operation_cancelled.is_set():
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    # Queue stream_destroy to run on main thread (tkinter thread-safety)
                    self.message_queue.put(("stream_destroy",))
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("hide_typing",))
                    self.message_queue.put(("enable_input", True))
                    self._streaming_message_ref = None
                    self._streaming_message_frame = None
                    return

                # If streaming was used, send stream_end to finalize on main thread
                if self._streaming_message_ref is not None:
                    self.message_queue.put(("stream_end",))

                # FR-002.3: Only append to conversation_history on successful (non-cancelled, non-empty) query result
                if result.answer and result.answer != "[Cancelled]":
                    self.conversation_history.append({"role": "user", "content": question})
                    self.conversation_history.append(
                        {"role": "assistant", "content": result.answer}
                    )
                    self.conversation_history = self.conversation_history[-20:]


                self.message_queue.put(
                    ("status", f"Ready ({result.inference_time:.1f}s)")
                )
                self.message_queue.put(("enable_input", True))
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))
                self.message_queue.put(("hide_typing",))

            except Exception as e:
                # Queue stream_destroy to run on main thread — preserves partial content via _add_message
                self.message_queue.put(("stream_destroy",))
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", _classify_error(e, "query"), None, datetime.now().strftime("%H:%M")))
                self.message_queue.put(("enable_input", True))
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))
                self.message_queue.put(("hide_typing",))

        threading.Thread(target=query, daemon=True).start()


def main():
    """Main entry point."""
    if not GUI_AVAILABLE:
        print("GUI not available. Install customtkinter:")
        print("  pip install customtkinter")
        sys.exit(1)

    app = DocumentQAApp()
    app.mainloop()


if __name__ == "__main__":
    main()
