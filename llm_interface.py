"""
LLM Interface Module
Provides unified interface for LLM inference using GGUF models only.
"""

import os
import re
import json
import logging
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from abc import ABC, abstractmethod
from pathlib import Path

logger = logging.getLogger(__name__)

# Security constants
MAX_RESPONSE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_PROMPT_LENGTH = 16384  # 16K characters


def _sanitize_error(error_msg: str) -> str:
    """Remove sensitive information from error messages.

    Strips out:
    - File paths
    - URLs with credentials
    - Stack traces
    - Internal exception details

    Returns a generic user-friendly message.
    """
    # Remove file paths (common pattern: /path/to/file or C:\path\to\file)
    sanitized = re.sub(r"\b[a-zA-Z]:\\[^\s]*|/[^\s]*", "[PATH]", error_msg)
    # Remove URLs with credentials (http://user:pass@host)
    sanitized = re.sub(r"https?://[^\s]*:[^\s@]*@", "https://[REDACTED]@", sanitized)
    # Remove Authorization headers if present
    sanitized = re.sub(
        r"Authorization: [^\n\r]*", "Authorization: [REDACTED]", sanitized
    )
    # Remove API keys (common patterns: key=xxx, token=xxx)
    sanitized = re.sub(
        r"(key|token|secret|password)=[^\s,&]*",
        r"\1=[REDACTED]",
        sanitized,
        flags=re.IGNORECASE,
    )

    # If message becomes empty or too short, return generic message
    if len(sanitized) < 10:
        return "An error occurred while processing the request."

    return sanitized[:500]  # truncate long messages


@dataclass
class InferenceConfig:
    """Configuration for LLM inference."""

    temperature: float = 0.7
    max_tokens: int = 1024
    top_p: float = 0.9
    stop_sequences: Optional[List[str]] = None


