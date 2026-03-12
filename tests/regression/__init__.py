"""
Regression test suite for confirmed defects.

This package contains regression tests for confirmed defects that have
been identified but not yet fixed. All tests are marked with @pytest.mark.xfail
to indicate they are expected to fail until the defects are resolved.

Test Files:
- test_defect_001_gui_gguf_wiring.py: GUI GGUF path parameter wiring
- test_defect_002_api_gguf_env.py: API server RAG_GGUF_PATH environment variable
- test_defect_003_url_validation.py: URL validation for localhost/private IPs
- test_defect_004_upload_source.py: Upload filename preservation
- test_defect_005_upload_mismatch.py: GUI/API upload capability alignment
- test_defect_006_build_path.py: Build configuration and entry points

Usage:
    # Run all regression tests (expected to fail)
    pytest tests/regression/ -v
    
    # Run specific defect tests
    pytest tests/regression/test_defect_001_gui_gguf_wiring.py -v
    
    # Run with xfail_strict to ensure failures are documented
    pytest tests/regression/ --xfail-strict -v
"""

import pytest

# Mark all tests in this package as regression tests
pytestmark = pytest.mark.regression
