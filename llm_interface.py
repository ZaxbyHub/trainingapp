"""
LLM Interface Module
Provides unified interface for LLM inference with automatic hardware detection.
Supports OpenVINO (NPU/CPU/GPU), Ollama, and OpenAI-compatible APIs.
"""

import os
import re
import json
import ipaddress
from urllib.parse import urljoin, urlparse

from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from abc import ABC, abstractmethod
from pathlib import Path

from security import validate_url

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


class OpenVINOLLM(BaseLLM):
    """LLM using OpenVINO GenAI for NPU/CPU/GPU inference."""

    def __init__(self, model_path: str, device: Optional[str] = None):
        try:
            from openvino_genai import LLMPipeline
        except ImportError:
            raise ImportError(
                "openvino-genai not installed. Run: pip install openvino-genai"
            )

        self.model_path = Path(model_path)
        if not self.model_path.exists():
            raise FileNotFoundError(f"Model path not found: {model_path}")

        self.device = device or self._detect_best_device()
        print(f"Initializing OpenVINO LLM on {self.device}...")

        self.pipeline = LLMPipeline(str(self.model_path), self.device)
        print(f"[OK] Model loaded: {self.model_path.name}")

    def _detect_best_device(self) -> str:
        """Auto-detect the best available device."""
        try:
            from openvino import Core

            core = Core()
            devices = core.available_devices

            if "NPU" in devices:
                print("  NPU detected")
                return "NPU"
            elif "GPU" in devices:
                print("  GPU detected")
                return "GPU"
            else:
                print("  Using CPU")
                return "CPU"
        except Exception:
            return "CPU"

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using OpenVINO."""
        config = config or InferenceConfig()

        response = self.pipeline.generate(
            prompt,
            max_new_tokens=config.max_tokens,
            temperature=config.temperature,
            top_p=config.top_p,
            stop_sequences=config.stop_sequences,
        )

        return response

    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "OpenVINO",
            "model": self.model_path.name,
            "device": self.device,
            "model_path": str(self.model_path),
        }


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
            print("[OK] Qwen3 model detected — thinking mode suppressed via /no_think")

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

            # Call the llama model with the provided parameters
            result = self.llama(
                prompt,
                max_tokens=config.max_tokens,
                temperature=config.temperature,
                top_p=config.top_p,
                repeat_penalty=1.1,
                stop=None,
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

            response = self.llama.create_chat_completion(
                messages=messages,
                max_tokens=config.max_tokens,
                temperature=config.temperature,
                top_p=config.top_p,
                repeat_penalty=1.1,
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
        }


class OllamaLLM(BaseLLM):
    """LLM using Ollama API."""

    def __init__(
        self, model_name: str = "phi3:mini", base_url: str = "http://localhost:11434"
    ):
        # Validate base_url for SSRF protection
        # Ollama runs locally, so we allow local URLs
        validate_url(base_url, allow_local=True)

        self.model_name = model_name
        self.base_url = base_url.rstrip("/")
        self._verify_connection()

    def _verify_connection(self):
        """Verify Ollama is accessible."""
        import urllib.request
        import urllib.error

        try:
            endpoint = urljoin(self.base_url, "/api/tags")
            req = urllib.request.Request(endpoint)
            with urllib.request.urlopen(req, timeout=5) as response:
                data = json.loads(response.read().decode())
                models = [m["name"] for m in data.get("models", [])]
                print(f"[OK] Ollama connected. Models: {len(models)}")
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise ConnectionError(
                f"Cannot connect to Ollama at {self.base_url}: {sanitized}"
            )

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using Ollama."""
        import urllib.request
        import urllib.error

        # API-006: Prompt validation - max length
        if len(prompt) > MAX_PROMPT_LENGTH:
            raise ValueError(
                f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                f"Provided: {len(prompt)}"
            )

        config = config or InferenceConfig()

        payload = {
            "model": self.model_name,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": config.temperature,
                "top_p": config.top_p,
                "num_predict": config.max_tokens,
            },
        }

        endpoint = urljoin(self.base_url, "/api/generate")
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                # API-004: JSON decoding safety - size limit before parsing
                content = response.read()
                if len(content) > MAX_RESPONSE_SIZE:
                    raise RuntimeError(
                        f"Response exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
                    )
                # Use charset from response if available, default to utf-8
                charset = response.headers.get_content_charset() or "utf-8"
                data = json.loads(content.decode(charset))
                return data.get("response", "")
        except urllib.error.HTTPError as e:
            # API-002: Sanitize error messages - don't leak sensitive details
            error_msg = e.read().decode("utf-8", errors="ignore") if e.fp else ""
            sanitized = _sanitize_error(error_msg)
            raise RuntimeError(
                f"Ollama returned HTTP {e.code}: {e.reason}. Details: {sanitized}"
            )
        except urllib.error.URLError:
            raise RuntimeError(
                f"Cannot connect to Ollama at {self.base_url}. Is Ollama running?"
            )
        except TimeoutError:
            raise RuntimeError("Request to Ollama timed out after 30 seconds")
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise RuntimeError(f"Ollama backend failed: {sanitized}")

    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "Ollama",
            "model": self.model_name,
            "base_url": self.base_url,
        }