class BaseLLM(ABC):
    """Abstract base class for LLM backends."""

    @abstractmethod
    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response for a prompt."""
        pass

    @abstractmethod
    def get_info(self) -> Dict[str, Any]:
        """Get information about the model and device."""
        pass


class GGUFBackend(BaseLLM):
    """LLM backend using GGUF models with llama-cpp-python.

    This backend enables offline inference using GGUF format models,
    which are compatible with llama-cpp-python. The GGUF format is
    validated by checking the magic bytes (first 4 bytes must be b'GGUF').

    Example:
        from llm_interface import GGUFBackend
        backend = GGUFBackend("path/to/model.gguf")
        response = backend.generate("Hello, world!")

    Note: Prompts are assumed to be trusted input (no sanitization needed
    for offline use).
    """

    def __init__(
        self,
        gguf_path: str,
        n_ctx: int = 4096,
        n_threads: Optional[int] = None,
        verbose: bool = False,
    ):
        # Lazy import to avoid ImportError if not installed
        try:
            from llama_cpp import Llama
        except ImportError:
            raise ImportError(
                "llama-cpp-python not installed. Run: pip install llama-cpp-python"
            )

        self.model_path = Path(gguf_path)
        if not self.model_path.exists():
            raise FileNotFoundError(f"GGUF model path not found: {gguf_path}")

        if not self.model_path.is_file():
            raise ValueError(
                f"Invalid GGUF file: {gguf_path}. Path must be a file, not a directory."
            )

        # Validate GGUF magic bytes
        with open(self.model_path, "rb") as f:
            magic = f.read(4)
            if magic != b"GGUF":
                raise ValueError(
                    f"Invalid GGUF file: {gguf_path}. File must start with GGUF magic bytes."
                )

        self.n_ctx = n_ctx
        # Ensure n_threads is always an integer (fallback to 1 if os.cpu_count() returns None)
        self.n_threads = n_threads or (os.cpu_count() or 1)
        self.verbose = verbose

        # Initialize the Llama model
        self.llama = Llama(
            model_path=str(self.model_path),
            n_ctx=self.n_ctx,
            n_threads=self.n_threads,
            verbose=self.verbose,
        )

        # Detect Qwen3 model for /no_think suppression and chat template use
        self.is_qwen3 = "qwen3" in self.model_path.name.lower()
        if self.is_qwen3:
            logger.info("[OK] Qwen3 model detected — thinking mode suppressed via /no_think")

        # Detect Gemma 4 model for <|think|> stop token suppression
        self.is_gemma4 = "gemma-4" in self.model_path.name.lower() or "gemma_4" in self.model_path.name.lower()
        if self.is_gemma4:
            logger.info("[OK] Gemma 4 model detected — thinking mode suppressed via stop token")

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using GGUF model."""
        try:
            # Prompt length validation
            if len(prompt) > MAX_PROMPT_LENGTH:
                raise ValueError(
                    f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                    f"Provided: {len(prompt)}"
                )

            config = config or InferenceConfig()

            stop = ["<|think|>"] if self.is_gemma4 else None

            # Call the llama model with the provided parameters
            result = self.llama(
                prompt,
                max_tokens=config.max_tokens,
                temperature=config.temperature,
                top_p=config.top_p,
                repeat_penalty=1.1,
                stop=stop,
            )

            # Return the generated text - llama-cpp-python returns a dict with 'choices' key
            choices = result.get("choices") or []
            if not choices:
                raise RuntimeError("GGUF backend returned no choices")
            return choices[0].get("text", "")
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise RuntimeError(f"GGUF backend failed: {sanitized}")

    def chat_complete(
        self,
        system_prompt: str,
        user_prompt: str,
        config: Optional[InferenceConfig] = None,
    ) -> str:
        """Generate response using chat completion API (applies model chat template.

        For Qwen3 models, prepends /no_think to the system prompt to suppress
        thinking mode, preventing token overhead.
        """
        try:
            # Prompt length validation
            combined_prompt = system_prompt + user_prompt
            if len(combined_prompt) > MAX_PROMPT_LENGTH:
                raise ValueError(
                    f"Combined prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                    f"Provided: {len(combined_prompt)}"
                )

            config = config or InferenceConfig()

            effective_system = (
                f"/no_think\n{system_prompt}" if self.is_qwen3 else system_prompt
            )

            messages = [
                {"role": "system", "content": effective_system},
                {"role": "user", "content": user_prompt},
            ]

            stop = ["<|think|>"] if self.is_gemma4 else None

            response = self.llama.create_chat_completion(
                messages=messages,
                max_tokens=config.max_tokens,
                temperature=config.temperature,
                top_p=config.top_p,
                repeat_penalty=1.1,
                stop=stop,
            )

            choices = response.get("choices") or []
            if not choices:
                raise RuntimeError("GGUF chat backend returned no choices")
            message = choices[0].get("message") or {}
            raw = message.get("content", "") or ""
            # Strip think-tag blocks that Qwen3 may emit despite /no_think
            cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            return cleaned
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise RuntimeError(f"GGUF backend failed: {sanitized}")

    def get_info(self) -> Dict[str, Any]:
        """Get information about the GGUF model and settings."""
        return {
            "backend": "GGUF",
            "model": self.model_path.name,
            "n_ctx": self.n_ctx,
            "n_threads": self.n_threads,
            "is_gemma4": self.is_gemma4,
        }


class RAGPromptBuilder:
    """Builds prompts for RAG-based question answering."""

    SYSTEM_PROMPT = (
        "You are a precise document assistant. "
        "Answer using ONLY the context supplied. "
        "If the context lacks the answer, respond exactly: "
        '"I don\'t have enough information to answer that question based on the available documents." '
        "Rules: "
        "(1) No speculation. "
        "(2) Include all relevant steps and details from the context — do not truncate. "
        "(3) If multiple documents contain conflicting information, present all perspectives. "
        "(4) Cite the source filename in brackets after relevant statements, e.g. [report.pdf]. "
        "(5) Use bullet points for multi-step or enumerated answers."
    )

    @staticmethod
    def build_prompt(question: str, context: str, sources: list) -> str:
        """Build a RAG prompt with context."""
        prompt = f"""{RAGPromptBuilder.SYSTEM_PROMPT}

Context from documents:
{context}

Sources: {", ".join(sources)}

Question: {question}

Answer:"""
        return prompt


