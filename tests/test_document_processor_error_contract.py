"""
Error-contract tests for DocumentProcessor JSON handling of lone surrogates.

A .json file like {"note": "evil \\ud800 text"} is pure ASCII on disk, but
json.loads materializes the \\ud800 escape into a REAL lone surrogate code
point in the returned str. That string cannot be encoded to UTF-8, so the
poison only detonates later at the sqlite bind in VectorStore.add_chunks
(production symptom: HTTP 500 from POST /ingest).

Contract under test: extraction refuses such a document with a typed error
instead of returning poisoned text, and the directory route reports a typed
refusal for the evil file rather than passing poisoned chunks downstream.
"""

import logging

import pytest

from document_processor import DocumentProcessor

# Pure-ASCII on-disk JSON whose \\ud800 escape json.loads materializes into a
# real lone surrogate. Written with a doubled backslash so the FILE receives
# the literal 6-character escape sequence, not the decoded code point.
EVIL_JSON = '{"note": "evil \\ud800 text"}'
GOOD_JSON = '{"note": "cafe text"}'


def test_extract_json_refuses_lone_surrogate_text(tmp_path):
    """extract_json_document must refuse surrogate-bearing text with ValueError."""
    path = tmp_path / "evil.json"
    data = EVIL_JSON.encode("ascii")
    assert all(b < 128 for b in data), "fixture file must be pure ASCII on disk"
    path.write_bytes(data)

    processor = DocumentProcessor()

    with pytest.raises(ValueError):
        processor.extract_json_document(str(path))

    assert processor.process_file(str(path)) == []


def test_directory_route_reports_typed_refusal_not_store_failure(tmp_path, caplog):
    """process_directory must log a typed ERROR refusal, never emit poisoned chunks."""
    (tmp_path / "evil.json").write_bytes(EVIL_JSON.encode("ascii"))
    (tmp_path / "good.json").write_text(GOOD_JSON, encoding="utf-8")

    processor = DocumentProcessor()
    with caplog.at_level(logging.ERROR, logger="document_processor"):
        chunks = processor.process_directory(str(tmp_path))

    for chunk in chunks:
        chunk.text.encode("utf-8")

    sources = {chunk.source for chunk in chunks}
    assert "good.json" in sources, "legitimate JSON must still be ingested"

    refusals = [
        record
        for record in caplog.records
        if record.levelno >= logging.ERROR and "evil.json" in record.getMessage()
    ]
    assert refusals, (
        "expected an ERROR-level refusal record naming evil.json; "
        f"captured log was:\n{caplog.text}"
    )
