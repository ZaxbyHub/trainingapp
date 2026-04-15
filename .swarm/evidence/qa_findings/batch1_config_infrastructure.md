# Explorer Batch 1: Config & Infrastructure — Candidate Findings
**Generated**: 2026-04-08T22:54:00Z
**Scope**: 10 files (5 CI/CD workflows + 5 scripts)
**Explorer**: paid_explorer
**Total Findings**: 18 (2 CRITICAL, 5 HIGH, 8 MEDIUM, 3 LOW)

---

## CRITICAL (2)

### CF-001 — Runtime Incompatibility (Python 3.12+ API)
```
CANDIDATE_FINDING
  id: batch1-001
  group: 1
  provisional_severity: CRITICAL
  confidence: HIGH
  file: scripts/bundle_embedding_model.py
  line: 66
  title: Path.walk() is Python 3.12+ only — crashes on 3.10/3.11
  problem: |
    local_dir.walk() on line 66 uses pathlib.Path.walk() method, added in Python 3.12.
    Test matrix runs Python 3.10, 3.11, 3.12. Script will crash on 3.10/3.11 runners.
  fix: Use os.walk(str(local_dir)) instead, or add sys.version_info guard with fallback
  evidence: |
    Checked Python docs: pathlib.Path.walk() introduced in Python 3.12 (PEP 632, bpo-42387).
    Test workflow explicitly tests 3.10 and 3.11. No version guard exists.
  disprove_attempt: |
    Checked Python docs: pathlib.Path.walk() was introduced in Python 3.12.
    The test workflow explicitly tests 3.10 and 3.11. No sys.version_info guard exists.
    No fallback to os.walk(). UNDISPROVED — finding stands.
  ai_pattern: Python 3.12+ API used without guard for lower versions
  size: S
END
```

### CF-002 — Silent Failure (Version Pattern Mismatch)
```
CANDIDATE_FINDING
  id: batch1-002
  group: 1
  provisional_severity: CRITICAL
  confidence: HIGH
  file: scripts/version_bump.py
  line: 13-17
  title: Regex expects "Version:" in README.md — pattern never matches
  problem: |
    version_bump.py searches README.md with regex r"Version:\s*(\d+)\.(\d+)\.(\d+)".
    Grep confirmed no "Version:" string exists in README.md. Script always exits with
    "Version not found in README.md" and sys.exit(1), blocking release pipeline.
  fix: Either add "Version: 1.0.0" to README.md, or point to dedicated VERSION file
  evidence: |
    Grepped README.md for "Version:" — zero matches found.
    No fallback version source exists.
  disprove_attempt: |
    Grepped README.md for "Version:" — zero matches found.
    Grepped entire repo for "Version:" — none found.
    No fallback version source exists. UNDISPROVED — finding stands.
  ai_pattern: confident-stub
  size: S
END
```

---

## HIGH (5)

### CF-003 — Command Injection Risk
```
CANDIDATE_FINDING
  id: batch1-003
  group: 2
  provisional_severity: HIGH
  confidence: MEDIUM
  file: .github/workflows/release.yml
  line: 34
  title: Unvalidated workflow_dispatch input passed to shell command
  problem: |
    python scripts/version_bump.py ${{ github.event.inputs.version_type }} passes
    input directly into shell. While inputs are constrained to enum at YAML level,
    script accepts any sys.argv[1] value without validation. Defense-in-depth violation.
  fix: Validate version_type in script: if version_type not in ("patch","minor","major"): sys.exit(1)
  evidence: |
    YAML defines options [patch, minor, major] but script itself accepts any sys.argv[1].
    If YAML enum is ever removed, injection becomes active.
  disprove_attempt: |
    Current YAML defines options [patch, minor, major] — technically constrained.
    However, the script accepts any sys.argv[1] value (line 52: no validation).
    UNDISPROVED — risk stands.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-004 — Token Misuse
```
CANDIDATE_FINDING
  id: batch1-004
  group: 2
  provisional_severity: HIGH
  confidence: MEDIUM
  file: .github/workflows/release.yml
  line: 26
  title: GITHUB_TOKEN passed explicitly to actions/checkout — creates write token on read-only scenario
  problem: |
    actions/checkout@v4 called with token: ${{ secrets.GITHUB_TOKEN }}.
    Default behavior already uses GITHUB_TOKEN. Explicit passing is redundant and
    creates risk surface when combined with git add . (line 40) — can commit arbitrary changes.
  fix: Remove token: line — let checkout use default token implicitly. Use permissions: block at job level.
  evidence: |
    Token has full write permissions (needed for git push on line 43).
    Combined with git add . (line 40) — can commit arbitrary changes from checked-out code.
  disprove_attempt: |
    Common pattern in GitHub Actions. Token needed for git push.
    But explicit token usage with full write permissions is a risk surface.
    UNDISPROVED — surface exists.
  ai_pattern: other
  size: S
