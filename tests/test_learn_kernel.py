"""Unit tests for the learn[] kernel (issue #82, D6).

Selector names are FROZEN acceptance-check anchors (repro checks C3/C4/C5
match -k union_dedup_rank / learn_cap / grounding_general); do not rename.
"""

from learn_panel import MAX_LEARN_RESULTS, build_learn_results, slide_id_from_name


def _chunk(source_path=None, source_display=None, score=0.5, snippet=None, **extra):
    entry = {
        "source_display": source_display or (source_path or "doc.md"),
        "doc_id": extra.pop("doc_id", "d0"),
        "source_path": source_path,
        "page": None,
        "chunk_index": 0,
        "snippet": snippet if snippet is not None else "plain text",
        "score": score,
    }
    entry.update(extra)
    return entry


MARKER = (
    "[training-slide] section=Course Introduction | title=Welcome "
    "| slide_id=5rN4PvXJM5d"
)


class Test_union_dedup_rank:
    def test_direct_and_linked_same_slide_appear_once_with_direct_and_higher_score(
        self,
    ):
        direct = _chunk(
            source_path="/pack/docs/slide-001-5rN4PvXJM5d.json",
            score=0.91,
            snippet=MARKER + "\nStart\nOpMed CDP MicroLearning Companion",
        )
        linked_from_other = _chunk(
            source_path="/corpus/travel-policy.md",
            score=0.80,
        )

        def links_lookup(entry):
            if entry is linked_from_other:
                return [("5rN4PvXJM5d", 0.62, "Welcome", "Course Introduction", None)]
            return []

        learn = build_learn_results(
            [direct, linked_from_other], links_lookup=links_lookup
        )

        assert len(learn) == 1
        result = learn[0]
        assert result["slide_id"] == "5rN4PvXJM5d"
        assert result["reason"] == "direct"
        assert result["score"] == 0.91
        assert result["title"] == "Welcome"
        assert result["section"] == "Course Introduction"
        assert result["snippet"].startswith("Start")

    def test_ranked_descending_and_linked_results_present(self):
        chunks = [
            _chunk(source_path="/c/policy.md", score=0.30),
            _chunk(
                source_path="/pack/docs/slide-002-6RdggQhakWc.json",
                score=0.75,
                snippet=(
                    "[training-slide] section=Section A | title=Slide B"
                    " | slide_id=6RdggQhakWc\nbody two"
                ),
            ),
        ]

        def links_lookup(entry):
            if entry["source_path"] == "/c/policy.md":
                return [
                    (
                        "5rN4PvXJM5d",
                        0.90,
                        "Welcome",
                        "Course Introduction",
                        "Start here",
                    ),
                    ("9dNpYzSa6Kr", 0.40, None, None, None),
                ]
            return []

        learn = build_learn_results(chunks, links_lookup=links_lookup)
        assert [r["slide_id"] for r in learn] == [
            "5rN4PvXJM5d",
            "6RdggQhakWc",
            "9dNpYzSa6Kr",
        ]
        assert learn[0]["reason"] == "linked"
        assert learn[1]["reason"] == "direct"

    def test_equal_score_prefers_direct(self):
        chunks = [_chunk(source_path="/c/policy.md", score=0.5)]

        def links_lookup(entry):
            return [("5rN4PvXJM5d", 0.5, "Linked Title", "S", None)]

        learn = build_learn_results(
            chunks
            + [_chunk(source_path="/p/docs/slide-001-5rN4PvXJM5d.json", score=0.5)],
            links_lookup=links_lookup,
        )
        assert len(learn) == 1
        assert learn[0]["reason"] == "direct"

    def test_non_slide_chunks_without_links_yield_empty(self):
        assert (
            build_learn_results([_chunk(source_path="/c/handbook.md", score=0.9)]) == []
        )
        assert build_learn_results([]) == []

    def test_slide_id_from_name(self):
        assert slide_id_from_name("/x/docs/slide-001-5rN4PvXJM5d.json") == "5rN4PvXJM5d"
        assert slide_id_from_name("slide-12-abc.json") == "abc"
        assert slide_id_from_name("handbook.md") is None
        assert slide_id_from_name(None) is None


class Test_learn_cap:
    def test_more_candidates_than_max_are_truncated(self):
        chunks = [_chunk(source_path="/c/policy.md", score=0.9)]

        def links_lookup(entry):
            return [
                (f"slide{i:02d}abcd", 0.5 - i * 0.01, None, None, None)
                for i in range(8)
            ]

        learn = build_learn_results(chunks, links_lookup=links_lookup)
        assert len(learn) <= MAX_LEARN_RESULTS
        assert len(learn) == MAX_LEARN_RESULTS
        scores = [r["score"] for r in learn]
        assert scores == sorted(scores, reverse=True)

    def test_custom_max_results(self):
        chunks = [_chunk(source_path="/c/policy.md", score=0.9)]

        def links_lookup(entry):
            return [(f"s{i}", 0.5, None, None, None) for i in range(4)]

        assert (
            len(build_learn_results(chunks, links_lookup=links_lookup, max_results=2))
            == 2
        )


class Test_grounding_general:
    def test_general_grounding_suppresses_all_results(self):
        chunks = [
            _chunk(source_path="/pack/docs/slide-001-5rN4PvXJM5d.json", score=0.95),
            _chunk(source_path="/c/policy.md", score=0.5),
        ]

        def links_lookup(entry):
            return [("5rN4PvXJM5d", 0.9, None, None, None)]

        learn = build_learn_results(
            chunks, grounding="general", links_lookup=links_lookup
        )
        assert learn == []

    def test_grounded_grounding_keeps_results(self):
        chunks = [
            _chunk(source_path="/pack/docs/slide-001-5rN4PvXJM5d.json", score=0.95)
        ]
        learn = build_learn_results(chunks, grounding="grounded")
        assert len(learn) == 1
        assert learn[0]["reason"] == "direct"

    def test_absent_grounding_keeps_results(self):
        chunks = [
            _chunk(source_path="/pack/docs/slide-001-5rN4PvXJM5d.json", score=0.95)
        ]
        assert len(build_learn_results(chunks)) == 1
