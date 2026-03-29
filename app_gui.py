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

logger = logging.getLogger(__name__)


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

    def _create_widgets(self):
        # Main frame
        main_frame = CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)

        # LLM Settings
        CTkLabel(main_frame, text="LLM Settings", font=("", 16, "bold")).pack(
            pady=(0, 10)
        )

        # Model path
        CTkLabel(main_frame, text="GGUF Model Path:").pack(anchor="w")
        model_frame = CTkFrame(main_frame)
        model_frame.pack(fill="x", pady=(0, 10))
        self.model_path_entry = CTkEntry(model_frame, width=350)
        self.model_path_entry.pack(side="left", padx=(0, 5))
        CTkButton(
            model_frame, text="Browse", width=70, command=self._browse_model
        ).pack(side="left")

        # Ollama settings
        CTkLabel(main_frame, text="Ollama URL:").pack(anchor="w")
        self.ollama_url_entry = CTkEntry(main_frame, width=430)
        self.ollama_url_entry.pack(fill="x", pady=(0, 10))

        CTkLabel(main_frame, text="Ollama Model:").pack(anchor="w")
        self.ollama_model_entry = CTkEntry(main_frame, width=430)
        self.ollama_model_entry.pack(fill="x", pady=(0, 10))

        # API settings
        CTkLabel(main_frame, text="API URL (OpenAI-compatible):").pack(anchor="w")
        self.api_url_entry = CTkEntry(main_frame, width=430)
        self.api_url_entry.pack(fill="x", pady=(0, 10))

        # RAG Settings
        CTkLabel(main_frame, text="RAG Settings", font=("", 16, "bold")).pack(
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
        CTkLabel(main_frame, text="Advanced RAG Settings", font=("", 16, "bold")).pack(
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

        CTkButton(button_frame, text="Cancel", command=self.destroy).pack(
            side="right", padx=5
        )
        CTkButton(button_frame, text="Save", command=self._save).pack(
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
        self.ollama_url_entry.insert(
            0, self.settings.get("ollama_url", "http://localhost:11434")
        )
        self.ollama_model_entry.insert(
            0, self.settings.get("ollama_model", "phi3:mini")
        )
        self.api_url_entry.insert(0, self.settings.get("api_url", ""))
        self.chunk_size_entry.insert(0, str(self.settings.get("chunk_size", 512)))
        self.n_results_entry.insert(0, str(self.settings.get("n_results", 3)))
        self.max_tokens_entry.insert(0, str(self.settings.get("max_tokens", 1024)))
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
            chunk_size = int(self.chunk_size_entry.get() or 512)
            if not (128 <= chunk_size <= 2048):
                errors.append(f"Chunk Size must be between 128 and 2048")
        except ValueError:
            errors.append("Chunk Size must be a valid integer")

        try:
            n_results = int(self.n_results_entry.get() or 3)
            if not (1 <= n_results <= 20):
                errors.append(f"Results to Retrieve must be between 1 and 20")
        except ValueError:
            errors.append("Results to Retrieve must be a valid integer")

        try:
            max_tokens = int(self.max_tokens_entry.get() or 1024)
            if not (256 <= max_tokens <= 4096):
                errors.append(f"Max Tokens must be between 256 and 4096")
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
            "ollama_url": self.ollama_url_entry.get(),
            "ollama_model": self.ollama_model_entry.get(),
            "api_url": self.api_url_entry.get(),
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
    VERSION = "1.0.0"
    SETTINGS_FILE = "app_settings.json"

    def __init__(self):
        super().__init__()

        self.title(self.APP_NAME)
        self.geometry("900x700")
        self.minsize(700, 500)

        ctk.set_appearance_mode("system")
        ctk.set_default_color_theme("blue")

        self.settings = self._load_settings()
        self.engine = None
        self.conversation_history = []
        self.message_queue = queue.Queue()

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
                Path("models") / "phi3-mini-int4.gguf",
                Path("models") / "phi3.5-mini-instruct-int4-cw-ov",
                Path("test_model.gguf"),
            ]
            for model_file in bundled_models:
                if model_file.is_file():
                    bundled_model = str(model_file)
                    print(f"[INFO] Using bundled model: {model_file}")
                    break

        default_settings = {
            "gguf_path": bundled_model,
            "ollama_url": "http://localhost:11434",
            "ollama_model": "phi3:mini",
            "api_url": "",
            "chunk_size": 512,
            "n_results": 3,
            "max_tokens": 1024,
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

        CTkLabel(top_bar, text=self.APP_NAME, font=("", 20, "bold")).pack(side="left")

        CTkButton(
            top_bar, text="⚙ Settings", width=100, command=self._open_settings
        ).pack(side="right", padx=5)
        CTkButton(
            top_bar, text="📁 Ingest", width=100, command=self._ingest_documents
        ).pack(side="right", padx=5)

        # Status bar
        self.status_frame = CTkFrame(self)
        self.status_frame.pack(fill="x", padx=10, pady=5)

        self.status_label = CTkLabel(
            self.status_frame, text="Initializing...", font=("", 12)
        )
        self.status_label.pack(side="left")

        # Create a middle frame to hold model label to prevent overlapping
        middle_frame = CTkFrame(self.status_frame)
        middle_frame.pack(side="left", expand=True, fill="x")
        self.model_label = CTkLabel(middle_frame, text="Model: None", font=("", 12))
        self.model_label.pack(side="left", padx=20)

        self.doc_count_label = CTkLabel(
            self.status_frame, text="Documents: 0", font=("", 12)
        )
        self.doc_count_label.pack(side="right")

        # Progress bar
        self.progress = CTkProgressBar(self)
        self.progress.pack(fill="x", padx=10, pady=5)
        self.progress.set(0)

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
        self.question_entry.bind("<Return>", lambda e: self._ask_question())

        self.ask_button = CTkButton(
            input_frame, text="Ask", width=80, command=self._ask_question
        )
        self.ask_button.pack(side="right")

        # Clear button
        CTkButton(input_frame, text="Clear", width=60, command=self._clear_chat).pack(
            side="right", padx=5
        )

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
                msg_frame, text=sources_text, font=("", 10), text_color="gray"
            )
            sources_label.pack(fill="x", padx=10, pady=(0, 5))

        self.chat_frame._parent_canvas.yview_moveto(1.0)

    def _clear_chat(self):
        """Clear the chat history."""
        for widget in self.chat_frame.winfo_children():
            widget.destroy()

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
                    elif msg[0] == "message":
                        if self.winfo_exists():
                            self._add_message(*msg[1:])
                    elif msg[0] == "doc_count":
                        if self.winfo_exists() and hasattr(self, "doc_count_label"):
                            self.doc_count_label.configure(text=f"Documents: {msg[1]}")
                    elif msg[0] == "enable_input":
                        if self.winfo_exists():
                            if hasattr(self, "ask_button"):
                                self.ask_button.configure(state="normal")
                            if hasattr(self, "question_entry"):
                                self.question_entry.configure(state="normal")
            except queue.Empty:
                pass
            if self.winfo_exists():
                self.after(100, process)

        self.after(100, process)

        self.after(100, process)

    def _initialize_engine(self):
        """Initialize the RAG engine in a background thread."""

        def init():
            try:
                self.message_queue.put(("status", "Initializing RAG engine..."))
                self.message_queue.put(("progress", 20))

                from rag_engine import RAGEngine, RAGConfig

                config = RAGConfig(
                    db_path=self.settings["db_path"],
                    chunk_size=self.settings["chunk_size"],
                    n_results=self.settings["n_results"],
                    max_tokens=self.settings["max_tokens"],
                    temperature=self.settings["temperature"],
                )

                self.engine = RAGEngine(
                    config=config,
                    gguf_path=self.settings.get("gguf_path") or None,
                    ollama_model=self.settings.get("ollama_model"),
                    ollama_url=self.settings.get("ollama_url"),
                    api_url=self.settings.get("api_url") or None,
                )

                stats = self.engine.get_stats()
                doc_count = stats.get("document_count", 0)

                self.message_queue.put(("doc_count", doc_count))
                self.message_queue.put(("progress", 100))

                backend = "No LLM"
                if self.engine.llm:
                    backend = self.engine.llm.get_info()["backend"]

                self.message_queue.put(("status", f"Ready ({backend})"))
                self.message_queue.put(("enable_input", True))

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
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(
                    (
                        "message",
                        "system",
                        f"Failed to initialize: {e}\n\nPlease check Settings.",
                    )
                )

        threading.Thread(target=init, daemon=True).start()

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

        def ingest():
            try:

                def callback(msg, progress):
                    self.message_queue.put(("status", msg))
                    self.message_queue.put(("progress", progress))

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

            except Exception as e:
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", f"Ingestion failed: {e}"))
                self.message_queue.put(("enable_input", True))

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
        self.status_label.configure(text="Thinking...")

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

            except Exception as e:
                self.message_queue.put(("status", f"Error: {e}"))
                self.message_queue.put(("message", "system", f"Query failed: {e}"))
                self.message_queue.put(("enable_input", True))

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
