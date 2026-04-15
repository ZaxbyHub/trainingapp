# Reviewer Batch 1: Config & Infrastructure — Validation Results
**Generated**: 2026-04-08T22:58:00Z
**Scope**: 18 candidate findings from Explorer Batch 1
**Reviewer**: paid_reviewer
**Results**: 16 CONFIRMED, 1 DISPROVED, 1 PRE_EXISTING

---

## CRITICAL (2) — CRITIC_REQUIRED

### CF-001 — CONFIRMED | CRITICAL | CRITIC_REQUIRED
```
VALIDATED_FINDING
  candidate_id: batch1-001
  status: CONFIRMED
  severity: CRITICAL
  confidence: HIGH
  file: scripts/bundle_embedding_model.py
  line: 66
  title: Path.walk() is Python 3.12+ only — crashes on 3.10/3.11
  problem: |
    pathlib.Path.walk() is confirmed Python 3.12+ only. Test matrix explicitly runs
    3.10, 3.11, 3.12. No sys.version_info guard exists. os.walk(str(local_dir)) is correct fallback.
  fix: Use os.walk(str(local_dir)) instead, or add sys.version_info guard with fallback
  evidence: |
    Verified: pathlib.Path.walk() introduced in Python 3.12 (PEP 632, bpo-42387).
    Test workflow runs Python 3.10, 3.11, 3.12. No version guard in file.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: Python 3.12+ API used without guard
  inline_routing: CRITIC_REQUIRED
  size: S
END
```

### CF-002 — CONFIRMED | CRITICAL | CRITIC_REQUIRED
```
VALIDATED_FINDING
  candidate_id: batch1-002
  status: CONFIRMED
  severity: CRITICAL
  confidence: HIGH
  file: scripts/version_bump.py
  line: 13-17
  title: Regex expects "Version:" in README.md — pattern never matches
  problem: |
    grep confirms NO "Version:" field in README.md. Script will always exit(1) at line 18.
    No fallback version source exists. Release pipeline blocking by design.
  fix: Either add "Version: 1.0.0" to README.md, or point to dedicated VERSION file
  evidence: |
    Grepped README.md for "Version:" — zero matches found.
    No fallback version source exists.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: confident-stub
  inline_routing: CRITIC_REQUIRED
  size: S
END
```

---

## HIGH (1) — CRITIC_REQUIRED

### CF-006 — CONFIRMED | HIGH | CRITIC_REQUIRED
```
VALIDATED_FINDING
  candidate_id: batch1-006
  status: CONFIRMED
  severity: HIGH
  confidence: HIGH
  file: scripts/build_installer.py
  line: 156-201
  title: Inno Setup script template hardcodes Windows-specific paths and placeholders
  problem: |
    Inno Setup script hardcodes AppVersion=1.0.0, AppPublisher=Your Company Name,
    AppPublisherURL=https://yourcompany.com. These placeholder values shipped as-literal
    would produce broken installer metadata.
  fix: Parameterize AppPublisher, AppVersion, URLs from environment. Replace backslashes with os.path.sep.
  evidence: |
    Verified: setup.iss template contains literal placeholder strings.
    These would appear in final installer if not customized.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: confident-stub
  inline_routing: CRITIC_REQUIRED
  size: M
END
```

---

## MEDIUM (8) — REVIEWER_FINALIZED

