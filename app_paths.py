"""
Centralized Windows path resolver for AFOMIS Help and Support.

This module provides unified path handling for both development and
PyInstaller-frozen environments, using platform-appropriate directory
structures on Windows.
"""

import os
from pathlib import Path


def get_user_data_dir() -> Path:
    """
    Get the user data directory: %LOCALAPPDATA%\AFOMIS Help and Support\

    Creates the directory if it doesn't exist.

    Returns:
        Path: The user data directory path
    """
    local_app_data = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    user_data_dir = Path(local_app_data) / "AFOMIS Help and Support"
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
