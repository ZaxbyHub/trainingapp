"""
Regression tests for Defect 002: API Server GGUF Environment Variable

Defect: API server does not read RAG_GGUF_PATH environment variable
and therefore cannot initialize RAGEngine with a GGUF model via environment config.

Fix applied (lines 281, 334 in api_server.py):
- api_server.py lifespan reads RAG_GGUF_PATH from environment
- RAG_GGUF_PATH is passed to RAGEngine constructor
- Fallback behavior when env var not set works correctly
"""

import pytest
import os
from unittest.mock import Mock, patch, AsyncMock, MagicMock
import asyncio


def test_api_server_reads_rag_gguf_path_env_var():
    """
    Test that the API server lifespan reads RAG_GGUF_PATH from environment.

    The lifespan function in api_server.py checks for RAG_GGUF_PATH (line 281)
    and passes it to RAGEngine when creating the engine instance (line 334).

    Fix verified: Line 281 - gguf_path = os.environ.get("RAG_GGUF_PATH")
    """
    # Set up environment and mocks
    with patch.dict(
        os.environ, {"RAG_GGUF_PATH": "/models/api_model.gguf"}, clear=False
    ):
        with (
            patch("api_server.RAGEngine") as mock_engine,
            patch("api_server.RAGConfig") as mock_config,
            patch("api_server.validate_model_path", return_value=lambda x: x),
        ):
            from api_server import lifespan

            mock_app = Mock()

            # Execute the lifespan async context to run startup code
            async def run_lifespan():
                async with lifespan(mock_app):
                    pass

            asyncio.run(run_lifespan())

            # Verify RAGEngine was called with gguf_path from environment
            mock_engine.assert_called_once()
            call_kwargs = mock_engine.call_args.kwargs
            assert "gguf_path" in call_kwargs, (
                "RAGEngine should receive gguf_path parameter"
            )
            assert call_kwargs["gguf_path"] == "/models/api_model.gguf", (
                "gguf_path should match RAG_GGUF_PATH environment variable"
            )


def test_api_server_fallback_when_gguf_env_not_set():
    """
    Test that API server works correctly when RAG_GGUF_PATH is not set.

    The server gracefully handles the absence of RAG_GGUF_PATH
    and falls back to other model sources (ollama, api, etc.).

    Fix verified: gguf_path=None is passed to RAGEngine when env var not set
    """
    # Ensure RAG_GGUF_PATH is not set
    env_vars = dict(os.environ)
    env_vars.pop("RAG_GGUF_PATH", None)

    with patch.dict(os.environ, env_vars, clear=True):
        with (
            patch("api_server.RAGEngine") as mock_engine,
            patch("api_server.RAGConfig") as mock_config,
        ):
            from api_server import lifespan

            mock_app = Mock()

            # Execute the lifespan async context to run startup code
            async def run_lifespan():
                async with lifespan(mock_app):
                    pass

            asyncio.run(run_lifespan())

            # Verify RAGEngine was called
            mock_engine.assert_called_once()
            call_kwargs = mock_engine.call_args.kwargs

            # When RAG_GGUF_PATH is not set, gguf_path should be None or not present
            # The fix should ensure RAGEngine can be created without gguf_path
            gguf_value = call_kwargs.get("gguf_path")
            assert gguf_value is None, (
                "gguf_path should be None when RAG_GGUF_PATH is not set"
            )


def test_lifespan_gguf_path_validation():
    """
    Test that RAG_GGUF_PATH is validated if set.

    If RAG_GGUF_PATH is set, the path is validated using validate_model_path
    similar to how RAG_MODEL_PATH is validated (lines 283-288).

    Fix verified: Lines 283-288 validate gguf_path before passing to RAGEngine
    """
    with patch.dict(os.environ, {"RAG_GGUF_PATH": "/invalid/../path.gguf"}):
        with (
            patch("api_server.validate_model_path") as mock_validate,
            patch("api_server.RAGEngine"),
            patch("api_server.RAGConfig"),
        ):
            from api_server import lifespan

            mock_app = Mock()

            # Execute the lifespan async context to run startup code
            async def run_lifespan():
                async with lifespan(mock_app):
                    pass

            asyncio.run(run_lifespan())

            # Verify validate_model_path was called for RAG_GGUF_PATH
            mock_validate.assert_called_once()
            # The validated path should be the environment value
            call_args = mock_validate.call_args
            assert call_args[0][0] == "/invalid/../path.gguf", (
                "validate_model_path should be called with RAG_GGUF_PATH value"
            )


