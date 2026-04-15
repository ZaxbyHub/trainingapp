import logging
import re


def test_no_print_in_document_processor():
    """FR-602/603: document_processor.py must have zero print() calls."""
    import document_processor
    with open(document_processor.__file__, "r") as f:
        source = f.read()
    print_calls = re.findall(r'^\s*print\(', source, re.MULTILINE)
    assert len(print_calls) == 0, f"Found {len(print_calls)} print() calls"


def test_module_logger_exists():
    """document_processor.py must have module-level logger."""
    import document_processor
    assert hasattr(document_processor, 'logger')
    assert isinstance(document_processor.logger, logging.Logger)
