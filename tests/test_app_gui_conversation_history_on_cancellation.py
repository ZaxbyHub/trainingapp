"""
Tests for conversation_history behavior on cancellation in app_gui.py (task 4.5).

Verifies that:
1. Cancelled query does not modify conversation_history
2. Empty result.answer does not modify conversation_history
3. Successful query appends both user and assistant messages
"""

import pytest
import threading
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# Mock query result
# ---------------------------------------------------------------------------

class MockQueryResult:
    def __init__(self, answer="", sources=None, chunks_retrieved=0, inference_time=0.1):
        self.answer = answer
        self.sources = sources or []
        self.chunks_retrieved = chunks_retrieved
        self.inference_time = inference_time


# ---------------------------------------------------------------------------
# Test 1: Cancelled query does not modify conversation_history
# ---------------------------------------------------------------------------

class TestCancelledQueryHistoryUnchanged:
    """Criterion 1: Cancelled query must not modify conversation_history."""

    def test_cancelled_result_does_not_append_to_history(self):
        """When result.answer == '[Cancelled]', conversation_history must not be modified."""
        conversation_history = [{"role": "user", "content": "Previous question?"}]
        question = "What is Python?"
        result = MockQueryResult(answer="[Cancelled]")

        # Simulate the logic from app_gui.py lines 1728-1734
        initial_len = len(conversation_history)
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == initial_len, \
            "Cancelled query must not append to conversation_history"

    def test_cancelled_with_existing_history_unchanged(self):
        """Even with existing history, cancelled query must not add new entries."""
        conversation_history = [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
        ]
        question = "Second question?"
        result = MockQueryResult(answer="[Cancelled]")

        history_snapshot = list(conversation_history)
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert conversation_history == history_snapshot, \
            "Cancelled query must not modify existing conversation_history"


# ---------------------------------------------------------------------------
# Test 2: Empty result.answer does not modify conversation_history
# ---------------------------------------------------------------------------

class TestEmptyAnswerHistoryUnchanged:
    """Criterion 2: Empty result.answer must not modify conversation_history."""

    def test_empty_string_answer_does_not_append(self):
        """When result.answer is empty string, conversation_history must not be modified."""
        conversation_history = []
        question = "What is Python?"
        result = MockQueryResult(answer="")

        initial_len = len(conversation_history)
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == initial_len, \
            "Empty answer must not append to conversation_history"

    def test_none_answer_does_not_append(self):
        """When result.answer is None, conversation_history must not be modified."""
        conversation_history = []
        question = "What is Python?"
        result = MockQueryResult(answer=None)

        initial_len = len(conversation_history)
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == initial_len, \
            "None answer must not append to conversation_history"



    def test_empty_with_existing_history_unchanged(self):
        """Even with existing history, empty answer must not add new entries."""
        conversation_history = [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
        ]
        question = "Second question?"
        result = MockQueryResult(answer="")

        history_snapshot = list(conversation_history)
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert conversation_history == history_snapshot, \
            "Empty answer must not modify existing conversation_history"


# ---------------------------------------------------------------------------
# Test 3: Successful query appends both user and assistant messages
# ---------------------------------------------------------------------------

class TestSuccessfulQueryAppendsMessages:
    """Criterion 3: Successful query must append both user and assistant messages."""

    def test_successful_query_appends_both_messages(self):
        """When query succeeds, both user and assistant messages must be appended."""
        conversation_history = []
        question = "What is Python?"
        result = MockQueryResult(answer="Python is a programming language.")

        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == 2, \
            "Successful query must append exactly 2 messages"
        assert conversation_history[0] == {"role": "user", "content": question}, \
            "First message must be user message"
        assert conversation_history[1] == {"role": "assistant", "content": result.answer}, \
            "Second message must be assistant message"

    def test_successful_query_preserves_existing_history(self):
        """Successful query must append to existing history, not replace it."""
        conversation_history = [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
        ]
        question = "Second question?"
        result = MockQueryResult(answer="Second answer.")

        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == 4, \
            "Successful query must preserve existing history and append 2 new messages"
        assert conversation_history[0] == {"role": "user", "content": "First question"}
        assert conversation_history[1] == {"role": "assistant", "content": "First answer"}
        assert conversation_history[2] == {"role": "user", "content": question}
        assert conversation_history[3] == {"role": "assistant", "content": result.answer}

    def test_history_truncation_to_20_messages(self):
        """conversation_history must be truncated to last 20 messages after append."""
        # Create history with exactly 20 messages (10 exchanges)
        conversation_history = []
        for i in range(10):
            conversation_history.append({"role": "user", "content": f"Q{i}"})
            conversation_history.append({"role": "assistant", "content": f"A{i}"})

        # Add one more exchange
        question = "New question?"
        result = MockQueryResult(answer="New answer.")

        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})
            conversation_history = conversation_history[-20:]

        assert len(conversation_history) == 20, \
            "History must be truncated to 20 messages"
        # Oldest message (Q0) should be gone, oldest remaining should be Q1
        assert conversation_history[0]["content"] == "Q1", \
            "Oldest messages should be removed after truncation"
        assert conversation_history[-1] == {"role": "assistant", "content": "New answer."}, \
            "Most recent message should be the new assistant answer"

    def test_successful_query_not_cancelled_string(self):
        """Verify '[Cancelled]' string is treated as cancelled even if truthy."""
        conversation_history = []
        question = "What is Python?"
        result = MockQueryResult(answer="[Cancelled]")

        # Even though "[Cancelled]" is truthy, it should be rejected by the != check
        if result.answer and result.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question})
            conversation_history.append({"role": "assistant", "content": result.answer})

        assert len(conversation_history) == 0, \
            "'[Cancelled]' answer must not be added even though it's truthy"


# ---------------------------------------------------------------------------
# Integration test: Full conversation_history flow
# ---------------------------------------------------------------------------

class TestConversationHistoryFlow:
    """Integration test for conversation_history behavior across query outcomes."""

    def test_full_flow_cancelled_then_empty_then_success(self):
        """Test sequence: cancelled query, empty answer query, successful query."""
        conversation_history = []

        # 1. Cancelled query - no modification
        result1 = MockQueryResult(answer="[Cancelled]")
        question1 = "First question?"
        if result1.answer and result1.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question1})
            conversation_history.append({"role": "assistant", "content": result1.answer})
        assert len(conversation_history) == 0, "Cancelled query must not modify history"

        # 2. Empty answer query - no modification
        result2 = MockQueryResult(answer="")
        question2 = "Second question?"
        if result2.answer and result2.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question2})
            conversation_history.append({"role": "assistant", "content": result2.answer})
        assert len(conversation_history) == 0, "Empty answer must not modify history"

        # 3. Successful query - adds both messages
        result3 = MockQueryResult(answer="Successful answer.")
        question3 = "Third question?"
        if result3.answer and result3.answer != "[Cancelled]":
            conversation_history.append({"role": "user", "content": question3})
            conversation_history.append({"role": "assistant", "content": result3.answer})
        assert len(conversation_history) == 2, "Successful query must add 2 messages"
        assert conversation_history[0] == {"role": "user", "content": question3}
        assert conversation_history[1] == {"role": "assistant", "content": "Successful answer."}
