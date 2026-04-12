#!/usr/bin/env python3
"""Tests for version_bump.py — verifies the fixed regex handles all formats."""

import os
import re
import sys
import tempfile
import shutil
from unittest.mock import patch

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# The FIXED regex pattern from the updated source code
# Groups: (1)=**?  (2)=**?  (3)=major  (4)=minor  (5)=patch
# ─────────────────────────────────────────────────────────────────────────────
VERSION_PATTERN = r"(\*\*)?Version(\*\*)?[\s:]*(\d+)\.(\d+)\.(\d+)"


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — pure regex matching, no file I/O
# ─────────────────────────────────────────────────────────────────────────────

class TestVersionRegexUnit:

    def test_matches_plain_version(self):
        """Pattern matches 'Version 1.2.3'."""
        match = re.search(VERSION_PATTERN, "Version 1.2.3")
        assert match is not None
        assert match.group(3) == "1"
        assert match.group(4) == "2"
        assert match.group(5) == "3"

    def test_matches_version_with_colon(self):
        """Pattern matches 'Version: 1.2.3'."""
        match = re.search(VERSION_PATTERN, "Version: 1.2.3")
        assert match is not None
        assert match.group(3) == "1"
        assert match.group(4) == "2"
        assert match.group(5) == "3"

    def test_matches_bold_version(self):
        """Pattern matches '**Version**: 1.2.3' — the key fix."""
        match = re.search(VERSION_PATTERN, "**Version**: 1.2.3")
        assert match is not None, "Fixed regex must match **Version**: format"
        assert match.group(1) == "**"   # group 1: opening bold
        assert match.group(2) == "**"   # group 2: closing bold
        assert match.group(3) == "1"
        assert match.group(4) == "2"
        assert match.group(5) == "3"

    def test_matches_version_in_parentheses(self):
        """Pattern matches 'New Features (Version 1.2.3)'."""
        match = re.search(VERSION_PATTERN, "New Features (Version 1.2.3)")
        assert match is not None
        assert match.group(3) == "1"
        assert match.group(4) == "2"
        assert match.group(5) == "3"

    def test_groups_345_are_version_components(self):
        """Groups 3, 4, 5 contain major/minor/patch as strings."""
        match = re.search(VERSION_PATTERN, "Version 5.10.3")
        assert match is not None
        major, minor, patch = map(int, match.group(3, 4, 5))
        assert major == 5
        assert minor == 10
        assert patch == 3

    def test_groups_1_and_2_capture_bold_markers(self):
        """Groups 1 and 2 capture ** markers for markdown bold."""
        # Plain — no bold
        match = re.search(VERSION_PATTERN, "Version 1.0.0")
        assert match.group(1) is None
        assert match.group(2) is None

        # Bold on both sides
        match = re.search(VERSION_PATTERN, "**Version**: 1.0.0")
        assert match.group(1) == "**"
        assert match.group(2) == "**"

        # Bold only on start (edge — shouldn't happen but verify behavior)
        match = re.search(VERSION_PATTERN, "**Version 1.0.0")
        assert match.group(1) == "**"
        assert match.group(2) is None

    def test_no_match_wrong_separator(self):
        """Pattern does NOT match 'Version-1.2.3' (dash, not colon/space)."""
        match = re.search(VERSION_PATTERN, "Version-1.2.3")
        assert match is None


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests — replace_version logic preserves format correctly
# ─────────────────────────────────────────────────────────────────────────────

class TestReplaceVersionLogic:

    def _replace(self, original, new_version):
        """Mirror the replace_version function from the source."""
        def replace_version(match):
            has_bold_start = match.group(1) is not None
            has_bold_end = match.group(2) is not None
            if has_bold_start and has_bold_end:
                return f"**Version**: {new_version}"
            elif ":" in original:
                return f"Version: {new_version}"
            else:
                return f"Version {new_version}"
        return re.sub(VERSION_PATTERN, replace_version, original)

    def test_preserves_plain_format(self):
        """'Version 1.1.1' stays as 'Version 1.2.3'."""
        result = self._replace("Version 1.1.1", "1.2.3")
        assert result == "Version 1.2.3"

    def test_preserves_colon_format(self):
        """'Version: 1.1.1' stays as 'Version: 1.2.3'."""
        result = self._replace("Version: 1.1.1", "1.2.3")
        assert result == "Version: 1.2.3"

    def test_preserves_bold_format(self):
        """'**Version**: 1.1.1' stays as '**Version**: 1.2.3' — the key fix."""
        result = self._replace("**Version**: 1.1.1", "1.2.3")
        assert result == "**Version**: 1.2.3"

    def test_bold_replacement_is_exact(self):
        """Bold replacement has exactly ** on both sides."""
        result = self._replace("**Version**: 1.0.0", "2.0.0")
        # Must have **Version** exactly, not ***Version** or **Version***
        assert result == "**Version**: 2.0.0"
        assert "**Version**" in result
        # Should not have triple asterisks
        assert "***" not in result


# ─────────────────────────────────────────────────────────────────────────────
# Integration tests — real file I/O with temp directory
# ─────────────────────────────────────────────────────────────────────────────

