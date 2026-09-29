# Packaged Application Smoke Test Plan - Task 19.4

**Objective:** Verify packaged GUI application launches and functions correctly

**Test Environment:**
- Windows 10/11
- Packaged app: `dist/AFOMIS/AFOMIS.exe`
- Prerequisites: GGUF model in models/, sample documents

---

## Test 1: Application Launch
**Objective:** Verify executable launches without errors

**Steps:**
1. Navigate to `dist/AFOMIS/`
2. Double-click `AFOMIS.exe`
3. Wait for splash screen/main window

**Expected:**
- [ ] Application window opens within 10 seconds
- [ ] No error dialogs appear
- [ ] Title bar shows "AFOMIS" or "Document Q&A Assistant"

**Pass Criteria:** Window opens, no crash

---

## Test 2: Settings Dialog - GGUF Path
**Objective:** Verify GGUF model path setting works

**Steps:**
1. Click "Settings" button
2. Click "Browse" next to "GGUF Model Path"
3. Select a valid .gguf file from models/ directory
4. Click "Save"
5. Click "Yes" to restart engine

**Expected:**
- [ ] Settings dialog opens
- [ ] File browser opens
- [ ] Selected path appears in text field
- [ ] Save succeeds
- [ ] Engine reinitializes with selected model

**Pass Criteria:** Model path saved, engine uses GGUF

---

## Test 3: Document Ingestion
**Objective:** Verify folder ingestion works

**Steps:**
1. Click "Ingest" button
2. Select a folder containing test documents (.pdf, .txt)
3. Wait for processing

**Expected:**
- [ ] Directory picker opens
- [ ] Processing starts
- [ ] Progress indicator shows
- [ ] Completion message appears
- [ ] Documents listed in library

**Pass Criteria:** Documents ingested successfully

---

## Test 4: Question Answering
**Objective:** Verify RAG query works end-to-end

**Steps:**
1. Type question: "What is this document about?"
2. Press Enter or click "Ask"
3. Wait for response

**Expected:**
- [ ] Question accepted
- [ ] Thinking/progress indicator shows
- [ ] Answer appears in chat window
- [ ] Source citations shown

**Pass Criteria:** Answer generated with sources

---

## Test 5: Data Path Verification
**Objective:** Verify app uses correct packaged paths

**Steps:**
1. Check settings persistence
2. Close and reopen app
3. Verify settings saved

**Expected:**
- [ ] Settings persist between launches
- [ ] Data stored in correct location (not temp)
- [ ] No errors about missing paths

**Pass Criteria:** Correct path handling

---

## Smoke Test Results

| Test | Description | Status | Notes |
|------|-------------|--------|-------|
| 1 | Application Launch | ☐ PASS / ☐ FAIL | |
| 2 | Settings - GGUF Path | ☐ PASS / ☐ FAIL | |
| 3 | Document Ingestion | ☐ PASS / ☐ FAIL | |
| 4 | Question Answering | ☐ PASS / ☐ FAIL | |
| 5 | Data Path Verification | ☐ PASS / ☐ FAIL | |

**Overall Status:** ☐ PASS / ☐ FAIL

**Tested By:** _________________
**Date:** _________________
**Build Version:** _________________

**Notes:**
_________________________________
_________________________________
