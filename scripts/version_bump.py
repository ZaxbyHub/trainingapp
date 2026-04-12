#!/usr/bin/env python3
"""Version bumping script for CI/CD."""

import re
import sys
from datetime import datetime
from pathlib import Path


def bump_version(version_type="patch"):
    """Bump version in all relevant files."""

    # Validate README.md exists before attempting to read
    readme_path = Path("README.md")
    if not readme_path.exists():
        print("Error: README.md not found in current directory")
        sys.exit(1)

    # Read current version from README.md
    # Look for patterns like "Version 1.2.3", "Version: 1.2.3", "**Version**: 1.2.3", etc.
    with open(readme_path, "r", encoding="utf-8") as f:
        content = f.read()
        # Match Version with optional markdown bold (**), optional colon, and version number
        match = re.search(r"(\*\*)?Version(\*\*)?[\s:]*(\d+)\.(\d+)\.(\d+)", content)
        if not match:
            print("Version not found in README.md (expected pattern: 'Version X.Y.Z', 'Version: X.Y.Z', or '**Version**: X.Y.Z')")
            sys.exit(1)

        major, minor, patch = map(int, match.group(3, 4, 5))

        if version_type == "major":
            major += 1
            minor = 0
            patch = 0
        elif version_type == "minor":
            minor += 1
            patch = 0
        else:
            patch += 1

        new_version = f"{major}.{minor}.{patch}"

    # Update README.md - preserve the original format (with markdown bold, colon, etc.)
    def replace_version(match):
        original = match.group(0)
        # Preserve markdown bold formatting if present
        has_bold_start = match.group(1) is not None
        has_bold_end = match.group(2) is not None
        
        if has_bold_start and has_bold_end:
            return f"**Version**: {new_version}"
        elif ":" in original:
            return f"Version: {new_version}"
        else:
            return f"Version {new_version}"
    
    content = re.sub(r"(\*\*)?Version(\*\*)?[\s:]*\d+\.\d+\.\d+", replace_version, content)
    with open("README.md", "w", encoding="utf-8") as f:
        f.write(content)

    # Update version file if it exists
    try:
        with open("version.py", "w", encoding="utf-8") as f:
            f.write(f'__version__ = "{new_version}"\n')
            f.write(f'__build_date__ = "{datetime.now().isoformat()}"\n')
    except (OSError, IOError) as e:
        print(f"[WARN] Could not write version.py: {e}")

    print(f"Version bumped to {new_version}")
    return new_version


if __name__ == "__main__":
    version_type = sys.argv[1] if len(sys.argv) > 1 else "patch"
    bump_version(version_type)
