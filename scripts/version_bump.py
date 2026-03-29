#!/usr/bin/env python3
"""Version bumping script for CI/CD."""

import re
import sys
from datetime import datetime


def bump_version(version_type="patch"):
    """Bump version in all relevant files."""

    # Read current version from README.md
    with open("README.md", "r", encoding="utf-8") as f:
        content = f.read()
        match = re.search(r"Version:\s*(\d+)\.(\d+)\.(\d+)", content)
        if not match:
            print("Version not found in README.md")
            sys.exit(1)

        major, minor, patch = map(int, match.groups())

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

    # Update README.md
    content = re.sub(r"Version:\s*\d+\.\d+\.\d+", f"Version: {new_version}", content)
    with open("README.md", "w", encoding="utf-8") as f:
        f.write(content)

    # Update version file if it exists
    try:
        with open("version.py", "w", encoding="utf-8") as f:
            f.write(f'__version__ = "{new_version}"\n')
            f.write(f'__build_date__ = "{datetime.now().isoformat()}"\n')
    except:
        pass

    print(f"Version bumped to {new_version}")
    return new_version


if __name__ == "__main__":
    version_type = sys.argv[1] if len(sys.argv) > 1 else "patch"
    bump_version(version_type)