END
```

### CF-005 — Windows-Only Path Hardcoded
```
CANDIDATE_FINDING
  id: batch1-005
  group: 3
  provisional_severity: HIGH
  confidence: HIGH
  file: .github/workflows/build.yml
  line: 43
  title: Windows path literal used in build.yml
  problem: |
    dist\DocumentQAApp\DocumentQAApp.exe --help uses Windows backslash path separator.
    If workflow adapted for Linux/macOS runners, this step fails. Hidden dependency on Windows.
  fix: Use ${{ github.workspace }}/dist/DocumentQAApp/DocumentQAApp.exe or Join-Path
  evidence: |
    Workflow runs on windows-latest (line 11), so works in CI.
    But creates hidden dependency for cross-platform builds.
  disprove_attempt: |
    Workflow runs on windows-latest, so this works in CI.
    However, this creates a hidden dependency.
    UNDISPROVED.
  ai_pattern: hardcoded-unix-path (reverse: Windows-only)
  size: S
END
```

### CF-006 — Windows-Only Inno Setup
```
CANDIDATE_FINDING
  id: batch1-006
  group: 3
  provisional_severity: HIGH
  confidence: HIGH
  file: scripts/build_installer.py
  line: 156-201
  title: Inno Setup script template hardcodes Windows-specific paths and placeholders
  problem: |
    Generated setup.iss uses hardcoded Windows paths ({{pf}}\DocumentQAApp, backslash separators,
    {{commondesktop}}\Document QA App). Also hardcoded placeholder values: AppVersion=1.0.0,
    AppPublisher=Your Company Name — these will ship as literal strings in installer.
  fix: Parameterize AppPublisher, AppVersion, URLs from environment. Replace backslashes with os.path.sep.
  evidence: |
    These are Windows-only installers by design. But hardcoded placeholder values
    ("Your Company Name") would produce broken installer if used as-is.
  disprove_attempt: |
    Windows-only installers by design. But hardcoded placeholder values would produce
    a broken installer if used as-is. UNDISPROVED — real risk.
  ai_pattern: confident-stub
  size: M
END
```

### CF-007 — Deprecated Action Version
```
CANDIDATE_FINDING
  id: batch1-007
  group: 9
  provisional_severity: HIGH
  confidence: HIGH
  file: .github/workflows/test.yml
  line: 25
  title: actions/cache@v3 deprecated — should use v4
  problem: |
    actions/cache@v3 used in test.yml, build.yml, nightly.yml. GitHub deprecated v3.
    v3 uses different backend that may be removed. v4 handles Windows paths better.
  fix: Replace all actions/cache@v3 with actions/cache@v4
  evidence: |
    v3 reached end-of-life. Migration to v4 is one-line change.
  disprove_attempt: |
    v3 still works on GitHub Actions. However, v3 reached end-of-life.
    UNDISPROVED.
  ai_pattern: stale-api
  size: S
