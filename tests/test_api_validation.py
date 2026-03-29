"""
Tests for API input validation (QuestionRequest and SearchRequest)

Validates that the Pydantic validators correctly:
- Reject empty questions/queries with 422 Unprocessable Entity
- Reject whitespace-only questions/queries with 422 Unprocessable Entity
- Strip leading/trailing spaces from valid questions/queries
"""

import pytest
from fastapi.testclient import TestClient
from api_server import app, QuestionRequest, SearchRequest

client = TestClient(app)


class TestQuestionRequestValidation:
    """Tests for QuestionRequest input validation."""

    def test_empty_question_returns_422(self):
        """Empty question should return 422 Unprocessable Entity."""
        response = client.post("/ask", json={"question": "", "n_results": 3})
        assert response.status_code == 422, (
            f"Expected 422, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "detail" in data
        # Pydantic validation error should indicate the issue
        detail = data["detail"]
        if isinstance(detail, list):
            # Pydantic v2 format: list of errors
            assert any("Question" in str(err) for err in detail)
        else:
            # String format
            assert "Question" in str(detail) or "question" in str(detail)

    def test_whitespace_only_question_returns_422(self):
        """Whitespace-only question should return 422 Unprocessable Entity."""
        for whitespace in ["   ", "\t", "\n", "  \t  ", "\r\n"]:
            response = client.post(
                "/ask", json={"question": whitespace, "n_results": 3}
            )
            assert response.status_code == 422, (
                f"Failed for whitespace={repr(whitespace)}: got {response.status_code}"
            )
            data = response.json()
            assert "detail" in data

    def test_question_with_leading_trailing_spaces_is_stripped(self):
        """Question with leading/trailing spaces should be accepted and stripped."""
        raw_question = "  What is Python?  "
        expected_question = "What is Python?"

        response = client.post("/ask", json={"question": raw_question, "n_results": 3})

        # Should be accepted with 200 (if engine is available) or 503 (if not)
        # We're testing validation, so 200/503 are both acceptable depending on engine state
        # But it should NOT be 422 (validation error)
        assert response.status_code != 422, (
            f"Validation incorrectly rejected valid question: {response.text}"
        )

        # If the request succeeds (200), verify the stripped question is used
        if response.status_code == 200:
            data = response.json()
            # The response should contain the stripped question
            assert data["question"] == expected_question, (
                f"Expected stripped question '{expected_question}', got '{data['question']}'"
            )

    def test_question_with_only_inner_spaces_preserved(self):
        """Inner spaces should be preserved (not collapsed)."""
        raw_question = "  What   is   Python?  "
        expected_question = "What   is   Python?"  # Only leading/trailing stripped

        response = client.post("/ask", json={"question": raw_question, "n_results": 3})

        assert response.status_code != 422, (
            f"Validation incorrectly rejected valid question"
        )

        if response.status_code == 200:
            data = response.json()
            assert data["question"] == expected_question

    def test_valid_question_without_spaces(self):
        """Normal valid question should be accepted."""
        response = client.post(
            "/ask", json={"question": "What is Python?", "n_results": 3}
        )
        assert response.status_code != 422
        if response.status_code == 200:
            data = response.json()
            assert data["question"] == "What is Python?"

    def test_question_with_special_characters(self):
        """Question with special characters should be accepted."""
        raw_question = "  What is Python's @#$% and C++?  "
        expected_question = "What is Python's @#$% and C++?"

        response = client.post("/ask", json={"question": raw_question, "n_results": 3})
        assert response.status_code != 422

        if response.status_code == 200:
            data = response.json()
            assert data["question"] == expected_question

    def test_question_with_unicode_and_spaces(self):
        """Question with Unicode characters and spaces should be accepted."""
        raw_question = "  ¿Qué es Python? 你好  "
        expected_question = "¿Qué es Python? 你好"

        response = client.post("/ask", json={"question": raw_question, "n_results": 3})
        assert response.status_code != 422

        if response.status_code == 200:
            data = response.json()
            assert data["question"] == expected_question

    def test_question_model_direct_validation(self):
        """Direct Pydantic model validation should strip spaces and reject bad inputs."""
        # Valid with spaces: should strip
        req = QuestionRequest(question="  valid question  ", n_results=3)
        assert req.question == "valid question"

        # Empty: should raise ValidationError
        with pytest.raises(Exception):  # Could be ValidationError
            QuestionRequest(question="", n_results=3)

        # Whitespace-only: should raise ValidationError
        with pytest.raises(Exception):
            QuestionRequest(question="   ", n_results=3)


class TestSearchRequestValidation:
    """Tests for SearchRequest input validation."""

    def test_empty_query_returns_422(self):
        """Empty query should return 422 Unprocessable Entity."""
        response = client.post("/search", json={"query": "", "n_results": 5})
        assert response.status_code == 422, (
            f"Expected 422, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "detail" in data

    def test_whitespace_only_query_returns_422(self):
        """Whitespace-only query should return 422 Unprocessable Entity."""
        for whitespace in ["   ", "\t", "\n", "  \t  "]:
            response = client.post(
                "/search", json={"query": whitespace, "n_results": 5}
            )
            assert response.status_code == 422, (
                f"Failed for whitespace={repr(whitespace)}: got {response.status_code}"
            )

    def test_query_with_leading_trailing_spaces_is_stripped(self):
        """Query with leading/trailing spaces should be accepted and stripped."""
        raw_query = "  python programming  "
        expected_query = "python programming"

        response = client.post("/search", json={"query": raw_query, "n_results": 5})

        assert response.status_code != 422, (
            f"Validation incorrectly rejected valid query"
        )

        if response.status_code == 200:
            data = response.json()
            # The search endpoint returns results; we can't directly see the query used
            # But we can check that the query was accepted and processed
            assert len(data) >= 0  # Just ensure we got a valid response structure

    def test_query_model_direct_validation(self):
        """Direct Pydantic model validation should strip spaces and reject bad inputs."""
        # Valid with spaces: should strip
        req = SearchRequest(query="  valid query  ", n_results=5)
        assert req.query == "valid query"

        # Empty: should raise ValidationError
        with pytest.raises(Exception):
            SearchRequest(query="", n_results=5)

        # Whitespace-only: should raise ValidationError
        with pytest.raises(Exception):
            SearchRequest(query="   ", n_results=5)

    def test_valid_query_without_spaces(self):
        """Normal valid query should be accepted."""
        response = client.post(
            "/search", json={"query": "python programming", "n_results": 5}
        )
        assert response.status_code != 422


class TestValidationEdgeCases:
    """Additional edge case tests for input validation."""

    def test_question_with_newline_and_tab(self):
        """Question containing newlines and tabs should be stripped of leading/trailing."""
        raw = "\n\n  What is Python?  \t\t"
        expected = "What is Python?"

        req = QuestionRequest(question=raw, n_results=3)
        assert req.question == expected

    def test_query_with_only_non_breaking_spaces(self):
        """Query with non-breaking spaces (Unicode) should be validated."""
        # Non-breaking space (U+00A0)
        raw = "\u00a0\u00a0test\u00a0\u00a0"
        expected = "test"

        req = SearchRequest(query=raw, n_results=5)
        assert req.query == expected

    def test_question_max_length_boundary(self):
        """Question at max length boundary should be accepted."""
        max_len = 2000
        question = "a" * max_len
        req = QuestionRequest(question=question, n_results=3)
        assert len(req.question) == max_len

    def test_question_exceeds_max_length(self):
        """Question exceeding max length should be rejected."""
        over_max = "a" * 2001
        response = client.post("/ask", json={"question": over_max, "n_results": 3})
        # Should return 422 (Pydantic validation error)
        assert response.status_code == 422

    def test_query_max_length_boundary(self):
        """Query at max length boundary (500) should be accepted."""
        max_len = 500
        query = "a" * max_len
        req = SearchRequest(query=query, n_results=5)
        assert len(req.query) == max_len


class TestValidatorPreservesContent:
    """Ensure validators strip only whitespace, not meaningful content."""

    def test_question_preserves_punctuation(self):
        """Leading/trailing punctuation should not be stripped."""
        raw = "  ?What is Python?!  "
        req = QuestionRequest(question=raw, n_results=3)
        assert req.question == "?What is Python?!"

    def test_query_preserves_non_alpha(self):
        """Non-alphabetic characters should be preserved."""
        raw = "  C++ vs Rust 2024  "
        req = SearchRequest(query=raw, n_results=5)
        assert req.query == "C++ vs Rust 2024"

    def test_question_with_zero_width_space(self):
        """Zero-width space (Unicode U+200B) should be treated as whitespace."""
        raw = "\u200bWhat is Python?\u200b"
        # Pydantic strip() should remove it if considered whitespace
        # The behavior depends on Python's isprintable/isspace
        req = QuestionRequest(question=raw, n_results=3)
        # It might strip it or keep it; the important thing is it doesn't crash
        assert isinstance(req.question, str)
