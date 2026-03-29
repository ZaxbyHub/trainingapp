# CI/CD Pipeline Documentation

## Overview

This project uses GitHub Actions for continuous integration and deployment. All workflows are defined in `.github/workflows/`.

## Workflows

### 1. Build and Release (`build.yml`)

**Triggers:**
- Push to tags starting with 'v' (e.g., v1.2.3)
- Manual trigger via Actions tab

**What it does:**
- Sets up Python 3.11 on Windows
- Installs dependencies with caching
- Builds executable using PyInstaller
- Tests the executable
- Creates a ZIP archive
- Uploads artifact
- Creates GitHub Release (for tags)

**Artifacts:**
- `DocumentQAApp-windows.zip` - Full application bundle

### 2. Tests (`test.yml`)

**Triggers:**
- Push to main/master
- Pull requests to main/master

**What it does:**
- Runs on Python 3.10, 3.11, 3.12
- Installs dependencies
- Runs pytest with coverage
- Uploads coverage report

### 3. Security Scan (`security.yml`)

**Triggers:**
- Push to main/master
- Pull requests to main/master
- Weekly schedule (Sundays at midnight)

**What it does:**
- Runs Bandit security linter
- Runs Safety dependency checker
- Uploads security report

### 4. Nightly Build (`nightly.yml`)

**Triggers:**
- Daily at 2 AM UTC
- Manual trigger

**What it does:**
- Builds the application
- Creates dated archive
- Uploads artifact (retained for 7 days)

### 5. Create Release (`release.yml`)

**Triggers:**
- Manual trigger only

**Inputs:**
- Version number (e.g., 1.2.3)
- Version type (patch/minor/major)

**What it does:**
- Bumps version in files
- Commits and tags
- Triggers build workflow

## Usage

### Creating a New Release

1. Go to Actions tab
2. Select "Create Release"
3. Click "Run workflow"
4. Enter version number
5. Select version type
6. Click "Run workflow"

The workflow will:
- Bump the version
- Create a git tag
- Trigger the build
- Create a GitHub Release with the executable

### Running Tests Locally

```bash
# Install pre-commit hooks
pip install pre-commit
pre-commit install

# Run all hooks
pre-commit run --all-files

# Run tests
pytest tests/ -v
```

### Manual Build

```bash
python scripts/build.py
```

## Secrets

No secrets required for basic operation. The `GITHUB_TOKEN` is automatically provided.

## Caching

The following are cached for faster builds:
- pip packages
- PyInstaller build cache

## Troubleshooting

### Build Timeout

If the build times out (45 minutes), you may need to:
1. Clear the cache
2. Re-run the workflow
3. Check for dependency updates

### Test Failures

Tests are configured with `continue-on-error: true` for coverage uploads to prevent blocking on coverage service issues.

## Badges

Add these to your README.md:

```markdown
![Build](https://github.com/USERNAME/REPO/workflows/Build%20and%20Release/badge.svg)
![Tests](https://github.com/USERNAME/REPO/workflows/Tests/badge.svg)
![Security](https://github.com/USERNAME/REPO/workflows/Security%20Scan/badge.svg)
```