END
```

### CF-008 — Deprecated Action Version (Codecov)
```
CANDIDATE_FINDING
  id: batch1-008
  group: 9
  provisional_severity: HIGH
  confidence: HIGH
  file: .github/workflows/test.yml
  line: 43
  title: codecov/codecov-action@v3 deprecated — should use v4
  problem: |
    codecov/codecov-action@v3 was deprecated. v4 uses Node 20 (vs v3's Node 12).
    v3 may stop working when GitHub deprecates Node 12 actions runtime.
  fix: Replace codecov/codecov-action@v3 with codecov/codecov-action@v4
  evidence: |
    v3 still functions today. But GitHub signaled Node 12 actions are being phased out.
  disprove_attempt: |
    v3 still functions today. But GitHub has signaled Node 12 actions are being phased out.
    UNDISPROVED — migration needed.
  ai_pattern: stale-api
  size: S
END
```

---

## MEDIUM (8)

### CF-009 — Silent Exception Swallowing
```
CANDIDATE_FINDING
  id: batch1-009
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  file: scripts/version_bump.py
  line: 44
  title: Bare except: pass silently swallows ALL exceptions
  problem: |
    except: pass catches BaseException including KeyboardInterrupt, SystemExit, MemoryError.
    If version.py write fails (disk full, permissions), user sees "Version bumped to X"
    even though file was never updated. Masks partial failure silently.
  fix: Change to except (IOError, OSError) as e: with print warning
  evidence: |
    The try/except wraps the version.py write only. A failure there is possible
    (disk space, permissions). The success message fires regardless.
  disprove_attempt: |
    The try/except wraps the version.py write only. A failure there is unlikely
    but possible. The success message fires regardless. UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-010 — Subprocess Pip Not Module
```
CANDIDATE_FINDING
  id: batch1-010
  group: 1
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: scripts/build_installer.py
  line: 52-63
  title: subprocess.run uses "pip" directly instead of sys.executable -m pip
  problem: |
    subprocess.run(["pip", "download", ...]) calls pip as standalone command.
    Fails if pip not on PATH, or if virtualenv shadows pip incorrectly.
    Standard practice is subprocess.run([sys.executable, "-m", "pip", ...]).
  fix: Use subprocess.run([sys.executable, "-m", "pip", ...])
  evidence: |
    In most CI environments pip is on PATH. But in custom environments or
    python embeddable distributions (target of this script), pip may not be on PATH.
  disprove_attempt: |
    In most CI environments pip is on PATH. But in custom environments
    pip may not be on PATH. UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-011 — Model Version Drift
```
CANDIDATE_FINDING
  id: batch1-011
  group: 4
  provisional_severity: MEDIUM
  confidence: HIGH
  file: scripts/build_installer.py
  line: 135
  title: build_installer.py references Qwen3-1.7B but README specifies Qwen2.5-1.5B
  problem: |
    build_installer.py line 135: "The Qwen3-1.7B GGUF model needs to be manually downloaded".
    README.md line 20: "Model: Qwen2.5-1.5B-Instruct-Q4_K_M".
    Contradictory model references. Developer following README will download wrong model.
  fix: Align model references. Update build_installer.py to Qwen2.5-1.5B (or update README)
  evidence: |
    README shows Qwen2.5-1.5B. Grep confirmed no "Qwen3" in README.
    build_installer.py clearly says Qwen3-1.7B.
  disprove_attempt: |
    README was read showing Qwen2.5-1.5B. Grep confirmed no "Qwen3" in README.
    build_installer.py clearly says Qwen3-1.7B. UNDISPROVED.
  ai_pattern: doc-drift
  size: S
END
```

### CF-012 — Fragile Relative Path
```
CANDIDATE_FINDING
  id: batch1-012
  group: 5
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: scripts/version_bump.py
  line: 13, 36
  title: version_bump.py uses relative paths with no validation
  problem: |
    Lines 13, 36, 41 use open("README.md", ...) and open("version.py", ...) with
    no path validation. If script run from wrong directory, creates files in wrong
    location or fails unexpectedly.
  fix: Derive paths from __file__ like build_installer.py does (SCRIPT_DIR = Path(__file__).parent.resolve())
  evidence: |
    CI calls from project root so it works in CI. But script has no guard
    against wrong working directory.
  disprove_attempt: |
    CI calls from project root so it works in CI. But the script has no guard
    against wrong working directory. UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-013 — Weak Security Gate
```
CANDIDATE_FINDING
  id: batch1-013
  group: 6
  provisional_severity: MEDIUM
  confidence: HIGH
  file: .github/workflows/security.yml
  line: 28
  title: Bandit and Safety run with || true — never fail the build
  problem: |
    bandit -r . ... || true and safety check ... || true ensure security scans
    never block workflow. Combined with fail_ci_if_error: false pattern, critical
    security findings are logged but ignored. Security workflow provides false confidence.
  fix: Remove || true from at least one tool. Security findings should be gating.
  evidence: |
    Security scan results uploaded as artifacts and visible in UI.
    But no mechanism blocks merges on critical findings.
  disprove_attempt: |
    Security scan results are uploaded as artifacts and visible in the UI.
    But no mechanism blocks merges on critical findings. UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-014 — Silent Test Failures
```
CANDIDATE_FINDING
  id: batch1-014
  group: 6
  provisional_severity: MEDIUM
  confidence: HIGH
  file: .github/workflows/test.yml
  line: 40
  title: continue-on-error: true on pytest step hides real test failures
  problem: |
    continue-on-error: true on pytest step means test failures produce green checkmark.
    Combined with codecov fail_ci_if_error: false, entire test pipeline is advisory.
    Real regressions can ship undetected.
  fix: Remove continue-on-error: true from pytest step. Keep only on codecov if coverage optional.
  evidence: |
    continue-on-error: true is sometimes intentional for gradual rollouts.
    But this is the primary test step, not a secondary probe.
  disprove_attempt: |
    continue-on-error: true is sometimes intentional. But this is the primary test step.
    UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-015 — Silent Build Failure
```
CANDIDATE_FINDING
  id: batch1-015
  group: 7
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: scripts/build.py
  line: 84
  title: subprocess.run without capture or check=True — build output lost on failure
  problem: |
    subprocess.run(cmd) without capture_output=True or check=True means:
    (a) stdout/stderr go to CI logs only if no error, (b) on failure, output is
    lost and only return code checked. PyInstaller output lost on failure.
  fix: Add capture_output=True, text=True to subprocess.run, or redirect to log file
  evidence: |
    Line 86-88 checks returncode and prints message. But PyInstaller output
    itself is lost on failure.
  disprove_attempt: |
    Line 86-88 checks returncode and prints a message. But the PyInstaller output
    itself is lost on failure. UNDISPROVED.
  ai_pattern: happy-path-only
  size: S
END
```

### CF-016 — Forward Slash Path Literal
```
CANDIDATE_FINDING
  id: batch1-016
  group: 3
  provisional_severity: MEDIUM
  confidence: LOW
  file: scripts/bundle_embedding_model.py
  line: 90
  title: Default local-dir uses forward-slash — inconsistent on Windows
  problem: |
    default="bundled_models/bge-small-en-v1.5" uses forward-slash. On Windows,
    this creates bundled_models\bge-small-en-v1.5. While Python's Path handles this,
    downstream string splitting on "/" instead of os.sep could break paths.
  fix: Use Path("bundled_models") / "bge-small-en-v1.5" for default
  evidence: |
    Python's Path correctly normalizes forward slashes on Windows.
    argparse help displays string literally. Minor cosmetic issue.
  disprove_attempt: |
    Python's Path correctly normalizes forward slashes on Windows.
    argparse help displays the string literally. Minor cosmetic issue.
    MEDIUM because downstream string path manipulation could break.
  ai_pattern: other
  size: S
END
```

---

## LOW (3)

### CF-017 — Windows-Only Command
```
CANDIDATE_FINDING
  id: batch1-017
  group: 3
  provisional_severity: LOW
  confidence: HIGH
  file: .github/workflows/build.yml
  line: 47
  title: Compress-Archive is PowerShell/Windows-only command
  problem: |
    Compress-Archive -Path dist\DocumentQAApp\* is PowerShell-only.
    nightly.yml line 40 uses same command. If runners change to Linux, steps fail.
  fix: Document Windows-only constraint. Or use Python's zipfile module for cross-platform zipping.
  evidence: |
    Both workflows explicitly set runs-on: windows-latest. Functional today.
  disprove_attempt: |
    Both workflows explicitly set runs-on: windows-latest. Functional today.
    LOW because runner is explicitly Windows.
  ai_pattern: other
  size: S
END
```

### CF-018 — Weak Path Containment
```
CANDIDATE_FINDING
  id: batch1-018
  group: 6
  provisional_severity: LOW
  confidence: LOW
  file: scripts/build_installer.py
  line: 78
  title: BUILD_DIR containment check uses substring match — fragile
  problem: |
    if not any(part in str(file) for part in [BUILD_DIR, "__pycache__", ".git"])
    checks if string "build_installer" appears anywhere in full file path.
    A file named my_build_installer.py would be excluded. Fragile pattern.
  fix: Use BUILD_DIR as resolved absolute Path and check with file.absolute().is_relative_to()
  evidence: |
    BUILD_DIR = "build_installer" — unlikely there are files with this substring
    in unintended ways. Fragile but low practical risk.
  disprove_attempt: |
    BUILD_DIR = "build_installer" — unlikely there are files with this substring
    in unintended ways. This is a fragile pattern but low practical risk.
    LOW.
  ai_pattern: off-by-one (substring matching)
  size: S
END
```

### CF-019 — Ambiguous File Location
```
CANDIDATE_FINDING
  id: batch1-019
  group: 4
  provisional_severity: LOW
  confidence: HIGH
  file: scripts/version_bump.py
  line: 13, 36
  title: version_bump.py modifies README.md in-place but README has no "Version:" field
  problem: |
    Script reads README.md, updates "Version:" field, writes back. But grep confirms
    no "Version:" field exists in README. re.sub on line 35 is no-op.
    Prints "Version bumped to X" after no-op write.
  fix: Covered by CF-002 fix
  evidence: |
    Confirmed: re.sub finds no match, writes identical content.
    This is a subset of CF-002 (CRITICAL).
  disprove_attempt: |
    Confirmed: re.sub finds no match, writes identical content.
    This is a subset of CF-002 (CRITICAL — script always exits 1).
    LOW priority since CF-002 already captures the root cause.
  ai_pattern: doc-drift
  size: S
END
```
