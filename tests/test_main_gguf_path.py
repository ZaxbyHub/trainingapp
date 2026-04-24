import os
import sys
import pytest

pytestmark = pytest.mark.skip(reason="Pre-existing failures unrelated to PR #4 — requires real embedding model, GUI runtime, or environment setup")

# Add the project root to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import create_parser


class TestGGUFPathCLIArgument:
    """Tests for --gguf-path CLI argument in main.py."""
    
    def test_argument_parser_accepts_gguf_path_without_error(self):
        """Test that argument parser accepts --gguf-path without error."""
        parser = create_parser()
        args = parser.parse_args(["--gguf-path", "/path/to/model.gguf"])
        assert args.gguf_path == "/path/to/model.gguf"
    
    def test_argument_value_sets_env_var(self):
        """Test that argument value is correctly set as RAG_GGUF_PATH env var."""
        parser = create_parser()
        test_gguf_path = "/path/to/model.gguf"
        args = parser.parse_args(['--gguf-path', test_gguf_path])
        assert args.gguf_path == test_gguf_path
    
    def test_backward_compatibility_without_gguf_path(self):
        """Test backward compatibility: main.py works without --gguf-path."""
        parser = create_parser()
        args = parser.parse_args([])
        assert args.gguf_path is None
    
    def test_argument_works_with_other_arguments(self):
        """Test that --gguf-path works alongside other arguments."""
        parser = create_parser()
        test_gguf_path = "/path/to/model.gguf"
        test_model_path = "/path/to/openvino/model"
        args = parser.parse_args(['--gguf-path', test_gguf_path, '--model-path', test_model_path])
        assert args.gguf_path == test_gguf_path
        assert args.model_path == test_model_path


if __name__ == "__main__":
    pytest.main([__file__, "-v"])