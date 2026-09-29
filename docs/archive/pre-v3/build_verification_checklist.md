# Build Verification Checklist - Task 19.3

**Date:** 2026-03-11
**Build Command:** `build_exe.bat` (which runs `pyinstaller AFOMIS.spec --clean --noconfirm`)

## Pre-Build Verification

### 1. Environment Check
- [ ] Python 3.10+ installed
- [ ] Virtual environment activated (if used)
- [ ] All requirements installed: `pip install -r requirements.txt`
- [ ] PyInstaller installed: `pip install pyinstaller`

### 2. File Verification
- [ ] AFOMIS.spec exists and is current (engine_factory in hiddenimports)
- [ ] build_exe.bat exists and is executable
- [ ] All data directories exist:
  - [ ] bundled_models/bge-small-en-v1.5/
  - [ ] seed_data/chunks.json
  - [ ] models/*.gguf (at least one)
  - [ ] ui/ package directory

### 3. Clean Build Preparation
- [ ] Previous build/ directory removed: `rmdir /s /q build`
- [ ] Previous dist/ directory removed: `rmdir /s /q dist`
- [ ] Disk space check: Ensure ≥1GB free space
- [ ] Write permissions confirmed on target directory

### 4. Code Verification
- [ ] All Phase 15-18 fixes merged
- [ ] No syntax errors: `python -m py_compile *.py`
- [ ] Tests passing: `python -m pytest tests/ -x`

## Build Execution

**Command:**
```batch
build_exe.bat > build_exe.log 2>&1
echo Exit code: %ERRORLEVEL%
```

**Expected Duration:** 5-15 minutes depending on system

## Post-Build Verification

### 1. Build Output Check
- [ ] dist/AFOMIS/ directory created
- [ ] dist/AFOMIS/AFOMIS.exe exists
- [ ] Executable size: ~100-200MB (without models)
- [ ] No error messages in build_exe.log

### 2. Bundle Contents Verification
- [ ] bundled_models/ subdirectory present
- [ ] seed_data/ subdirectory present
- [ ] ui/ package included
- [ ] _internal/ directory with dependencies

### 3. Critical Files Present
- [ ] python3.dll or equivalent
- [ ] llama_cpp DLLs
- [ ] chromadb dependencies
- [ ] sentence_transformers data

## Build Log Template

See: `build_exe.log`

**Log should contain:**
- Timestamp start/end
- PyInstaller version info
- All hidden imports discovered
- Data files collected
- Binary dependencies collected
- Build completion status
- Any warnings or errors

## Failure Recovery

**If build fails:**
1. Check build_exe.log for error messages
2. Verify all prerequisites above
3. Check disk space
4. Try clean Python environment
5. Reinstall pyinstaller: `pip install --force-reinstall pyinstaller`

## Sign-Off

**Build Status:** ☐ PASS / ☐ FAIL
**Verified By:** _________________
**Date:** _________________
**Notes:** _________________
