## Dark Matter: Hidden Couplings

Found 20 file pairs that frequently co-change but have no import relationship:

| File A | File B | NPMI | Co-Changes | Lift |
|--------|--------|------|------------|------|
| tests/integration/test_rag_engine_integration.py | tests/test_low_end_hardware.py | 1.000 | 4 | 85.50 |
| ARCHITECTURE.md | scripts/build_installer.py | 1.000 | 4 | 85.50 |
| INSTALL.md | build.py | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/app_gui.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/document_processor.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/llm_interface.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/main.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/rag_engine.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/utils.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | __pycache__/vector_store.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | doc_qa_db/chroma.sqlite3 | 1.000 | 3 | 114.00 |
| __pycache__/api_server.cpython-313.pyc | doc_qa_db/rag_config.json | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/document_processor.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/llm_interface.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/main.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/rag_engine.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/utils.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | __pycache__/vector_store.cpython-313.pyc | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | doc_qa_db/chroma.sqlite3 | 1.000 | 3 | 114.00 |
| __pycache__/app_gui.cpython-313.pyc | doc_qa_db/rag_config.json | 1.000 | 3 | 114.00 |

These pairs likely share an architectural concern invisible to static analysis.
Consider adding explicit documentation or extracting the shared concern.