class TestVersionBumpIntegration:

    def _bump(self, readme_content, version_type="patch"):
        """Run bump_version with a real temp README.md and version.py."""
        tmpdir = tempfile.mkdtemp()
        readme_path = os.path.join(tmpdir, "README.md")
        version_file_path = os.path.join(tmpdir, "version.py")

        with open(readme_path, "w", encoding="utf-8") as f:
            f.write(readme_content)

        original_open = open

        def fake_open(path, mode="r", *args, **kwargs):
            path_str = str(path)
            if (path_str == "README.md" or
                    path_str.endswith("\\README.md") or
                    path_str.endswith("/README.md")):
                return original_open(readme_path, mode, *args, **kwargs)
            elif (path_str == "version.py" or
                  path_str.endswith("\\version.py") or
                  path_str.endswith("/version.py")):
                return original_open(version_file_path, mode, *args, **kwargs)
            return original_open(path, mode, *args, **kwargs)

        import scripts.version_bump as vb
        with patch("builtins.open", fake_open):
            result = vb.bump_version(version_type)

        with open(readme_path, "r", encoding="utf-8") as f:
            new_content = f.read()

        shutil.rmtree(tmpdir, ignore_errors=True)
        return result, new_content

    # ── Format preservation ──────────────────────────────────────────────────

    def test_bold_format_preserved_after_bump(self):
        """'**Version**: 1.0.0' → '**Version**: 1.0.1' (patch)."""
        content = "Current version: **Version**: 1.0.0\n"
        result, new_content = self._bump(content)
        assert result == "1.0.1"
        assert "**Version**: 1.0.1" in new_content
        assert "**Version**: 1.0.0" not in new_content

    def test_plain_format_preserved_after_bump(self):
        """'Version 1.0.0' → 'Version 1.0.1' (patch)."""
        content = "Version 1.0.0\n"
        result, new_content = self._bump(content)
        assert result == "1.0.1"
        assert "Version 1.0.1" in new_content
        assert "Version: 1.0.1" not in new_content

    def test_colon_format_preserved_after_bump(self):
        """'Version: 1.0.0' → 'Version: 1.0.1' (patch)."""
        content = "Version: 1.0.0\n"
        result, new_content = self._bump(content)
        assert result == "1.0.1"
        assert "Version: 1.0.1" in new_content

    # ── Bump types ────────────────────────────────────────────────────────────

    def test_patch_bump(self):
        """1.2.3 → 1.2.4 (patch)"""
        content = "Version 1.2.3\n"
        result, _ = self._bump(content, "patch")
        assert result == "1.2.4"

    def test_minor_bump(self):
        """1.2.3 → 1.3.0 (minor)"""
        content = "Version 1.2.3\n"
        result, _ = self._bump(content, "minor")
        assert result == "1.3.0"

    def test_major_bump(self):
        """1.2.3 → 2.0.0 (major)"""
        content = "Version 1.2.3\n"
        result, _ = self._bump(content, "major")
        assert result == "2.0.0"

    # ── Bold markdown edge cases ──────────────────────────────────────────────

    def test_bold_minor_bump(self):
        """**Version**: 1.2.3 → **Version**: 1.3.0 (minor)"""
        content = "**Version**: 1.2.3\n"
        result, new_content = self._bump(content, "minor")
        assert result == "1.3.0"
        assert "**Version**: 1.3.0" in new_content

    def test_bold_major_bump(self):
        """**Version**: 1.2.3 → **Version**: 2.0.0 (major)"""
        content = "**Version**: 1.2.3\n"
        result, new_content = self._bump(content, "major")
        assert result == "2.0.0"
        assert "**Version**: 2.0.0" in new_content

    def test_bold_in_real_readme_position(self):
        """Simulates README.md line 548: '**Version**: 1.1.0'."""
        content = (
            "<!-- omit from ToC -->\n"
            "## Installation\n\n"
            "**Version**: 1.1.0 | [Requirements](#requirements)\n"
        )
        result, new_content = self._bump(content)
        assert result == "1.1.1"
        assert "**Version**: 1.1.1" in new_content
        assert "**Version**: 1.1.0" not in new_content

    # ── Other content preserved ──────────────────────────────────────────────

    def test_surrounding_content_preserved(self):
        """Other lines in README are not modified."""
        content = "# Title\nVersion 1.0.0\n## Changelog\n"
        _, new_content = self._bump(content)
        assert "# Title" in new_content
        assert "## Changelog" in new_content
        assert "Version 1.0.1" in new_content

    def test_version_in_parentheses_preserved(self):
        """(Version 1.0.0) → (Version 1.0.1) preserves format."""
        content = "Changelog (Version 1.0.0)\n"
        result, new_content = self._bump(content)
        assert result == "1.0.1"
        assert "Version 1.0.1" in new_content

    # ── Error cases ───────────────────────────────────────────────────────────

    def test_no_version_found_exits(self):
        """Script exits with code 1 when no version pattern found."""
        tmpdir = tempfile.mkdtemp()
        readme_path = os.path.join(tmpdir, "README.md")
        with open(readme_path, "w", encoding="utf-8") as f:
            f.write("No version here\n")

        original_open = open

        def fake_open(path, mode="r", *args, **kwargs):
            path_str = str(path)
            if (path_str == "README.md" or
                    path_str.endswith("\\README.md") or
                    path_str.endswith("/README.md")):
                return original_open(readme_path, mode, *args, **kwargs)
            return original_open(path, mode, *args, **kwargs)

        import scripts.version_bump as vb
        with patch("builtins.open", fake_open):
            with pytest.raises(SystemExit) as exc_info:
                vb.bump_version("patch")
        assert exc_info.value.code == 1

        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