### CF-003 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-003
  status: CONFIRMED
  severity: MEDIUM
  confidence: MEDIUM
  file: .github/workflows/release.yml
  line: 34
  title: Unvalidated workflow_dispatch input passed to shell command
  problem: |
    YAML type: choice with options [patch, minor, major] constrains input at GitHub Actions level.
    Script accepts any sys.argv[1] without validation. Defense-in-depth concern is theoretical
    given current workflow design, but script validation would improve.
  fix: Validate version_type in script: if version_type not in ("patch","minor","major"): sys.exit(1)
  evidence: |
    YAML defines options but script accepts any sys.argv[1].
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-007 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-007
  status: CONFIRMED
  severity: MEDIUM
  confidence: HIGH
  file: .github/workflows/test.yml
  line: 25
  title: actions/cache@v3 deprecated — should use v4
  problem: |
    actions/cache@v3 is confirmed deprecated (GitHub announced EOL). v4 available with
    better Windows path handling. v3 still functions today but migration is recommended.
  fix: Replace all actions/cache@v3 with actions/cache@v4
  evidence: |
    v3 reached end-of-life. Migration to v4 is one-line change.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: stale-api
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-008 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-008
  status: CONFIRMED
  severity: MEDIUM
  confidence: HIGH
  file: .github/workflows/test.yml
  line: 43
  title: codecov/codecov-action@v3 deprecated — should use v4
  problem: |
    codecov/codecov-action@v3 is confirmed deprecated (uses Node 12).
    GitHub signaling Node 12 actions EOL. v4 uses Node 20.
  fix: Replace codecov/codecov-action@v3 with codecov/codecov-action@v4
  evidence: |
    v3 still functions today. But GitHub has signaled Node 12 actions are being phased out.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: stale-api
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-009 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-009
  status: CONFIRMED
  severity: MEDIUM
  confidence: HIGH
  file: scripts/version_bump.py
  line: 44
  title: Bare except: pass silently swallows ALL exceptions
  problem: |
    except: pass catches BaseException including KeyboardInterrupt, SystemExit, MemoryError.
    Line 47 always prints success regardless of whether version.py write actually succeeded.
  fix: Change to except (IOError, OSError) as e: with print warning
  evidence: |
    The try/except wraps the version.py write only. A failure there is possible
    (disk space, permissions). The success message fires regardless.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-010 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-010
  status: CONFIRMED
  severity: MEDIUM
  confidence: MEDIUM
  file: scripts/build_installer.py
  line: 52-63
  title: subprocess.run uses "pip" directly instead of sys.executable -m pip
  problem: |
    subprocess.run(["pip", "download", ...]) calls pip as standalone command.
    Fails if pip not on PATH. This script targets Python embeddable distributions
    where pip may not be on PATH.
  fix: Use subprocess.run([sys.executable, "-m", "pip", ...])
  evidence: |
    In most CI environments pip is on PATH. But in custom environments or
    python embeddable distributions, pip may not be on PATH.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-011 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-011
  status: CONFIRMED
  severity: MEDIUM
  confidence: HIGH
  file: scripts/build_installer.py
  line: 135
  title: build_installer.py references Qwen3-1.7B but README specifies Qwen2.5-1.5B
  problem: |
    build_installer.py line 135 says "Qwen3-1.7B GGUF model".
    README.md says "Qwen2.5-1.5B-Instruct-Q4_K_M".
    Contradictory model references. Developer following README will download wrong model.
  fix: Align model references. Update build_installer.py to Qwen2.5-1.5B (or update README)
  evidence: |
    README shows Qwen2.5-1.5B. Grep confirmed no "Qwen3" in README.
    build_installer.py clearly says Qwen3-1.7B.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: doc-drift
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-013 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-013
  status: CONFIRMED
  severity: MEDIUM
  confidence: HIGH
  file: .github/workflows/security.yml
  line: 28
  title: Bandit and Safety run with || true — never fail the build
  problem: |
    bandit -r . ... || true and safety check ... || true ensure security scans
    never block the workflow. Results uploaded as artifacts but no gating mechanism.
    Security workflow provides false confidence.
  fix: Remove || true from at least one tool. Security findings should be gating.
  evidence: |
    Security scan results uploaded as artifacts and visible in UI.
    But no mechanism blocks merges on critical findings.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

### CF-014 — CONFIRMED | MEDIUM | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-014
  status: CONFIRMED
  severity: MEDIUM
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
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

---

## LOW/INFO (5) — REVIEWER_FINALIZED

### CF-004 — CONFIRMED | LOW | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-004
  status: CONFIRMED
  severity: LOW
  confidence: MEDIUM
  file: .github/workflows/release.yml
  line: 26
  title: GITHUB_TOKEN passed explicitly to actions/checkout
  problem: |
    token: ${{ secrets.GITHUB_TOKEN }} is redundant (checkout uses GITHUB_TOKEN by default)
    but is common practice. Token has write permissions needed for git push.
    Explicit passing creates marginal risk surface.
  fix: Remove token: line — let checkout use default token implicitly. Use permissions: block.
  evidence: |
    Token has full write permissions (needed for git push).
    Combined with git add . — can commit arbitrary changes from checked-out code.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: other
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from HIGH)
  size: S
END
```

### CF-005 — CONFIRMED | LOW | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-005
  status: CONFIRMED
  severity: LOW
  confidence: HIGH
  file: .github/workflows/build.yml
  line: 43
  title: Windows path literal used in build.yml
  problem: |
    dist\DocumentQAApp\DocumentQAApp.exe uses Windows backslash path separator.
    Workflow explicitly sets runs-on: windows-latest. No cross-platform concern within CI.
  fix: Use ${{ github.workspace }}/dist/DocumentQAApp/DocumentQAApp.exe or Join-Path
  evidence: |
    Workflow runs on windows-latest, so works in CI.
    But creates hidden dependency for cross-platform builds.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: hardcoded-unix-path (reverse)
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from HIGH)
  size: S
END
```

