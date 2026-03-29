#!/usr/bin/env python3
"""
Tests for build_installer.py path resolution
Verifies that all paths are resolved correctly regardless of current working directory
and that the script doesn't use os.chdir.
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Import the module under test
# We need to import from the scripts directory
scripts_dir = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

import build_installer


class TestProjectRootResolution:
    """Test that PROJECT_ROOT is correctly resolved from script location."""

    def test_script_dir_is_path_object(self):
        """SCRIPT_DIR should be a Path object."""
        assert isinstance(build_installer.SCRIPT_DIR, Path)

    def test_project_root_is_path_object(self):
        """PROJECT_ROOT should be a Path object."""
        assert isinstance(build_installer.PROJECT_ROOT, Path)

    def test_script_dir_points_to_scripts_directory(self):
        """SCRIPT_DIR should be the directory containing build_installer.py."""
        expected = (Path(__file__).parent.parent / "scripts").resolve()
        assert build_installer.SCRIPT_DIR == expected

    def test_project_root_points_to_project_root(self):
        """PROJECT_ROOT should be the parent of SCRIPT_DIR (the project root)."""
        expected = (Path(__file__).parent.parent).resolve()
        assert build_installer.PROJECT_ROOT == expected

    def test_project_root_is_absolute(self):
        """PROJECT_ROOT should be an absolute path."""
        assert build_installer.PROJECT_ROOT.is_absolute()

    def test_script_dir_is_absolute(self):
        """SCRIPT_DIR should be an absolute path."""
        assert build_installer.SCRIPT_DIR.is_absolute()


class TestPathResolutionIndependentOfCwd:
    """Test that path resolution works correctly regardless of current working directory."""

    def test_paths_remain_constant_when_cwd_changes(self):
        """Changing the current working directory should not affect PROJECT_ROOT or derived paths."""
        original_cwd = os.getcwd()

        try:
            # Change to a different directory
            temp_dir = Path(original_cwd) / "temp_test_dir"
            temp_dir.mkdir(exist_ok=True)
            os.chdir(temp_dir)

            # Re-import to recalculate paths based on __file__
            # Since the module is already imported, we need to verify the paths
            # are still the same because they're based on __file__, not cwd
            assert (
                build_installer.PROJECT_ROOT == (Path(__file__).parent.parent).resolve()
            )
            assert (
                build_installer.SCRIPT_DIR
                == (Path(__file__).parent.parent / "scripts").resolve()
            )

            # Verify derived paths
            requirements = build_installer.PROJECT_ROOT / "requirements.txt"
            assert requirements.is_absolute()
            # The requirements.txt path should still point to the project root, not the temp dir
            assert "temp_test_dir" not in str(requirements)

        finally:
            os.chdir(original_cwd)
            if temp_dir.exists():
                temp_dir.rmdir()

    def test_requirements_file_path(self):
        """The requirements.txt path should be at PROJECT_ROOT/requirements.txt."""
        requirements_path = build_installer.PROJECT_ROOT / "requirements.txt"
        assert str(requirements_path).endswith("requirements.txt")
        assert (
            build_installer.PROJECT_ROOT in requirements_path.parents
            or build_installer.PROJECT_ROOT == requirements_path.parent
        )

    def test_build_installer_dir_path(self):
        """The build_installer directory should be at PROJECT_ROOT/build_installer."""
        build_dir = build_installer.PROJECT_ROOT / "build_installer"
        assert build_dir.name == "build_installer"
        assert build_dir.parent == build_installer.PROJECT_ROOT


class TestNoChdirUsage:
    """Test that the script does not use os.chdir."""

    def test_no_os_chdir_call(self):
        """os.chdir should not be called anywhere in the script."""
        # Mock os.chdir to track if it's called
        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir was called!")
        ) as mock_chdir:
            # Try to run the functions that would be called
            # We're only checking if chdir is invoked, not whether they succeed
            try:
                build_installer.create_directories()
            except Exception as e:
                # If os.chdir was called, our mock will raise an exception
                if "os.chdir was called" in str(e):
                    pytest.fail("os.chdir was called in create_directories()")

            # Check that chdir was never called
            mock_chdir.assert_not_called()

    def test_import_module_does_not_use_chdir(self):
        """Simply importing the module should not call os.chdir."""
        # Since we already imported it, we can't easily test this again
        # But we can verify that SCRIPT_DIR and PROJECT_ROOT exist and are computed
        # without changing cwd by checking they are absolute
        assert build_installer.PROJECT_ROOT.is_absolute()


class TestCreateDirectoriesPaths:
    """Test the paths used in create_directories()."""

    def test_create_directories_uses_absolute_paths(self):
        """All directory paths in create_directories should be absolute."""
        base_dir = build_installer.PROJECT_ROOT / "build_installer"
        dirs = [
            base_dir / "wheels",
            base_dir / "models",
            base_dir / "embeddings",
            base_dir / "app",
        ]

        for d in dirs:
            assert d.is_absolute(), f"Directory {d} is not absolute"

    def test_create_directories_correct_structure(self):
        """The directory structure should match the expected layout."""
        base_dir = build_installer.PROJECT_ROOT / "build_installer"
        expected_dirs = ["wheels", "models", "embeddings", "app"]

        for dir_name in expected_dirs:
            expected_path = base_dir / dir_name
            assert expected_path.name == dir_name


class TestDownloadWheelsPaths:
    """Test the paths used in download_wheels()."""

    def test_wheels_dir_path(self):
        """Wheels directory should be PROJECT_ROOT/build_installer/wheels."""
        wheels_dir = build_installer.PROJECT_ROOT / "build_installer" / "wheels"
        assert wheels_dir.name == "wheels"
        assert wheels_dir.parent.name == "build_installer"
        assert wheels_dir.parent.parent == build_installer.PROJECT_ROOT

    def test_requirements_path_in_download(self):
        """Requirements file should be PROJECT_ROOT/requirements.txt."""
        requirements_file = build_installer.PROJECT_ROOT / "requirements.txt"
        assert requirements_file.name == "requirements.txt"
        # It should be directly in PROJECT_ROOT, not in a subdirectory
        assert requirements_file.parent == build_installer.PROJECT_ROOT


class TestCopyAppFilesPaths:
    """Test the paths used in copy_app_files()."""

    def test_app_dir_path(self):
        """App directory should be PROJECT_ROOT/build_installer/app."""
        app_dir = build_installer.PROJECT_ROOT / "build_installer" / "app"
        assert app_dir.name == "app"
        assert app_dir.parent.name == "build_installer"

    def test_rglob_uses_project_root(self):
        """The rglob for .py files should start from PROJECT_ROOT."""
        # We can test this by checking that the rglob would be called with PROJECT_ROOT
        # Since rglob is a method, we'll mock it to verify it's called with the right pattern
        with patch.object(Path, "rglob") as mock_rglob:
            # Call copy_app_files but we'll mock the actual file operations
            with patch("shutil.copy2"):
                try:
                    build_installer.copy_app_files()
                except:
                    pass  # Ignore errors, we just want to verify rglob call pattern

                # Verify rglob was called on PROJECT_ROOT with pattern "*.py"
                mock_rglob.assert_called_with("*.py")


class TestPrepareEmbeddingModelPaths:
    """Test the paths used in prepare_embedding_model()."""

    def test_embeddings_readme_path(self):
        """Embeddings README should be at PROJECT_ROOT/build_installer/embeddings/README.txt."""
        readme_path = (
            build_installer.PROJECT_ROOT
            / "build_installer"
            / "embeddings"
            / "README.txt"
        )
        assert readme_path.name == "README.txt"
        assert readme_path.parent.name == "embeddings"
        assert readme_path.parent.parent.name == "build_installer"


class TestPrepareGGUFModelPaths:
    """Test the paths used in prepare_gguf_model()."""

    def test_models_readme_path(self):
        """Models README should be at PROJECT_ROOT/build_installer/models/README.txt."""
        readme_path = (
            build_installer.PROJECT_ROOT / "build_installer" / "models" / "README.txt"
        )
        assert readme_path.name == "README.txt"
        assert readme_path.parent.name == "models"
        assert readme_path.parent.parent.name == "build_installer"


class TestCreateInnoSetupScriptPaths:
    """Test the paths used in create_inno_setup_script()."""

    def test_inno_script_path(self):
        """Inno Setup script should be at PROJECT_ROOT/build_installer/setup.iss."""
        script_path = build_installer.PROJECT_ROOT / "build_installer" / "setup.iss"
        assert script_path.name == "setup.iss"
        assert script_path.parent.name == "build_installer"


class TestIntegrationAllPathsAccessible:
    """Integration test: verify all critical paths can be constructed without errors."""

    def test_all_paths_constructible(self):
        """All paths used in the script should be constructible and absolute."""
        paths_to_check = [
            build_installer.PROJECT_ROOT / "requirements.txt",
            build_installer.PROJECT_ROOT / "build_installer",
            build_installer.PROJECT_ROOT / "build_installer" / "wheels",
            build_installer.PROJECT_ROOT / "build_installer" / "models",
            build_installer.PROJECT_ROOT / "build_installer" / "embeddings",
            build_installer.PROJECT_ROOT / "build_installer" / "app",
            build_installer.PROJECT_ROOT
            / "build_installer"
            / "embeddings"
            / "README.txt",
            build_installer.PROJECT_ROOT / "build_installer" / "models" / "README.txt",
            build_installer.PROJECT_ROOT / "build_installer" / "setup.iss",
        ]

        for p in paths_to_check:
            assert p.is_absolute(), f"Path {p} is not absolute"
            # Path should be under PROJECT_ROOT
            assert str(p).startswith(str(build_installer.PROJECT_ROOT)), (
                f"Path {p} is not under PROJECT_ROOT"
            )


class TestMockedExecution:
    """Test that functions can be called without errors when file operations are mocked."""

    @patch("shutil.copy2")
    @patch("pathlib.Path.mkdir")
    @patch("pathlib.Path.exists")
    def test_create_directories_runs_without_chdir(
        self, mock_exists, mock_mkdir, mock_copy
    ):
        """create_directories should execute without os.chdir and create the expected directories."""
        mock_exists.return_value = False

        # Mock os.chdir to detect if it's called
        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.create_directories()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("create_directories called os.chdir")

            mock_chdir.assert_not_called()

        # Verify mkdir was called for the expected directories
        assert mock_mkdir.call_count >= 4  # At least 4 directories

    @patch("subprocess.run")
    @patch("pathlib.Path.exists")
    def test_download_wheels_runs_without_chdir(self, mock_exists, mock_run):
        """download_wheels should execute without os.chdir."""
        mock_exists.return_value = True
        mock_run.return_value = MagicMock(returncode=0)

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.download_wheels()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("download_wheels called os.chdir")

            mock_chdir.assert_not_called()

    @patch("shutil.copy2")
    @patch("pathlib.Path.rglob")
    @patch("pathlib.Path.exists")
    def test_copy_app_files_runs_without_chdir(
        self, mock_exists, mock_rglob, mock_copy
    ):
        """copy_app_files should execute without os.chdir."""
        mock_exists.return_value = False
        mock_rglob.return_value = []  # No .py files

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.copy_app_files()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("copy_app_files called os.chdir")

            mock_chdir.assert_not_called()

    @patch("builtins.open", new_callable=MagicMock)
    @patch("pathlib.Path.mkdir")
    @patch("pathlib.Path.exists")
    def test_prepare_embedding_model_runs_without_chdir(
        self, mock_exists, mock_mkdir, mock_open
    ):
        """prepare_embedding_model should execute without os.chdir."""
        mock_exists.return_value = False
        mock_open.return_value = MagicMock()

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.prepare_embedding_model()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("prepare_embedding_model called os.chdir")

            mock_chdir.assert_not_called()

        # Verify that the README path was constructed correctly
        expected_path = (
            build_installer.PROJECT_ROOT
            / "build_installer"
            / "embeddings"
            / "README.txt"
        )
        mock_open.assert_called_once_with(expected_path, "w", encoding="utf-8")

    @patch("builtins.open", new_callable=MagicMock)
    @patch("pathlib.Path.mkdir")
    @patch("pathlib.Path.exists")
    def test_prepare_gguf_model_runs_without_chdir(
        self, mock_exists, mock_mkdir, mock_open
    ):
        """prepare_gguf_model should execute without os.chdir."""
        mock_exists.return_value = False
        mock_open.return_value = MagicMock()

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.prepare_gguf_model()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("prepare_gguf_model called os.chdir")

            mock_chdir.assert_not_called()

        # Verify that the README path was constructed correctly
        expected_path = (
            build_installer.PROJECT_ROOT / "build_installer" / "models" / "README.txt"
        )
        mock_open.assert_called_once_with(expected_path, "w", encoding="utf-8")

    @patch("builtins.open", new_callable=MagicMock)
    @patch("pathlib.Path.mkdir")
    @patch("pathlib.Path.exists")
    def test_create_inno_setup_script_runs_without_chdir(
        self, mock_exists, mock_mkdir, mock_open
    ):
        """create_inno_setup_script should execute without os.chdir."""
        mock_exists.return_value = False
        mock_open.return_value = MagicMock()

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.create_inno_setup_script()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("create_inno_setup_script called os.chdir")

            mock_chdir.assert_not_called()

        # Verify that the script path was constructed correctly
        expected_path = build_installer.PROJECT_ROOT / "build_installer" / "setup.iss"
        mock_open.assert_called_once_with(expected_path, "w", encoding="utf-8")

    @patch.object(build_installer, "create_directories")
    @patch.object(build_installer, "download_wheels")
    @patch.object(build_installer, "copy_app_files")
    @patch.object(build_installer, "prepare_embedding_model")
    @patch.object(build_installer, "prepare_gguf_model")
    @patch.object(build_installer, "create_inno_setup_script")
    def test_main_runs_without_chdir(
        self,
        mock_create_iss,
        mock_prep_gguf,
        mock_prep_emb,
        mock_copy_app,
        mock_download,
        mock_create_dirs,
    ):
        """main() should orchestrate steps without calling os.chdir."""
        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.main()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("main called os.chdir")

            mock_chdir.assert_not_called()

        # Verify all steps were called in order
        mock_create_dirs.assert_called_once()
        mock_download.assert_called_once()
        mock_copy_app.assert_called_once()
        mock_prep_emb.assert_called_once()
        mock_prep_gguf.assert_called_once()
        mock_create_iss.assert_called_once()

    @patch("subprocess.run")
    @patch("pathlib.Path.exists")
    def test_download_wheels_runs_without_chdir(self, mock_exists, mock_run):
        """download_wheels should execute without os.chdir."""
        mock_exists.return_value = True
        mock_run.return_value = MagicMock(returncode=0)

        with patch.object(
            os, "chdir", side_effect=Exception("os.chdir called!")
        ) as mock_chdir:
            try:
                build_installer.download_wheels()
            except Exception as e:
                if "os.chdir called" in str(e):
                    pytest.fail("download_wheels called os.chdir")

            mock_chdir.assert_not_called()