def test_create_engine_from_env_includes_gguf():
    """
    Test that create_engine_from_env in rag_engine.py properly handles RAG_GGUF_PATH.

    Fix applied in Phase 15.2: API server now correctly reads RAG_GGUF_PATH from environment.
    """
    import tempfile
    import shutil

    tmpdir = tempfile.mkdtemp()
    try:
        with patch.dict(
            os.environ,
            {"RAG_GGUF_PATH": "/models/from_env.gguf", "RAG_DB_PATH": tmpdir},
            clear=False,
        ):
            with (
                patch("rag_engine.VectorStore"),
                patch("rag_engine.DocumentProcessor"),
                patch("rag_engine.SmartLLM") as mock_llm,
            ):
                from rag_engine import create_engine_from_env

                engine = create_engine_from_env()

                # Verify SmartLLM was called with gguf_path
                mock_llm.assert_called_once()
                call_kwargs = mock_llm.call_args.kwargs

                assert "gguf_path" in call_kwargs, (
                    "SmartLLM should receive gguf_path from environment"
                )
                assert call_kwargs["gguf_path"] == "/models/from_env.gguf", (
                    "gguf_path should match RAG_GGUF_PATH environment variable"
                )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_api_server_env_var_priority():
    """
    Test priority of model source environment variables.

    Priority should be (highest to lowest):
    1. RAG_GGUF_PATH
    2. RAG_MODEL_PATH
    3. RAG_OLLAMA_MODEL
    4. RAG_API_URL

    Fix verified: RAG_GGUF_PATH is now read and passed to RAGEngine
    """
    with patch.dict(
        os.environ,
        {
            "RAG_GGUF_PATH": "/models/gguf_model.gguf",
            "RAG_MODEL_PATH": "/models/other_model",
            "RAG_OLLAMA_MODEL": "phi3:mini",
        },
        clear=False,
    ):
        with (
            patch("api_server.RAGEngine") as mock_engine,
            patch("api_server.RAGConfig") as mock_config,
            patch("api_server.validate_model_path", return_value=lambda x: x),
        ):
            from api_server import lifespan

            mock_app = Mock()

            # Execute the lifespan async context to run startup code
            async def run_lifespan():
                async with lifespan(mock_app):
                    pass

            asyncio.run(run_lifespan())

            # Verify RAGEngine was called
            mock_engine.assert_called_once()
            engine_kwargs = mock_engine.call_args.kwargs

            # When both RAG_GGUF_PATH and RAG_MODEL_PATH are set,
            # RAG_GGUF_PATH should take priority and be passed as gguf_path
            assert "gguf_path" in engine_kwargs, (
                "RAGEngine should receive gguf_path parameter"
            )
            assert engine_kwargs["gguf_path"] == "/models/gguf_model.gguf", (
                "gguf_path should be RAG_GGUF_PATH value (highest priority)"
            )


def test_api_server_environment_completeness():
    """
    Test that API server handles all relevant RAG_* environment variables.

    Expected env vars handled:
    - RAG_DB_PATH
    - RAG_CHUNK_SIZE
    - RAG_N_RESULTS
    - RAG_MAX_TOKENS
    - RAG_TEMPERATURE
    - RAG_MODEL_PATH
    - RAG_GGUF_PATH
    - RAG_OLLAMA_MODEL
    - RAG_OLLAMA_URL
    - RAG_API_URL
    - RAG_API_MODEL
    - RAG_DEVICE

    Fix applied in Phase 15.2: All environment variables including RAG_GGUF_PATH are now handled.
    """
    import tempfile
    import shutil

    tmpdir = tempfile.mkdtemp()
    try:
        # Set all expected environment variables with test values
        test_env = {
            "RAG_DB_PATH": tmpdir,
            "RAG_CHUNK_SIZE": "256",
            "RAG_N_RESULTS": "5",
            "RAG_MAX_TOKENS": "1024",
            "RAG_TEMPERATURE": "0.5",
            "RAG_MODEL_PATH": "/models/model.gguf",
            "RAG_GGUF_PATH": "/models/gguf.gguf",
            "RAG_OLLAMA_MODEL": "test-model",
            "RAG_OLLAMA_URL": "http://localhost:11434",
            "RAG_API_URL": "http://api.test",
            "RAG_API_MODEL": "gpt-test",
            "RAG_DEVICE": "cpu",
        }
        with patch.dict(os.environ, test_env, clear=False):
            with (
                patch("api_server.RAGEngine") as mock_engine,
                patch("api_server.RAGConfig") as mock_config,
                patch("api_server.validate_model_path", return_value=lambda x: x),
            ):
                from api_server import lifespan

                mock_app = Mock()

                async def run_lifespan():
                    async with lifespan(mock_app):
                        pass

                asyncio.run(run_lifespan())

                # Verify RAGConfig called with correct parameters
                mock_config.assert_called_once()
                config_kwargs = mock_config.call_args.kwargs
                assert config_kwargs["db_path"] == tmpdir
                assert config_kwargs["chunk_size"] == 256
                assert config_kwargs["n_results"] == 5
                assert config_kwargs["max_tokens"] == 1024
                assert config_kwargs["temperature"] == 0.5
                assert config_kwargs["embedding_model"] == "BAAI/bge-small-en-v1.5"

                # Verify RAGEngine called with correct parameters
                mock_engine.assert_called_once()
                engine_kwargs = mock_engine.call_args.kwargs
                assert engine_kwargs["model_path"] == "/models/model.gguf"
                assert engine_kwargs["gguf_path"] == "/models/gguf.gguf"
                assert engine_kwargs["ollama_model"] == "test-model"
                assert engine_kwargs["ollama_url"] == "http://localhost:11434"
                assert engine_kwargs["api_url"] == "http://api.test"
                assert engine_kwargs["api_model"] == "gpt-test"
                assert engine_kwargs["device"] == "cpu"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