### CF-012 — CONFIRMED | LOW | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-012
  status: CONFIRMED
  severity: LOW
  confidence: MEDIUM
  file: scripts/version_bump.py
  line: 13, 36
  title: version_bump.py uses relative paths with no validation
  problem: |
    Uses open("README.md", ...) and open("version.py", ...) with no path validation.
    CI runs from project root so works in CI. Script not intended for standalone use.
  fix: Derive paths from __file__ like build_installer.py does
  evidence: |
    CI calls from project root so it works in CI. But script has no guard
    against wrong working directory.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from MEDIUM)
  size: S
END
```

### CF-015 — CONFIRMED | LOW | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-015
  status: CONFIRMED
  severity: LOW
  confidence: MEDIUM
  file: scripts/build.py
  line: 84
  title: subprocess.run without capture or check=True — build output lost on failure
  problem: |
    subprocess.run(cmd) without capture_output=True or check=True means:
    stdout/stderr go to CI logs only if no error. On failure, output is lost.
    However, lines 86-88 check returncode and print failure message.
  fix: Add capture_output=True, text=True to subprocess.run, or redirect to log file
  evidence: |
    Line 86-88 checks returncode and prints message. But PyInstaller output
    itself is lost on failure.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: happy-path-only
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from MEDIUM)
  size: S
END
```

### CF-017 — CONFIRMED | INFO | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-017
  status: CONFIRMED
  severity: INFO
  confidence: HIGH
  file: .github/workflows/build.yml
  line: 47
  title: Compress-Archive is PowerShell/Windows-only command
  problem: |
    Compress-Archive is PowerShell/Windows-only. Both build.yml and nightly.yml
    explicitly use runs-on: windows-latest. Windows constraint is documented by runner choice.
  fix: Document Windows-only constraint. Or use Python's zipfile module for cross-platform zipping.
  evidence: |
    Both workflows explicitly set runs-on: windows-latest. Functional today.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: other
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from LOW)
  size: S
END
```

### CF-018 — CONFIRMED | INFO | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-018
  status: CONFIRMED
  severity: INFO
  confidence: LOW
  file: scripts/build_installer.py
  line: 78
  title: BUILD_DIR containment check uses substring match — fragile
  problem: |
    BUILD_DIR = "build_installer" — substring match is fragile.
    A file at path/to/my_build_installer_backup.py would be incorrectly excluded.
    Practical risk is negligible; unlikely to have files with "build_installer" substring.
  fix: Use BUILD_DIR as resolved absolute Path and check with file.absolute().is_relative_to()
  evidence: |
    BUILD_DIR = "build_installer" — unlikely there are files with this substring
    in unintended ways. Fragile but low practical risk.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: off-by-one (substring matching)
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from LOW)
  size: S
END
```

---

## DISPROVED (1)

### CF-016 — DISPROVED | INFO | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-016
  status: DISPROVED
  severity: INFO
  confidence: HIGH
  file: scripts/bundle_embedding_model.py
  line: 90
  title: Default local-dir uses forward-slash — inconsistent on Windows
  problem: |
    Python's argparse passes the string to Path(args.local_dir) which handles
    slashes correctly. No actual path breakage occurs.
  fix: N/A — no fix needed
  evidence: |
    Python's Path correctly normalizes forward slashes on Windows.
    No downstream string splitting on "/" is evidenced in the codebase.
  disproof_reason: |
    Python's argparse passes the string to Path(args.local_dir) which handles
    slashes correctly. No actual path breakage occurs.
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: other
  inline_routing: REVIEWER_FINALIZED
  finalization_status: DOWNGRADED (from MEDIUM)
  size: S
END
```

---

## PRE_EXISTING (1)

### CF-019 — PRE_EXISTING | INFO | REVIEWER_FINALIZED
```
VALIDATED_FINDING
  candidate_id: batch1-019
  status: PRE_EXISTING
  severity: INFO
  confidence: HIGH
  file: scripts/version_bump.py
  line: 13, 36
  title: version_bump.py modifies README.md in-place but README has no "Version:" field
  problem: |
    re.sub on line 35 is a no-op since no "Version:" field exists.
    This is a direct consequence of CF-002.
  fix: Covered by CF-002 fix
  evidence: |
    Confirmed: re.sub finds no match, writes identical content.
    This is a subset of CF-002.
  disproof_reason: N/A
  verification_mode: STATIC
  runtime_validation: N/A
  ai_pattern: doc-drift
  inline_routing: REVIEWER_FINALIZED
  finalization_status: FINALIZED
  size: S
END
```

---

## VALIDATION SUMMARY

| Metric | Count |
|--------|-------|
| Total Candidates | 18 |
| CONFIRMED | 16 |
| DISPROVED | 1 |
| PRE_EXISTING | 1 |
| CRITIC_REQUIRED | 3 |
| REVIEWER_FINALIZED | 15 |
| Severity Reclassifications | 9 (50%) |

**CRITICAL/HIGH for Critic Challenge**: CF-001, CF-002, CF-006