class OpenAICompatibleLLM(BaseLLM):
    """LLM using OpenAI-compatible API (works with local servers)."""

    def __init__(
        self, base_url: str, model_name: str = "default", api_key: str = "not-required"
    ):
        # Validate base_url for SSRF protection
        validate_url(base_url)

        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.api_key = api_key
        self._verify_connection()

    def _verify_connection(self):
        """Verify the OpenAI-compatible API endpoint is accessible."""
        import urllib.request
        import urllib.error

        try:
            endpoint = urljoin(self.base_url, "/models")
            headers = {}
            if self.api_key and self.api_key != "not-required":
                headers["Authorization"] = f"Bearer {self.api_key}"
            req = urllib.request.Request(
                endpoint,
                headers=headers,
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                # Just check we can connect; don't need to parse response
                pass
            print(f"[OK] OpenAI-compatible API connected")
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise ConnectionError(
                f"Cannot connect to OpenAI-compatible API at {self.base_url}: {sanitized}"
            )

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using OpenAI-compatible API."""
        import urllib.request
        import urllib.error

        # API-006: Prompt validation - max length
        if len(prompt) > MAX_PROMPT_LENGTH:
            raise ValueError(
                f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                f"Provided: {len(prompt)}"
            )

        config = config or InferenceConfig()

        payload = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "top_p": config.top_p,
        }

        endpoint = urljoin(self.base_url, "/chat/completions")
        headers = {"Content-Type": "application/json"}
        if self.api_key and self.api_key != "not-required":
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers=headers,
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                # API-004: JSON decoding safety - size limit before parsing
                content = response.read()
                if len(content) > MAX_RESPONSE_SIZE:
                    raise RuntimeError(
                        f"Response exceeds maximum size of {MAX_RESPONSE_SIZE} bytes"
                    )
                # Use charset from response if available, default to utf-8
                charset = response.headers.get_content_charset() or "utf-8"
                data = json.loads(content.decode(charset))
                choices = data.get("choices") or []
                if not choices:
                    raise RuntimeError("OpenAI-compatible API returned no choices")
                message = choices[0].get("message") or {}
                return message.get("content", "")
        except urllib.error.HTTPError as e:
            # API-002: Sanitize error messages
            error_msg = e.read().decode("utf-8", errors="ignore") if e.fp else ""
            sanitized = _sanitize_error(error_msg)
            raise RuntimeError(
                f"OpenAI-compatible endpoint returned HTTP {e.code}: {e.reason}. Details: {sanitized}"
            )
        except urllib.error.URLError:
            raise RuntimeError(
                f"Cannot connect to OpenAI-compatible endpoint at {self.base_url}. Is the server running?"
            )
        except TimeoutError:
            raise RuntimeError(
                "Request to OpenAI-compatible endpoint timed out after 30 seconds"
            )
        except Exception as e:
            sanitized = _sanitize_error(str(e))
            raise RuntimeError(f"OpenAI-compatible backend failed: {sanitized}")

    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "OpenAI-compatible",
            "model": self.model_name,
            "base_url": self.base_url,
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
    Unified LLM interface with automatic backend selection.
    Tries OpenVINO first, then GGUF, then Ollama, then OpenAI-compatible API.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        ollama_model: Optional[str] = None,
        ollama_url: Optional[str] = None,
        api_url: Optional[str] = None,
        api_model: Optional[str] = None,
        device: Optional[str] = None,
        gguf_path: Optional[str] = None,
        gguf_n_ctx: int = 8192,
        gguf_n_threads: Optional[int] = None,
        gguf_verbose: bool = False,
    ):
        self.backends: List[BaseLLM] = []
        self.prompt_builder = RAGPromptBuilder()

        if gguf_path and Path(gguf_path).exists():
            try:
                backend = GGUFBackend(
                    gguf_path=gguf_path,
                    n_ctx=gguf_n_ctx,
                    n_threads=gguf_n_threads,
                    verbose=gguf_verbose,
                )
                self.backends.append(backend)
            except Exception as e:
                print(f"[WARN] GGUF failed: {e}")

        if model_path and Path(model_path).exists():
            try:
                backend = OpenVINOLLM(model_path, device)
                self.backends.append(backend)
            except Exception as e:
                print(f"[WARN] OpenVINO failed: {e}")

        if api_url:
            try:
                backend = OpenAICompatibleLLM(
                    base_url=api_url, model_name=api_model or "default"
                )
                self.backends.append(backend)
            except Exception as e:
                print(f"[WARN] API failed: {e}")

        if ollama_url or ollama_model:
            try:
                backend = OllamaLLM(
                    model_name=ollama_model or "phi3:mini",
                    base_url=ollama_url or "http://localhost:11434",
                )
                self.backends.append(backend)
            except Exception as e:
                print(f"[WARN] Ollama failed: {e}")

        if not self.backends:
            raise RuntimeError(
                "No LLM backend available. Provide model_path, gguf_path, ollama settings, or api_url."
            )

    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate a response with automatic fallback to next available backend if primary fails."""
        # API-006: Prompt validation - max length
        if len(prompt) > MAX_PROMPT_LENGTH:
            raise ValueError(
                f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH} characters. "
                f"Provided: {len(prompt)}"
            )

        errors = []
        for backend in self.backends:
            try:
                return backend.generate(prompt, config)
            except Exception as e:
                errors.append(f"{backend.get_info()['backend']}: {e}")
                continue
        raise RuntimeError(f"All LLM backends failed: {'; '.join(errors)}")

    def answer_question(
        self,
        question: str,
        context: str,
        sources: list,
        config: Optional[InferenceConfig] = None,
        conversation_history: Optional[list] = None,
    ) -> str:
        """Answer a question using RAG context.

        GGUF backends use the chat completion API (applies model chat template
        and suppresses Qwen3 thinking mode).  All other backends fall back to
        the plain-text prompt path.

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

        # Build the base prompt once (without history_prefix — that's per-backend)
        sources_str = ", ".join(sources) if sources else "unknown"
        base_user_prompt = (
            f"Context from documents:\n{context}\n\n"
            f"Sources: {sources_str}\n\n"
            f"Question: {question}"
        )

        # Track whether we've already prepended history_prefix during this call.
        # We only want to add it once — either to the first GGUF backend's
        # chat_complete user_prompt, or to the final generate() call.
        history_prefix_used = False

        for backend in self.backends:
            # GGUF backends: try chat_complete first (applies chat template).
            # If it fails, fall back to generate() on the SAME backend.
            if isinstance(backend, GGUFBackend):
                # chat_complete gets history_prefix (if not already used)
                user_prompt = (history_prefix if not history_prefix_used else "") + base_user_prompt
                history_prefix_used = True
                try:
                    return backend.chat_complete(
                        system_prompt=RAGPromptBuilder.SYSTEM_PROMPT,
                        user_prompt=user_prompt,
                        config=config,
                    )
                except Exception:
                    # Fall back to generate() on the same GGUF backend — no
                    # history_prefix here since it was already in the chat_complete prompt
                    try:
                        prompt = self.prompt_builder.build_prompt(question, context, sources)
                        return backend.generate(prompt, config)
                    except Exception:
                        # This GGUF backend fully failed; try next backend
                        continue

            # Non-GGUF backends: use generate() directly
            else:
                prompt = self.prompt_builder.build_prompt(question, context, sources)
                if history_prefix and not history_prefix_used:
                    prompt = history_prefix + prompt
                    history_prefix_used = True
                try:
                    return backend.generate(prompt, config)
                except Exception:
                    continue

        # All backends exhausted — last-resort generate() with history_prefix
        prompt = self.prompt_builder.build_prompt(question, context, sources)
        if history_prefix and not history_prefix_used:
            prompt = history_prefix + prompt
        return self.generate(prompt, config)

    def get_info(self) -> Dict[str, Any]:
        """Get backend information."""
        return self.backends[0].get_info()


if __name__ == "__main__":
    print("Testing LLM backends...\n")

    try:
        llm = SmartLLM(ollama_model="phi3:mini")
        print(f"\nBackend: {llm.get_info()}")

        response = llm.generate("What is 2+2? Answer briefly.")
        print(f"\nTest response: {response[:200]}...")

        context = (
            "Python is a programming language created by Guido van Rossum in 1991."
        )
        answer = llm.answer_question(
            question="Who created Python?", context=context, sources=["test.txt"]
        )
        print(f"\nRAG answer: {answer[:200]}...")

    except Exception as e:
        print(f"Error: {e}")