class SmartLLM:
    """
    Unified LLM interface using GGUF backend only.
    """

    def __init__(
        self,
        gguf_path: Optional[str] = None,
        gguf_n_ctx: int = 8192,
        gguf_n_threads: Optional[int] = None,
        gguf_verbose: bool = False,
    ):
        self.backend: GGUFBackend = None
        self.prompt_builder = RAGPromptBuilder()

        if gguf_path and Path(gguf_path).exists():
            try:
                self.backend = GGUFBackend(
                    gguf_path=gguf_path,
                    n_ctx=gguf_n_ctx,
                    n_threads=gguf_n_threads,
                    verbose=gguf_verbose,
                )
            except Exception as e:
                logger.warning("GGUF backend initialization failed: %s", e)

        if not self.backend:
            raise RuntimeError("No GGUF backend available. Provide a valid gguf_path.")

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate a response using the GGUF backend."""
        # API-006: Prompt validation - max length
        if len(prompt) > MAX_PROMPT_LENGTH:
            raise ValueError(
                f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                f"Provided: {len(prompt)}"
            )

        return self.backend.generate(prompt, config)

    def answer_question(
        self,
        question: str,
        context: str,
        sources: list,
        config: Optional[InferenceConfig] = None,
        conversation_history: Optional[list] = None,
    ) -> str:
        """Answer a question using RAG context.

        GGUF backend uses the chat completion API (applies model chat template
        and suppresses Qwen3 thinking mode).

        Args:
            question: The user's question.
            context: Retrieved document context.
            sources: List of source filenames.
            config: Inference configuration (max_tokens, temperature, etc.).
            conversation_history: Optional list of prior turns as
                [{"role": "user"/"assistant", "content": "..."}].
                Last 2 turns are prepended to the prompt to support follow-up queries.
        """
        history_prefix = ""
        if conversation_history:
            history_parts = []
            for msg in reversed(conversation_history):
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                content = msg.get("content", "")
                if role in ("user", "assistant") and content:
                    history_parts.append((role, content[:250]))
                    if len(history_parts) >= 4:  # Last 2 user + 2 assistant
                        break

            if len(history_parts) >= 2:
                history_parts.reverse()
                lines = []
                for role, content in history_parts:
                    label = "User" if role == "user" else "Assistant"
                    lines.append(f"{label}: {content[:100]}")
                history_prefix = "Previous conversation:\n" + "\n".join(lines) + "\n\n"

        # Build the base prompt once
        sources_str = ", ".join(sources) if sources else "unknown"
        base_user_prompt = (
            f"Context from documents:\n{context}\n\n"
            f"Sources: {sources_str}\n\n"
            f"Question: {question}"
        )

        # GGUF backend always uses chat_complete with history_prefix
        user_prompt = history_prefix + base_user_prompt
        try:
            return self.backend.chat_complete(
                system_prompt=RAGPromptBuilder.SYSTEM_PROMPT,
                user_prompt=user_prompt,
                config=config,
            )
        except Exception:
            # Fall back to generate() — no history_prefix since it was already in chat_complete
            prompt = self.prompt_builder.build_prompt(question, context, sources)
            return self.backend.generate(prompt, config)

    def get_info(self) -> Dict[str, Any]:
        """Get backend information."""
        return self.backend.get_info()


if __name__ == "__main__":
    logger.info("Testing GGUF backend...")

    try:
        llm = SmartLLM(gguf_path="models/gemma-4-E2B-it-Q5_K_M.gguf")
        logger.info("Backend: %s", llm.get_info())

        response = llm.generate("What is 2+2? Answer briefly.")
        logger.info("Test response: %s...", response[:200])

        context = (
            "Python is a programming language created by Guido van Rossum in 1991."
        )
        answer = llm.answer_question(
            question="Who created Python?", context=context, sources=["test.txt"]
        )
        logger.info("RAG answer: %s...", answer[:200])

    except Exception as e:
        logger.error("Error: %s", e)
