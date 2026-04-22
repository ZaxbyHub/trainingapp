#!/usr/bin/env python3
"""
Developer CLI script to download the BGE embedding model for offline bundling.

Usage:
    python scripts/bundle_embedding_model.py [--local-dir PATH]

Arguments:
    --local-dir: Optional path to store the downloaded model. Defaults to
                 bundled_models/bge-small-en-v1.5
"""

import argparse
import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download


def validate_required_files(local_dir: Path) -> bool:
    """Validate that all required model files exist.

    Args:
        local_dir: Path to the downloaded model directory

    Returns:
        True if all required files exist, False otherwise
    """
    required_files = [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
    ]

    # Check for pytorch_model.bin or model.safetensors
    pytorch_file = local_dir / "pytorch_model.bin"
    safetensors_file = local_dir / "model.safetensors"
    if not (pytorch_file.exists() or safetensors_file.exists()):
        required_files.append("pytorch_model.bin OR model.safetensors")

    print(f"\nValidating required files in {local_dir}...")
    all_exist = True

    for file in required_files:
        file_path = local_dir / file
        if file_path.exists():
            print(f"  ✓ {file}")
        else:
            print(f"  ✗ {file} [MISSING]")
            all_exist = False

    return all_exist


def print_file_list(local_dir: Path) -> None:
    """Print all files in the downloaded directory with their sizes.

    Args:
        local_dir: Path to the downloaded model directory
    """
    print(f"\nListing files in {local_dir}...")
    total_size = 0

    for root, _, files in os.walk(local_dir):
        for file in files:
            file_path = Path(root) / file
            size = file_path.stat().st_size
            total_size += size
            print(f"  {file_path.relative_to(local_dir):50s} {size:>12,} bytes")

    # Convert to MB
    total_size_mb = total_size / (1024 * 1024)
    print(f"\nTotal size: {total_size_mb:>10,.2f} MB")


def main() -> int:
    """Main entry point for the script.

    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(
        description="Download BGE embedding model (bge-small-en-v1.5) for offline bundling"
    )
    parser.add_argument(
        "--local-dir",
        type=str,
        default="bundled_models/bge-small-en-v1.5",
        help="Path to store the downloaded model (default: bundled_models/bge-small-en-v1.5)",
    )

    args = parser.parse_args()

    # Parse local_dir argument
    local_dir = Path(args.local_dir)

    # Ensure parent directory exists
    local_dir.parent.mkdir(parents=True, exist_ok=True)

    print(f"Downloading BAAI/bge-small-en-v1.5 model to {local_dir}...")
    print("This may take a few minutes...\n")

    try:
        # Download the model using HuggingFace Hub
        snapshot_download(  # nosec: B410 — intentional, always download latest model version
            repo_id="BAAI/bge-small-en-v1.5",
            local_dir=str(local_dir),
            local_files_only=False,
        )

        print("\nDownload completed!")

        # Validate required files
        if not validate_required_files(local_dir):
            print("\n❌ Error: Required model files are missing!")
            return 1

        # Print file list and total size
        print_file_list(local_dir)

        print("\n✅ Model successfully bundled!")
        return 0

    except Exception as e:
        print(f"\n❌ Error during download: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
