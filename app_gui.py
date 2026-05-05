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
            value="on" if self.settings.get("reranking_enabled", True) else "off"
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
            context_truncation = int(self.context_truncation_entry.get() or 1024)
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
    """Main application window."""

    APP_NAME = "Document Q&A Assistant"
    VERSION = "2.0.0"
    SETTINGS_FILE = "app_settings.json"

    def __init__(self):
        super().__init__()

        self.title(self.APP_NAME)
        self.geometry("900x700")
        self.minsize(700, 500)

        ctk.set_appearance_mode("system")
        ctk.set_default_color_theme("blue")

        # Defer settings + widget init to allow first render before blocking I/O
        self.engine = None
        self.conversation_history = []
        self.message_queue = queue.Queue()
        self._prev_settings = None
        self.after(50, self._load_settings_and_init)

    def _load_settings_and_init(self):
        """Load settings and initialize widgets (deferred to allow first render)."""
        self.settings = self._load_settings()
        self._create_widgets()
        
        # Dynamic wraplength tracking
        self._last_chat_width = 0

        # Bind chat_frame resize — deferred to avoid winfo_width() == 1 during first render
        self.after(50, self._bind_chat_resize)
        
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
        """Create all UI widgets."""
        # Top bar
        top_bar = CTkFrame(self)
        top_bar.pack(fill="x", padx=Spacing.LG, pady=Spacing.SM)

        CTkLabel(top_bar, text=self.APP_NAME, font=TypeScale.h1()).pack(side="left")

        _make_button(top_bar, "⚙ Settings", self._open_settings, width=100).pack(
            side="right", padx=Spacing.SM
        )
        _make_button(top_bar, "📁 Ingest", self._ingest_documents, width=100).pack(
            side="right", padx=Spacing.SM
        )

        # Status bar
        self.status_frame = CTkFrame(self)
        self.status_frame.pack(fill="x", padx=Spacing.LG, pady=Spacing.SM)

        self.status_label = CTkLabel(
            self.status_frame, text="Initializing...", font=TypeScale.small()
        )
        self.status_label.pack(side="left")

        # Create a middle frame to hold model label to prevent overlapping
        middle_frame = CTkFrame(self.status_frame)
        middle_frame.pack(side="left", expand=True, fill="x")
        self.model_label = CTkLabel(middle_frame, text="Model: None", font=TypeScale.small())
        self.model_label.pack(side="left", padx=Spacing.XXL)

        self.doc_count_label = CTkLabel(
            self.status_frame, text="Documents: 0", font=TypeScale.small()
        )
        self.doc_count_label.pack(side="right")

        # Progress bar
        self.progress = CTkProgressBar(self)
        self.progress.pack(fill="x", padx=Spacing.LG, pady=Spacing.SM)
        self.progress.set(0)

        # Progress label - FR-705
        self.progress_label = CTkLabel(self, text="", font=TypeScale.caption(), text_color=ColorTokens.text_muted())
        self.progress_label.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))

        # Cancel button - hidden until operation starts
        self.cancel_button = CTkButton(
            self,
            text="Cancel",
            width=60,
            height=24,
            font=TypeScale.small(),
            fg_color=ColorTokens.danger(),
            hover_color=ColorTokens.danger_hover(),
            text_color="#ffffff",
            command=self._cancel_operation,
        )
        self.cancel_button.pack_forget()  # Hidden by default

        self._typing_animation_id = None
        self._is_operation_active = False
        self._operation_cancelled = threading.Event()
        self._clear_confirm_timer = None      # stores after() timer id
        self._clear_confirm_pending = False    # True while "Confirm?" is showing
        self._empty_state_visible = False
        self._empty_state_frame = None

        # Chat area
        self.chat_frame = CTkScrollableFrame(self)
        self.chat_frame.pack(fill="both", expand=True, padx=Spacing.LG, pady=Spacing.SM)

        self._create_empty_state()

        # Input area
        input_frame = CTkFrame(self)
        input_frame.pack(fill="x", padx=Spacing.LG, pady=Spacing.LG)

        self.question_entry = CTkEntry(
            input_frame, placeholder_text="Ask a question about your documents..."
        )
        self.question_entry.pack(side="left", fill="x", expand=True, padx=(0, Spacing.LG))

        # FR-701: Bind Enter key on question_entry for submission
        self.question_entry.bind("<Return>", lambda e: self._ask_question() or "break")

        # FR-702: Bind Escape key to clear input or cancel operation
        def _handle_escape():
            if self._clear_confirm_pending:
                self._cancel_clear_confirm()
                self._revert_clear_button()
                return "break"
            if self._is_operation_active:
                self._cancel_operation()
                self.question_entry.delete(0, "end")
            else:
                self.question_entry.delete(0, "end")
            return "break"

        self.question_entry.bind("<Escape>", lambda e: _handle_escape())

        # FR-701: Bind Ctrl+Enter on main window for question submission
        self.bind("<Control-Return>", lambda e: self._ask_question())
        # FR-702: Bind Ctrl+L to clear chat
        self.bind("<Control-l>", lambda e: self._confirm_clear_chat())
        # FR-703: Bind Ctrl+, to open settings
        self.bind("<Control-comma>", lambda e: self._open_settings())

        # FR-707: Bind WM_DELETE_WINDOW for close confirmation during active operations
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self.ask_button = _make_button(
            input_frame, text="Ask", command=self._ask_question,
            width=80, fg_color=ColorTokens.primary(), hover_color=ColorTokens.primary_hover(), text_color=ColorTokens.text_on_primary()
        )
        self.ask_button.pack(side="right")

        # Clear button - FR-704b: store reference and add styling
        self.clear_button = _make_button(
            input_frame, text="Clear", command=self._confirm_clear_chat,
            width=60, fg_color=ColorTokens.secondary(), hover_color=ColorTokens.secondary_hover(), text_color=ColorTokens.text_on_secondary()
        )
        self.clear_button.pack(side="right", padx=Spacing.SM)

    def _truncate_filename(self, filename: str, max_chars: int = _SOURCE_PILL_MAX_CHARS) -> str:
        """Truncate filename to max_chars with ellipsis."""
        if len(filename) <= max_chars:
            return filename
        return filename[: max_chars - 1] + "\u2026"

    def _create_source_pills(self, parent: CTkFrame, sources: list, role: str) -> None:
        """Create a horizontal row of clickable source pill badges.

        Args:
            parent: The message bubble CTkFrame to pack pills into.
            sources: List of source items — each is a str (filename) or
                     dict with "source" key (and optional "text" key for snippet).
            role: The message role ("user", "assistant", "system") for color context.
        """
        if not sources:
            return

        # Initialize expand-state tracker if not present
        if not hasattr(self, "_expanded_pills"):
            self._expanded_pills: dict[str, bool] = {}

        sources_container = CTkFrame(parent, fg_color="transparent")
        sources_container.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))

        # Inner frame for horizontal flow
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
        # Normalize source data — handle both str and dict formats
        if isinstance(source_item, dict):
            filename = str(source_item.get("source", ""))
            snippet = source_item.get("text", "")
        else:
            filename = str(source_item)
            snippet = ""

        if not filename:
            return

        pill_key = filename

        # Outer pill frame (rounded badge)
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

        # Hover visual feedback
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
            # Collapse any other open snippet first (only when expanding)
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

    def _add_message(self, role: str, content: str, sources: list = None, timestamp: str = None):
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

        # Content label (without prefix)
        text_label = CTkLabel(
            msg_frame,
            text=content,
            wraplength=self._get_wraplength(),
            justify="left",
            anchor="w",
            text_color=ColorTokens.text_on_bubble(role),
        )
        text_label.pack(fill="x", padx=Spacing.LG, pady=Spacing.LG)

        if sources:
            self._create_source_pills(msg_frame, sources, role)

        self.chat_frame._parent_canvas.yview_moveto(1.0)

    def _bind_chat_resize(self):
        """Bind <Configure> to chat_frame after first render."""
        if hasattr(self, "chat_frame") and self.chat_frame.winfo_exists():
            self.chat_frame.bind("<Configure>", self._on_chat_resize)

    def _get_wraplength(self) -> int:
        """Return wraplength based on current chat_frame width.

        Falls back to 750 when the frame hasn't rendered yet (winfo_width <= 1).
        """
        width = self.chat_frame.winfo_width()
        if width <= 1:
            return 750
        return max(200, width - 80)

    def _on_chat_resize(self, event):
        """Track chat_frame width changes; avoid expensive re-wraps.

        Only stores new width for *future* messages.  Existing labels are NOT
        iterated — reconfiguring hundreds of CTkLabels on every resize event
        would cause visible jank.
        """
        new_width = self.chat_frame.winfo_width()
        if new_width <= 1:
            return
        if abs(new_width - self._last_chat_width) <= 20:
            return
        self._last_chat_width = new_width

    def _create_empty_state(self):
        """Build and display the empty-state placeholder inside chat_frame.

        Shows when the document count is zero.
        """
        if self._empty_state_visible:
            return

        self._empty_state_frame = CTkFrame(self.chat_frame)
        self._empty_state_frame.pack(
            fill="x",
            padx=Spacing.LG,
            pady=(Spacing.XXL, Spacing.LG),
        )

        center_container = CTkFrame(self._empty_state_frame)
        center_container.pack(expand=True)

        CTkLabel(
            center_container,
            text="📄",
            font=(FONT_FAMILY, 48),
        ).pack(pady=(Spacing.XXL, Spacing.MD))

        CTkLabel(
            center_container,
            text="No documents yet",
            font=TypeScale.h2(),
        ).pack(pady=(0, Spacing.SM))

        CTkLabel(
            center_container,
            text=(
                "Get started by ingesting documents, then ask questions\n"
                "about their content.  Use Settings to configure your LLM."
            ),
            font=TypeScale.body(),
            text_color=ColorTokens.text_muted(),
            justify="center",
            wraplength=400,
        ).pack(pady=(0, Spacing.XXL))

        sample_questions = [
            "How do I use this app?",
            "What can I ask about?",
            "How do I add documents?",
        ]

        for question_text in sample_questions:
            btn = _make_button(
                center_container,
                text=question_text,
                command=lambda q=question_text: self._on_sample_question(q),
                fg_color="transparent",
                text_color=ColorTokens.primary(),
                hover_color=ColorTokens.bubble_system(),
                height=32,
                width=280,
            )
            btn.pack(pady=Spacing.SM)

        CTkLabel(center_container, text="").pack(pady=Spacing.LG)

        self._ingest_cta_button = _make_button(
            center_container,
            text="📂  Ingest Documents",
            command=self._ingest_documents,
            fg_color=ColorTokens.primary(),
            hover_color=ColorTokens.primary_hover(),
            text_color=ColorTokens.text_on_primary(),
            width=280,
        )
        self._ingest_cta_button.pack(pady=(Spacing.MD, Spacing.XXL))

        self._empty_state_visible = True

    def _destroy_empty_state(self):
        """Destroy the empty-state frame if it exists and is visible."""
        if not self._empty_state_visible:
            return
        if (
            self._empty_state_frame is not None
            and self._empty_state_frame.winfo_exists()
        ):
            self._empty_state_frame.destroy()
            self._empty_state_frame = None
        self._empty_state_visible = False

    def _on_sample_question(self, question: str):
        """Handle a sample-question button click."""
        if hasattr(self, "question_entry") and self.question_entry.winfo_exists():
            self.question_entry.delete(0, "end")
            self.question_entry.insert(0, question)
            self._ask_question()

    def _do_clear_chat(self):
        """Clear the chat history - actual implementation."""
        for widget in self.chat_frame.winfo_children():
            widget.destroy()

    def _confirm_clear_chat(self):
        """Inline two-click confirm pattern for clearing chat — FR-704a.

        First click:  button turns red with "Confirm?" text, starts 3 s timer.
        Second click: executes clear and reverts button immediately.
        Timeout:      reverts button to normal "Clear" state.
        """
        if self._clear_confirm_pending:
            # Second click — user confirmed within 3 s
            self._revert_clear_button()
            self._do_clear_chat()
            return

        # First click — enter confirm-pending state
        self._clear_confirm_pending = True
        self.clear_button.configure(
            text="Confirm?",
            fg_color=ColorTokens.danger(),
            hover_color=ColorTokens.danger_hover(),
            text_color="#ffffff",
        )
        # Start 3-second auto-revert timer
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

    def _cancel_operation(self):
        """Cancel the currently running operation.

        Signals cancellation via _operation_cancelled event. The worker thread
        is responsible for checking is_set(), clearing the event, and
        returning early when it detects cancellation.
        """
        self._operation_cancelled.set()
        self._is_operation_active = False

        # Hide typing indicator if visible
        self._hide_typing_indicator()

        # Hide cancel button
        self.after(100, lambda: self.cancel_button.pack_forget())

        # Restore empty state if needed
        self._destroy_empty_state()

        # Re-enable input
        self.message_queue.put(("enable_input", True))

    def _start_message_processor(self):
        """Start background message processor."""

        def process():
            try:
                while True:
                    msg = self.message_queue.get_nowait()
                    if msg[0] == "status":
                        if self.winfo_exists() and hasattr(self, "status_label"):
                            self.status_label.configure(text=msg[1])
                    elif msg[0] == "progress":
                        if self.winfo_exists() and hasattr(self, "progress"):
                            self.progress.set(msg[1] / 100)
                    elif msg[0] == "progress_label":
                        if self.winfo_exists() and hasattr(self, "progress_label"):
                            self.progress_label.configure(text=msg[1])
                    elif msg[0] == "progress_clear":
                        if self.winfo_exists() and hasattr(self, "progress_label"):
                            self.progress_label.configure(text="")
                    elif msg[0] == "progress_clear_delayed":
                        if self.winfo_exists():
                            self.after(3000, lambda: self.message_queue.put(("progress_clear",)))
                    elif msg[0] == "cancel_button_show":
                        if self.winfo_exists() and hasattr(self, "cancel_button"):
                            self.cancel_button.pack(fill="x", padx=Spacing.LG, pady=(0, Spacing.SM))
                    elif msg[0] == "cancel_button_hide":
                        if self.winfo_exists() and hasattr(self, "cancel_button"):
                            self.cancel_button.pack_forget()
                    elif msg[0] == "message":
                        if self.winfo_exists():
                            self._add_message(*msg[1:])
                    elif msg[0] == "doc_count":
                        if self.winfo_exists() and hasattr(self, "doc_count_label"):
                            self.doc_count_label.configure(text=f"Documents: {msg[1]}")
                        # Show/hide empty state based on document count
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
                    elif msg[0] == "model_label":
                        if self.winfo_exists() and hasattr(self, "model_label"):
                            self.model_label.configure(text=msg[1])
            except queue.Empty:
                pass
            if self.winfo_exists():
                self.after(100, process)

        self.after(100, process)

    def _initialize_engine(self):
        """Initialize the RAG engine in a background thread."""

        def init():
            self._is_operation_active = True
            self._operation_cancelled.clear()
            # Show cancel button
            self.message_queue.put(("cancel_button_show",))
            try:
                self.message_queue.put(("status", "Initializing RAG engine..."))
                self.message_queue.put(("progress", 20))
                self.message_queue.put(("progress_label", "20% — Initializing RAG engine..."))

                # Fix torch DLL loading in PyInstaller frozen builds
                if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
                    torch_lib = os.path.join(sys._MEIPASS, "torch", "lib")
                    logger.debug("Frozen mode detected, torch_lib exists=%s", os.path.isdir(torch_lib))
                    if os.path.isdir(torch_lib):
                        os.add_dll_directory(torch_lib)
                        os.environ["PATH"] = torch_lib + os.pathsep + os.environ.get("PATH", "")
                        logger.debug("torch DLL directory added to search path")

                # Check for cancellation before engine creation
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

                # Clear progress label after 3 seconds - FR-705
                self.message_queue.put(("progress_clear_delayed",))

                # Update model label with GGUF file info
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
        """Show inline typing indicator in chat area — replaces status bar overwrite."""
        if not hasattr(self, "chat_frame") or not self.chat_frame.winfo_exists():
            return
        # Remove any existing indicator first
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

        # Scroll to bottom
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

    def _on_close(self):
        """Handle window close — FR-707: confirm before closing during active operations."""
        if self._is_operation_active:
            if not messagebox.askyesno(
                "Confirm Close",
                "An operation is still running. Are you sure you want to close?"
            ):
                return
        self._cancel_clear_confirm()
        self._hide_typing_indicator()
        self.destroy()

    def _open_settings(self):
        """Open settings dialog."""
        dialog = SettingsDialog(self, self.settings)
        self.wait_window(dialog)

        if dialog.result:
            prev_settings = dict(self.settings)
            self.settings.update(dialog.result)
            self._save_settings()

            # Update model label if GGUF path changed
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
        # Show cancel button
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

                    # Check for cancellation after each file
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
                    for failed_path, failed_error in failed_files:
                        self.message_queue.put(
                            ("message", "system", f"Failed to ingest {os.path.basename(failed_path)}: {failed_error}", None, datetime.now().strftime("%H:%M"))
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
        question = self.question_entry.get().strip()
        if not question:
            return
        self._destroy_empty_state()

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        if not self.engine.llm:
            messagebox.showerror("Error", "No LLM backend available. Check Settings.")
            return

        self.question_entry.delete(0, "end")
        self._add_message("user", question, timestamp=datetime.now().strftime("%H:%M"))

        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True
        self._operation_cancelled.clear()
        # Show cancel button
        self.message_queue.put(("cancel_button_show",))
        self._show_typing_indicator()

        def query():
            try:
                result = self.engine.query(
                    question, conversation_history=self.conversation_history
                )

                # Check for cancellation after query
                if self._operation_cancelled.is_set():
                    self._operation_cancelled.clear()
                    self._is_operation_active = False
                    self.message_queue.put(("cancel_button_hide",))
                    self.message_queue.put(("hide_typing",))
                    self.message_queue.put(("enable_input", True))
                    return
                self.conversation_history.append({"role": "user", "content": question})
                self.conversation_history.append(
                    {"role": "assistant", "content": result.answer}
                )
                self.conversation_history = self.conversation_history[-20:]

                self.message_queue.put(
                    ("message", "assistant", result.answer, result.sources, datetime.now().strftime("%H:%M"))
                )
                self.message_queue.put(
                    ("status", f"Ready ({result.inference_time:.1f}s)")
                )
                self.message_queue.put(("enable_input", True))
                self._operation_cancelled.clear()
                self._is_operation_active = False
                self.message_queue.put(("cancel_button_hide",))
                self.message_queue.put(("hide_typing",))

            except Exception as e:
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
