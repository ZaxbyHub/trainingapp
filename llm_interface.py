"""
LLM Interface Module
Provides unified interface for LLM inference with automatic hardware detection.
Supports OpenVINO (NPU/CPU/GPU), Ollama, and OpenAI-compatible APIs.
"""

import os
import re
import json

from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from abc import ABC, abstractmethod
from pathlib import Path


@dataclass
class InferenceConfig:
    """Configuration for LLM inference."""
    temperature: float = 0.7
    max_tokens: int = 512
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
            raise ImportError("openvino-genai not installed. Run: pip install openvino-genai")
        
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
            stop_sequences=config.stop_sequences
        )
        
        return response
    
    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "OpenVINO",
            "model": self.model_path.name,
            "device": self.device,
            "model_path": str(self.model_path)
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
    
    def __init__(self, gguf_path: str, n_ctx: int = 4096, n_threads: Optional[int] = None, verbose: bool = False):
        # Lazy import to avoid ImportError if not installed
        try:
            from llama_cpp import Llama
        except ImportError:
            raise ImportError("llama-cpp-python not installed. Run: pip install llama-cpp-python")
        
        self.model_path = Path(gguf_path)
        if not self.model_path.exists():
            raise FileNotFoundError(f"GGUF model path not found: {gguf_path}")
        
        if not self.model_path.is_file():
            raise ValueError(f"Invalid GGUF file: {gguf_path}. Path must be a file, not a directory.")
        
        # Validate GGUF magic bytes
        with open(self.model_path, "rb") as f:
            magic = f.read(4)
            if magic != b"GGUF":
                raise ValueError(f"Invalid GGUF file: {gguf_path}. File must start with GGUF magic bytes.")
        
        self.n_ctx = n_ctx
        # Ensure n_threads is always an integer (fallback to 1 if os.cpu_count() returns None)
        self.n_threads = n_threads or (os.cpu_count() or 1)
        self.verbose = verbose
        
        # Initialize the Llama model
        self.llama = Llama(
            model_path=str(self.model_path),
            n_ctx=self.n_ctx,
            n_threads=self.n_threads,
            verbose=self.verbose
        )

        # Detect Qwen3 model for /no_think suppression and chat template use
        self.is_qwen3 = 'qwen3' in self.model_path.name.lower()
        if self.is_qwen3:
            print("[OK] Qwen3 model detected — thinking mode suppressed via /no_think")
    
    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using GGUF model."""
        config = config or InferenceConfig()
        
        # Call the llama model with the provided parameters
        result = self.llama(
            prompt,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            top_p=config.top_p,
            repeat_penalty=1.1,
            stop=None
        )
        
        # Return the generated text - llama-cpp-python returns a dict with 'choices' key
        choices = result.get("choices") or []
        if not choices:
            raise RuntimeError("GGUF backend returned no choices")
        return choices[0].get("text", "")

    def chat_complete(self, system_prompt: str, user_prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using chat completion API (applies model chat template).

        For Qwen3 models, prepends /no_think to the system prompt to suppress
        thinking mode, preventing token overhead.
        """
        config = config or InferenceConfig()

        effective_system = f"/no_think\n{system_prompt}" if self.is_qwen3 else system_prompt

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
        raw = choices[0].get("message", {}).get("content", "")
        # Strip think-tag blocks that Qwen3 may emit despite /no_think
        cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        return cleaned

    def get_info(self) -> Dict[str, Any]:
        """Get information about the GGUF model and settings."""
        return {
            "backend": "GGUF",
            "model": self.model_path.name,
            "n_ctx": self.n_ctx,
            "n_threads": self.n_threads
        }


class OllamaLLM(BaseLLM):
    """LLM using Ollama API."""
    
    def __init__(self, model_name: str = "phi3:mini", base_url: str = "http://localhost:11434"):
        self.model_name = model_name
        self.base_url = base_url.rstrip('/')
        self._verify_connection()
    
    def _verify_connection(self):
        """Verify Ollama is accessible."""
        import urllib.request
        import urllib.error
        
        try:
            req = urllib.request.Request(f"{self.base_url}/api/tags")
            with urllib.request.urlopen(req, timeout=5) as response:
                data = json.loads(response.read().decode())
                models = [m['name'] for m in data.get('models', [])]
                print(f"[OK] Ollama connected. Models: {len(models)}")
        except Exception as e:
            raise ConnectionError(f"Cannot connect to Ollama at {self.base_url}: {e}")
    
    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using Ollama."""
        import urllib.request
        
        config = config or InferenceConfig()
        
        payload = {
            "model": self.model_name,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": config.temperature,
                "top_p": config.top_p,
                "num_predict": config.max_tokens
            }
        }
        
        req = urllib.request.Request(
            f"{self.base_url}/api/generate",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}
        )
        
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.loads(response.read().decode())
            return data.get("response", "")
    
    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "Ollama",
            "model": self.model_name,
            "base_url": self.base_url
        }


class OpenAICompatibleLLM(BaseLLM):
    """LLM using OpenAI-compatible API (works with local servers)."""
    
    def __init__(self, base_url: str, model_name: str = "default", api_key: str = "not-required"):
        self.base_url = base_url.rstrip('/')
        self.model_name = model_name
        self.api_key = api_key
        print(f"[OK] OpenAI-compatible endpoint: {self.base_url}")
    
    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate response using OpenAI-compatible API."""
        import urllib.request
        
        config = config or InferenceConfig()
        
        payload = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "top_p": config.top_p
        }
        
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}"
            }
        )
        
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.loads(response.read().decode())
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError("OpenAI-compatible API returned no choices")
            return choices[0].get("message", {}).get("content", "")
    
    def get_info(self) -> Dict[str, Any]:
        return {
            "backend": "OpenAI-compatible",
            "model": self.model_name,
            "base_url": self.base_url
        }


