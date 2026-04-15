## Dark Matter: Hidden Couplings

Found 20 file pairs that frequently co-change but have no import relationship:

| File A | File B | NPMI | Co-Changes | Lift |
|--------|--------|------|------------|------|
| README.md | document_processor.py | 1.000 | 3 | 17.00 |
| README.md | test_phase1_adversarial.py | 1.000 | 3 | 17.00 |
| app_paths.py | seed_loader.py | 1.000 | 3 | 17.00 |
| document_processor.py | test_phase1_adversarial.py | 1.000 | 3 | 17.00 |
| llm_interface.py | main.py | 1.000 | 4 | 12.75 |
| llm_interface.py | vector_store.py | 1.000 | 4 | 12.75 |
| main.py | vector_store.py | 1.000 | 4 | 12.75 |
| api_server.py | rag_engine.py | 0.912 | 4 | 10.20 |
| llm_interface.py | rag_engine.py | 0.912 | 4 | 10.20 |
| main.py | rag_engine.py | 0.912 | 4 | 10.20 |
| rag_engine.py | vector_store.py | 0.912 | 4 | 10.20 |
| README.md | api_server.py | 0.898 | 3 | 12.75 |
| api_server.py | document_processor.py | 0.898 | 3 | 12.75 |
| api_server.py | test_phase1_adversarial.py | 0.898 | 3 | 12.75 |
| api_server.py | tests/test_llm_interface.py | 0.898 | 3 | 12.75 |
| api_server.py | tests/test_rag_engine.py | 0.898 | 3 | 12.75 |
| app_paths.py | llm_interface.py | 0.898 | 3 | 12.75 |
| app_paths.py | main.py | 0.898 | 3 | 12.75 |
| app_paths.py | vector_store.py | 0.898 | 3 | 12.75 |
| llm_interface.py | seed_loader.py | 0.898 | 3 | 12.75 |

These pairs likely share an architectural concern invisible to static analysis.
Consider adding explicit documentation or extracting the shared concern.