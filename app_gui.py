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

logger = logging.getLogger(__name__)

# FR-710: Segoe UI font family for consistent typography
FONT_FAMILY = "Segoe UI"

# FR-708: Minimum button height for WCAG 2.5.5 compliance
DEFAULT_BUTTON_HEIGHT = 36  # 36px visual height meets 44px touch target with default CTkButton padding


def _make_button(parent, text, command, **kwargs):
    """Create a CTkButton with minimum 36px height for WCAG 2.5.5 compliance.
    
    CTkButton default height is ~32px. Setting height=36 ensures the visual
    button area meets WCAG 2.5.5 target size guidelines when combined with
    the default widget padding.
    """
    kwargs.setdefault("height", DEFAULT_BUTTON_HEIGHT)
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
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)

        # LLM Settings
        CTkLabel(main_frame, text="LLM Settings", font=(FONT_FAMILY, 16, "bold")).pack(
            pady=(0, 10)
        )

        # Model path
        CTkLabel(main_frame, text="GGUF Model Path:").pack(anchor="w")
        model_frame = CTkFrame(main_frame)
        model_frame.pack(fill="x", pady=(0, 10))
        self.model_path_entry = CTkEntry(model_frame, width=350)
        self.model_path_entry.pack(side="left", padx=(0, 5))
        _make_button(
            model_frame, text="Browse", command=self._browse_model, width=70
        ).pack(side="left")

        # RAG Settings
        CTkLabel(main_frame, text="RAG Settings", font=(FONT_FAMILY, 16, "bold")).pack(
            pady=(20, 10)
        )

        settings_frame = CTkFrame(main_frame)
        settings_frame.pack(fill="x")

        CTkLabel(settings_frame, text="Chunk Size:").grid(
            row=0, column=0, sticky="w", pady=5
        )
        self.chunk_size_entry = CTkEntry(settings_frame, width=100)
        self.chunk_size_entry.grid(row=0, column=1, padx=10, pady=5)

        CTkLabel(settings_frame, text="Results to Retrieve:").grid(
            row=1, column=0, sticky="w", pady=5
        )
        self.n_results_entry = CTkEntry(settings_frame, width=100)
        self.n_results_entry.grid(row=1, column=1, padx=10, pady=5)

        CTkLabel(settings_frame, text="Max Tokens:").grid(
            row=2, column=0, sticky="w", pady=5
        )
        self.max_tokens_entry = CTkEntry(settings_frame, width=100)
        self.max_tokens_entry.grid(row=2, column=1, padx=10, pady=5)

        CTkLabel(settings_frame, text="Temperature:").grid(
            row=3, column=0, sticky="w", pady=5
        )
        self.temperature_entry = CTkEntry(settings_frame, width=100)
        self.temperature_entry.grid(row=3, column=1, padx=10, pady=5)

        # Advanced RAG Settings
        CTkLabel(main_frame, text="Advanced RAG Settings", font=(FONT_FAMILY, 16, "bold")).pack(
            pady=(20, 10)
        )

        advanced_frame = CTkFrame(main_frame)
        advanced_frame.pack(fill="x")

        # Hybrid Search toggle
        CTkLabel(advanced_frame, text="Hybrid Search (BM25 + Vector):").grid(
            row=0, column=0, sticky="w", pady=5
        )
        self.hybrid_search_var = tk.StringVar(
            value="on" if self.settings.get("hybrid_search", True) else "off"
        )
        self.hybrid_switch = CTkSwitch(
            advanced_frame,
            text="",
            variable=self.hybrid_search_var,
            onvalue="on",
            offvalue="off",
        )
        self.hybrid_switch.grid(row=0, column=1, padx=10, pady=5)

        # Window Expansion
        CTkLabel(advanced_frame, text="Window Expansion (chunks):").grid(
            row=1, column=0, sticky="w", pady=5
        )
        self.retrieval_window_entry = CTkEntry(advanced_frame, width=100)
        self.retrieval_window_entry.grid(row=1, column=1, padx=10, pady=5)

        # Reranking toggle
        CTkLabel(advanced_frame, text="Cross-Encoder Reranking:").grid(
            row=2, column=0, sticky="w", pady=5
        )
        self.reranking_var = tk.StringVar(
            value="on" if self.settings.get("reranking_enabled", False) else "off"
        )
        self.reranking_switch = CTkSwitch(
            advanced_frame,
            text="",
            variable=self.reranking_var,
            onvalue="on",
            offvalue="off",
        )
        self.reranking_switch.grid(row=2, column=1, padx=10, pady=5)

        # Buttons
        button_frame = CTkFrame(main_frame)
        button_frame.pack(fill="x", pady=(20, 0))

        _make_button(button_frame, "Cancel", self.destroy,
                   fg_color="#444444", hover_color="#555555", text_color="white", border_width=1).pack(
            side="right", padx=5
        )
        _make_button(button_frame, "Save", self._save,
                   fg_color="#1a73e8", hover_color="#1557b0", text_color="white").pack(
            side="right", padx=5
        )

    def _browse_model(self):
        path = filedialog.askopenfilename(
            title="Select GGUF Model File", filetypes=[("GGUF files", "*.gguf")]
        )
        if path:
            self.model_path_entry.delete(0, "end")
            self.model_path_entry.insert(0, path)

    def _populate_fields(self):
        gguf = self.settings.get("gguf_path") or self.settings.get("model_path", "")
        self.model_path_entry.insert(0, gguf)
        self.chunk_size_entry.insert(0, str(self.settings.get("chunk_size", DEFAULT_CHUNK_SIZE)))
        self.n_results_entry.insert(0, str(self.settings.get("n_results", 3)))
        self.max_tokens_entry.insert(0, str(self.settings.get("max_tokens", DEFAULT_MAX_TOKENS)))
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
            n_results = int(self.n_results_entry.get() or 3)
            if not (1 <= n_results <= 20):
                errors.append(f"Results to Retrieve must be between 1 and 20")
        except ValueError:
            errors.append("Results to Retrieve must be a valid integer")

        try:
            max_tokens = int(self.max_tokens_entry.get() or DEFAULT_MAX_TOKENS)
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
        self.after(50, self._load_settings_and_init)

    def _load_settings_and_init(self):
        """Load settings and initialize widgets (deferred to allow first render)."""
        self.settings = self._load_settings()
        self._create_widgets()
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
            "n_results": 3,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "temperature": 0.3,
            "db_path": str(Path(settings_path).parent / "doc_qa_db"),
        }

        try:
            if os.path.exists(settings_path):
                with open(settings_path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                    # Backward compatibility: migrate old "model_path" to "gguf_path"
                    if "model_path" in saved and not saved.get("gguf_path"):
                        saved["gguf_path"] = saved.pop("model_path")
                    default_settings.update(saved)
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
        top_bar.pack(fill="x", padx=10, pady=5)

        CTkLabel(top_bar, text=self.APP_NAME, font=(FONT_FAMILY, 20, "bold")).pack(side="left")

        _make_button(top_bar, "⚙ Settings", self._open_settings, width=100).pack(
            side="right", padx=5
        )
        _make_button(top_bar, "📁 Ingest", self._ingest_documents, width=100).pack(
            side="right", padx=5
        )

        # Status bar
        self.status_frame = CTkFrame(self)
        self.status_frame.pack(fill="x", padx=10, pady=5)

        self.status_label = CTkLabel(
            self.status_frame, text="Initializing...", font=(FONT_FAMILY, 12)
        )
        self.status_label.pack(side="left")

        # Create a middle frame to hold model label to prevent overlapping
        middle_frame = CTkFrame(self.status_frame)
        middle_frame.pack(side="left", expand=True, fill="x")
        self.model_label = CTkLabel(middle_frame, text="Model: None", font=(FONT_FAMILY, 12))
        self.model_label.pack(side="left", padx=20)

        self.doc_count_label = CTkLabel(
            self.status_frame, text="Documents: 0", font=(FONT_FAMILY, 12)
        )
        self.doc_count_label.pack(side="right")

        # Progress bar
        self.progress = CTkProgressBar(self)
        self.progress.pack(fill="x", padx=10, pady=5)
        self.progress.set(0)

        # Progress label - FR-705
        self.progress_label = CTkLabel(self, text="", font=(FONT_FAMILY, 11), text_color="gray")
        self.progress_label.pack(fill="x", padx=10, pady=(0, 5))

        self._thinking_animation_id = None
        self._is_operation_active = False

        # Chat area
        self.chat_frame = CTkScrollableFrame(self)
        self.chat_frame.pack(fill="both", expand=True, padx=10, pady=5)

        # Welcome message
        self._add_message(
            "system",
            f"Welcome to {self.APP_NAME}!\n\n"
            "1. Click 'Ingest' to add documents\n"
            "2. Ask questions about your documents below\n"
            "3. Use 'Settings' to configure the LLM backend",
        )

        # Input area
        input_frame = CTkFrame(self)
        input_frame.pack(fill="x", padx=10, pady=10)

        self.question_entry = CTkEntry(
            input_frame, placeholder_text="Ask a question about your documents..."
        )
        self.question_entry.pack(side="left", fill="x", expand=True, padx=(0, 10))

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
            width=80, fg_color="#1a73e8", hover_color="#1557b0", text_color="white"
        )
        self.ask_button.pack(side="right")

        # Clear button - FR-704b: store reference and add styling
        self.clear_button = _make_button(
            input_frame, text="Clear", command=self._confirm_clear_chat,
            width=60, fg_color="#444444", hover_color="#555555", text_color="white", border_width=1
        )
        self.clear_button.pack(side="right", padx=5)

    def _add_message(self, role: str, content: str, sources: list = None):
        """Add a message to the chat area."""
        msg_frame = CTkFrame(self.chat_frame)
        msg_frame.pack(fill="x", pady=5, padx=5)

        if role == "user":
            bg_color = "#2b5278"
            prefix = "You: "
        elif role == "assistant":
            bg_color = "#1a1a2e"
            prefix = "Assistant: "
        else:
            bg_color = "#2d2d2d"
            prefix = ""

        msg_frame.configure(fg_color=bg_color)

        text_label = CTkLabel(
            msg_frame,
            text=f"{prefix}{content}",
            wraplength=750,
            justify="left",
            anchor="w",
        )
        text_label.pack(fill="x", padx=10, pady=10)

        if sources:
            sources_text = "Sources: " + ", ".join(sources)
            sources_label = CTkLabel(
                msg_frame, text=sources_text, font=(FONT_FAMILY, 10), text_color="gray"
            )
            sources_label.pack(fill="x", padx=10, pady=(0, 5))

        self.chat_frame._parent_canvas.yview_moveto(1.0)

    def _do_clear_chat(self):
        """Clear the chat history - actual implementation."""
        for widget in self.chat_frame.winfo_children():
            widget.destroy()

    def _confirm_clear_chat(self):
        """Clear the chat history with user confirmation - FR-704a."""
        if messagebox.askyesno("Clear Chat", "Are you sure you want to clear the chat history?"):
            self._do_clear_chat()

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
                    elif msg[0] == "message":
                        if self.winfo_exists():
                            self._add_message(*msg[1:])
                    elif msg[0] == "doc_count":
                        if self.winfo_exists() and hasattr(self, "doc_count_label"):
                            self.doc_count_label.configure(text=f"Documents: {msg[1]}")
                    elif msg[0] == "enable_input":
                        if self.winfo_exists():
                            self._stop_thinking_animation()
                            if hasattr(self, "ask_button"):
                                self.ask_button.configure(state="normal")
                            if hasattr(self, "question_entry"):
                                self.question_entry.configure(state="normal")
            except queue.Empty:
                pass
            if self.winfo_exists():
                self.after(100, process)

        self.after(100, process)

    def _initialize_engine(self):
        """Initialize the RAG engine in a background thread."""

        def init():
            self._is_operation_active = True
            try:
                self.message_queue.put(("status", "Initializing RAG engine..."))
                self.message_queue.put(("progress", 20))
                self.message_queue.put(("progress_label", "20% — Initializing RAG engine..."))

                try:
                    self.engine = create_engine_from_settings(self.settings)
                except Exception as engine_error:
                    logger.error("Failed to initialize RAG engine: %s", engine_error)
                    self.message_queue.put(("status", "Engine initialization failed"))
                    self.message_queue.put((
                        "message", "system",
                        f"Failed to initialize RAG engine: {engine_error}\n\n"
                        "Please check:\n"
                        "1. GGUF model path is correct in Settings\n\n"
                        "Go to Settings to configure."
                    ))
                    self._is_operation_active = False
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
                self._is_operation_active = False

                # Clear progress label after 3 seconds - FR-705
                self.after(3000, lambda: self.message_queue.put(("progress_clear",)))

                # Update model label with GGUF file info
                gguf_path = self.settings.get("gguf_path", "")
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

            except Exception as e:
                self._is_operation_active = False
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(
                    (
                        "message",
                        "system",
                        f"Failed to initialize: {e}\n\nPlease check Settings.",
                    )
                )

        threading.Thread(target=init, daemon=True).start()

    def _start_thinking_animation(self):
        """Start animated ellipsis for thinking state — FR-706."""
        self._thinking_frames = ["Thinking.", "Thinking..", "Thinking..."]
        self._thinking_frame_idx = 0
        self._animate_thinking()

    def _animate_thinking(self):
        """Cycle through thinking animation frames."""
        if not self.winfo_exists():
            return
        frame = self._thinking_frames[self._thinking_frame_idx % len(self._thinking_frames)]
        self.status_label.configure(text=frame)
        self._thinking_frame_idx += 1
        self._thinking_animation_id = self.after(500, self._animate_thinking)

    def _stop_thinking_animation(self):
        """Stop the thinking animation — FR-706."""
        if self._thinking_animation_id is not None:
            self.after_cancel(self._thinking_animation_id)
            self._thinking_animation_id = None

    def _on_close(self):
        """Handle window close — FR-707: confirm before closing during active operations."""
        if self._is_operation_active:
            if not messagebox.askyesno(
                "Confirm Close",
                "An operation is still running. Are you sure you want to close?"
            ):
                return
        self._stop_thinking_animation()
        self.destroy()

    def _open_settings(self):
        """Open settings dialog."""
        dialog = SettingsDialog(self, self.settings)
        self.wait_window(dialog)

        if dialog.result:
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
                self._initialize_engine()

    def _ingest_documents(self):
        """Open directory picker and ingest documents."""
        directory = filedialog.askdirectory(title="Select Document Folder")
        if not directory:
            return

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True

        def ingest():
            try:

                def callback(msg, progress):
                    self.message_queue.put(("status", msg))
                    self.message_queue.put(("progress", progress))
                    self.message_queue.put(("progress_label", f"{progress}% — {msg}"))

                stats = self.engine.ingest_directory(directory, callback)

                if stats["success"]:
                    self.message_queue.put(
                        (
                            "message",
                            "system",
                            f"✓ Ingested {stats['documents']} documents "
                            f"({stats['chunks_added']} new chunks) "
                            f"in {stats['time_seconds']:.1f}s",
                        )
                    )
                    self.message_queue.put(
                        ("doc_count", self.engine.get_stats()["document_count"])
                    )
                    self.message_queue.put(("progress_clear",))
                    self._is_operation_active = False
                else:
                    self.message_queue.put(
                        (
                            "message",
                            "system",
                            f"⚠ {stats.get('message', 'Ingestion failed')}",
                        )
                    )

                    self.message_queue.put(("status", "Ready"))
                    self.message_queue.put(("enable_input", True))
                    self.message_queue.put(("progress_clear",))
                    self._is_operation_active = False

            except Exception as e:
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", _classify_error(e, "ingest")))
                self.message_queue.put(("enable_input", True))
                self._is_operation_active = False

        threading.Thread(target=ingest, daemon=True).start()

    def _ask_question(self):
        """Process a user question."""
        question = self.question_entry.get().strip()
        if not question:
            return

        if not self.engine:
            messagebox.showerror("Error", "Engine not initialized")
            return

        if not self.engine.llm:
            messagebox.showerror("Error", "No LLM backend available. Check Settings.")
            return

        self.question_entry.delete(0, "end")
        self._add_message("user", question)

        self.ask_button.configure(state="disabled")
        self.question_entry.configure(state="disabled")
        self._is_operation_active = True
        self._start_thinking_animation()

        def query():
            try:
                result = self.engine.query(
                    question, conversation_history=self.conversation_history
                )
                self.conversation_history.append({"role": "user", "content": question})
                self.conversation_history.append(
                    {"role": "assistant", "content": result.answer}
                )
                self.conversation_history = self.conversation_history[-20:]

                self.message_queue.put(
                    ("message", "assistant", result.answer, result.sources)
                )
                self.message_queue.put(
                    ("status", f"Ready ({result.inference_time:.1f}s)")
                )
                self.message_queue.put(("enable_input", True))
                self._is_operation_active = False

            except Exception as e:
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", _classify_error(e, "query")))
                self.message_queue.put(("enable_input", True))
                self._is_operation_active = False

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
