"""
Centralized Windows path resolver for AFOMIS Help and Support.

This module provides unified path handling for both development and
PyInstaller-frozen environments, using platform-appropriate directory
structures on Windows.
"""

import os
import sys
from pathlib import Path


def get_user_data_dir() -> Path:
    """
    Get the user data directory: %LOCALAPPDATA%\\AFOMIS Help and Support\\

    Creates the directory if it doesn't exist.

    Returns:
        Path: The user data directory path
    """
    local_app_data = os.environ.get('LOCALAPPDATA', os.path.expandvars('%LOCALAPPDATA%'))
    user_data_dir = Path(local_app_data) / 'AFOMIS Help and Support'
    user_data_dir.mkdir(parents=True, exist_ok=True)
    return user_data_dir


def get_vector_db_path() -> Path:
    """
    Get the vector database path: <user_data>/data/vector_db

    Creates the directory if it doesn't exist.

    Returns:
        Path: The vector database directory path
    """
    user_data = get_user_data_dir()
    vector_db_dir = user_data / 'data' / 'vector_db'
    vector_db_dir.mkdir(parents=True, exist_ok=True)
    return vector_db_dir


def get_conversations_db_path() -> Path:
    """
    Get the conversations database path: <user_data>/conversations.db

    Creates the directory if it doesn't exist.

    Returns:
        Path: The conversations database file path
    """
    user_data = get_user_data_dir()
    conversations_db = user_data / 'conversations.db'
    return conversations_db


def get_settings_path() -> Path:
    """
    Get the settings file path: <user_data>/settings.json

    Creates the directory if it doesn't exist.

    Returns:
        Path: The settings file path
    """
    user_data = get_user_data_dir()
    settings_file = user_data / 'settings.json'
    return settings_file


def get_seed_state_path() -> Path:
    """
    Get the seed state file path: <user_data>/seed_state.json

    Creates the directory if it doesn't exist.

    Returns:
        Path: The seed state file path
    """
    user_data = get_user_data_dir()
    seed_state_file = user_data / 'seed_state.json'
    return seed_state_file


def _get_base_dir() -> Path:
    """
    Get the base directory for the application.

    Uses sys._MEIPASS for PyInstaller-frozen executables,
    otherwise uses the directory containing this module.

    Returns:
        Path: The base directory path
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        # PyInstaller frozen mode — use sys._MEIPASS
        meipass = Path(sys._MEIPASS)
        print(f"[DEBUG] Frozen mode: _MEIPASS={meipass}")
        print(f"[DEBUG] _MEIPASS exists: {meipass.exists()}")
        return meipass
    else:
        # Development mode — use the directory containing this module
        return Path(__file__).parent


def find_bundled_model(ext: str) -> Path | None:
    """
    Find a bundled model file by extension in the models/ directory.

    Scans the models/ directory relative to the application's base
    directory (using sys._MEIPASS for frozen apps).

    Args:
        ext: File extension (e.g., '.gguf', '.json')

    Returns:
        Path: The path to the found model file, or None if not found
    """
    base_dir = _get_base_dir()
    models_dir = base_dir / 'models'
    print(f"[DEBUG] find_bundled_model: base_dir={base_dir}")
    print(f"[DEBUG] find_bundled_model: models_dir={models_dir}")
    print(f"[DEBUG] find_bundled_model: models_dir exists: {models_dir.exists()}")

    if not models_dir.exists():
        return None

    # Find first file with the specified extension
    for model_file in models_dir.glob(f'*{ext}'):
        return model_file

    return None


# Convenience alias for compatibility with existing code
def get_app_dir() -> Path:
    """
    Get the application directory (user data directory).

    This is a convenience alias that returns the same as get_user_data_dir().

    Returns:
        Path: The user data directory path
    """
    return get_user_data_dir()
