"""
Centralized Windows path resolver for Document Q&A Assistant.

This module provides unified path handling for both development and
PyInstaller-frozen environments, using platform-appropriate directory
structures on Windows.

Supports PyInstaller frozen mode via _MEIPASS for resource access.
"""

import os
import sys
from pathlib import Path
from typing import Optional


def is_frozen() -> bool:
    """Check if running in PyInstaller frozen environment."""
    return getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')


def get_resource_path(relative_path: str) -> Path:
    """
    Get path to resource, works for both dev and PyInstaller.
    
    In frozen mode, resources are in _MEIPASS.
    In dev mode, resources are relative to script location.
    
    Args:
        relative_path: Path relative to script or resource directory
        
    Returns:
        Path: The absolute path to the resource
    """
    if is_frozen():
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = Path(sys._MEIPASS)
    else:
        # Running in normal Python environment
        base_path = Path(__file__).parent
    
    return base_path / relative_path


# Module-level cache for user data directory
_user_data_dir_cache: Optional[Path] = None


def get_user_data_dir() -> Path:
    """
    Get the user data directory: %%LOCALAPPDATA%%\Document Q&A Assistant\

    Creates the directory if it doesn't exist. Result is cached after first call.

    Returns:
        Path: The user data directory path
    """
    global _user_data_dir_cache
    if _user_data_dir_cache is None:
        local_app_data = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        _user_data_dir_cache = Path(local_app_data) / "Document Q&A Assistant"
        _user_data_dir_cache.mkdir(parents=True, exist_ok=True)
    return _user_data_dir_cache


def get_vector_db_path() -> Path:
    """
    Get the vector database path: <user_data>/data/vector_db

    Creates the directory if it doesn't exist.

    Returns:
        Path: The vector database directory path
    """
    user_data = get_user_data_dir()
    vector_db_dir = user_data / "data" / "vector_db"
    vector_db_dir.mkdir(parents=True, exist_ok=True)
    return vector_db_dir


def get_settings_path() -> Path:
    """
    Get the settings file path: <user_data>/settings.json

    Creates the directory if it doesn't exist.

    Returns:
        Path: The settings file path
    """
    user_data = get_user_data_dir()
    settings_file = user_data / "settings.json"
    return settings_file
