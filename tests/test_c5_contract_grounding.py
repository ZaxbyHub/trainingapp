"""C5 (issue #72) contract pins for the grounding field.

contracts/api.openapi.yaml stays authoritative: grounding must be declared as
a REQUIRED string enum on QuestionResponse and on the stream DoneEvent, and
the old "reserved / not emitted yet" placeholder must be gone. Also pins the
Python response model to the same enum shape.
"""

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SPEC = REPO / "contracts" / "api.openapi.yaml"

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module")
def yaml_text() -> str:
    return SPEC.read_text(encoding="utf-8")


def test_grounding_is_a_required_string_enum_on_question_response(yaml_text: str):
    response = yaml_text[yaml_text.index("QuestionResponse:") :]
    response = response[: response.index("Citation:")]
    assert re.search(
        r"grounding:\n\s+type: string\n\s+enum: \[grounded, general\]", response
    )
    assert (
        "grounding"
        in response[response.index("required:") : response.index("properties:")]
    )


def test_grounding_is_required_on_the_stream_done_event(yaml_text: str):
    done = yaml_text[yaml_text.index("title: DoneEvent") :]
    done = done[: done.index("- type: object")]
    assert re.search(
        r"grounding:\n\s+type: string\n\s+enum: \[grounded, general\]", done
    )
    required = done[done.index("required:") : done.index("properties:")]
    assert "grounding" in required


def test_reservation_placeholder_is_gone(yaml_text: str):
    """The contract must no longer carry the pre-C5 reservation prose —
    this is the surviving sentinel for a #72 regression (the sweep predicate
    that keyed on the old text is retired by design)."""
    assert "Not emitted yet" not in yaml_text
    assert "RESERVED for WS-C #72" not in yaml_text


def test_wire_notes_document_the_emitted_field(yaml_text: str):
    notes = yaml_text[: yaml_text.index("servers:")]
    assert "Emitted field: `grounding`" in notes
    assert "C5 issue #72" in notes


def test_python_response_model_matches_the_contract_enum():
    from api_server import QuestionResponse

    field = QuestionResponse.model_fields.get("grounding")
    assert field is not None, "QuestionResponse must declare grounding"
    assert field.is_required()
    # Literal["grounded", "general"] constraint survives pydantic's metadata.
    annotated = str(field.annotation)
    assert "grounded" in annotated and "general" in annotated