class RAGPromptBuilder:
    """Builds prompts for RAG-based question answering."""
    
    SYSTEM_PROMPT = (
        "You are a precise document assistant. "
        "Answer using ONLY the context supplied. "
        "If the context lacks the answer, respond exactly: "
        "\"I don't have enough information to answer that question based on the available documents.\" "
        "Rules: no speculation. Provide a comprehensive answer — include all relevant steps, sub-steps, and details present in the context. Do not truncate or summarise when the context contains full detail. "
        "Cite the source filename at the end of your answer in brackets, e.g. [report.pdf]."
    )

    @staticmethod
    def build_prompt(question: str, context: str, sources: list) -> str:
        """Build a RAG prompt with context."""
        prompt = f"""{RAGPromptBuilder.SYSTEM_PROMPT}

Context from documents:
{context}

Sources: {', '.join(sources)}

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
        gguf_verbose: bool = False
    ):
        self.backend: Optional[BaseLLM] = None
        self.prompt_builder = RAGPromptBuilder()
        
        if gguf_path and Path(gguf_path).exists():
            try:
                self.backend = GGUFBackend(
                    gguf_path=gguf_path,
                    n_ctx=gguf_n_ctx,
                    n_threads=gguf_n_threads,
                    verbose=gguf_verbose
                )
                return
            except Exception as e:
                print(f"[WARN] GGUF failed: {e}")
        
        if model_path and Path(model_path).exists():
            try:
                self.backend = OpenVINOLLM(model_path, device)
                return
            except Exception as e:
                print(f"[WARN] OpenVINO failed: {e}")
        
        if api_url:
            try:
                self.backend = OpenAICompatibleLLM(
                    base_url=api_url,
                    model_name=api_model or "default"
                )
                return
            except Exception as e:
                print(f"[WARN] API failed: {e}")
        
        if ollama_url or ollama_model:
            try:
                self.backend = OllamaLLM(
                    model_name=ollama_model or "phi3:mini",
                    base_url=ollama_url or "http://localhost:11434"
                )
                return
            except Exception as e:
                print(f"[WARN] Ollama failed: {e}")
        
        raise RuntimeError("No LLM backend available. Provide model_path, gguf_path, ollama settings, or api_url.")
    
    def generate(self, prompt: str, config: Optional[InferenceConfig] = None) -> str:
        """Generate a response."""
        return self.backend.generate(prompt, config)
    
    def answer_question(
        self,
        question: str,
        context: str,
        sources: list,
        config: Optional[InferenceConfig] = None,
        conversation_history: Optional[list] = None
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
            # Extract last user + last assistant messages (up to 2 turns)
            # Use .get("content", "") to avoid KeyError on malformed messages
            last_user = next(
                (m.get("content", "") for m in reversed(conversation_history) if isinstance(m, dict) and m.get("role") == "user"),
                None
            )
            last_assistant = next(
                (m.get("content", "") for m in reversed(conversation_history) if isinstance(m, dict) and m.get("role") == "assistant"),
                None
            )
            if last_user and last_assistant:
                # Truncate both to 300 chars to protect token budget
                user_snippet = last_user[:300]
                assistant_snippet = last_assistant[:300]
                history_prefix = (
                    f"Previous conversation:\n"
                    f"User: {user_snippet}\n"
                    f"Assistant: {assistant_snippet}\n\n"
                )

        if isinstance(self.backend, GGUFBackend):
            sources_str = ", ".join(sources) if sources else "unknown"
            user_prompt = (
                f"{history_prefix}"
                f"Context from documents:\n{context}\n\n"
                f"Sources: {sources_str}\n\n"
                f"Question: {question}"
            )
            return self.backend.chat_complete(
                system_prompt=RAGPromptBuilder.SYSTEM_PROMPT,
                user_prompt=user_prompt,
                config=config,
            )
        prompt = self.prompt_builder.build_prompt(question, context, sources)
        # Non-GGUF path: prepend history_prefix to the generated prompt
        if history_prefix:
            prompt = history_prefix + prompt
        return self.generate(prompt, config)
    
    def get_info(self) -> Dict[str, Any]:
        """Get backend information."""
        return self.backend.get_info()


if __name__ == "__main__":
    print("Testing LLM backends...\n")
    
    try:
        llm = SmartLLM(ollama_model="phi3:mini")
        print(f"\nBackend: {llm.get_info()}")
        
        response = llm.generate("What is 2+2? Answer briefly.")
        print(f"\nTest response: {response[:200]}...")
        
        context = "Python is a programming language created by Guido van Rossum in 1991."
        answer = llm.answer_question(
            question="Who created Python?",
            context=context,
            sources=["test.txt"]
        )
        print(f"\nRAG answer: {answer[:200]}...")
        
    except Exception as e:
        print(f"Error: {e}")
