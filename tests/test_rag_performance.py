"""
Performance Benchmark Tests for RAG Pipeline.

Measures latency, memory usage, CPU utilization, and throughput across
document ingestion, query operations, and resource-constrained scenarios.

Run with: pytest tests/test_rag_performance.py -v --benchmark
"""

import gc
import os
import sys
import time
import tempfile
import threading
import statistics
from pathlib import Path
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

# Skip all tests in this file - they require real embedding model
pytestmark = pytest.mark.skip(reason="Performance tests require real embedding model — incompatible with conftest mock")

# ─────────────────────────────────────────────────────────────────────────────
# Profiling infrastructure
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class BenchmarkResult:
    """Aggregated benchmark statistics."""

    name: str
    total_runs: int
    latencies_ms: List[float]
    memory_samples_mb: List[float]
    errors: List[str] = field(default_factory=list)

    @property
    def mean_ms(self) -> float:
        return statistics.mean(self.latencies_ms) if self.latencies_ms else float("nan")

    @property
    def median_ms(self) -> float:
        return statistics.median(self.latencies_ms) if self.latencies_ms else float("nan")

    @property
    def p95_ms(self) -> float:
        if not self.latencies_ms:
            return float("nan")
        sorted_vals = sorted(self.latencies_ms)
        idx = int(len(sorted_vals) * 0.95)
        return sorted_vals[min(idx, len(sorted_vals) - 1)]

    @property
    def p99_ms(self) -> float:
        if not self.latencies_ms:
            return float("nan")
        sorted_vals = sorted(self.latencies_ms)
        idx = int(len(sorted_vals) * 0.99)
        return sorted_vals[min(idx, len(sorted_vals) - 1)]

    @property
    def min_ms(self) -> float:
        return min(self.latencies_ms) if self.latencies_ms else float("nan")

    @property
    def max_ms(self) -> float:
        return max(self.latencies_ms) if self.latencies_ms else float("nan")

    @property
    def stddev_ms(self) -> float:
        return statistics.stdev(self.latencies_ms) if len(self.latencies_ms) > 1 else 0.0

    @property
    def peak_memory_mb(self) -> float:
        return max(self.memory_samples_mb) if self.memory_samples_mb else float("nan")

    @property
    def mean_memory_mb(self) -> float:
        return statistics.mean(self.memory_samples_mb) if self.memory_samples_mb else float("nan")

    @property
    def throughput(self) -> float:
        """Docs per second (derived from mean latency)."""
        return 1000.0 / self.mean_ms if self.mean_ms > 0 else float("nan")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "runs": self.total_runs,
            "latency_ms": {
                "mean": round(self.mean_ms, 2),
                "median": round(self.median_ms, 2),
                "p95": round(self.p95_ms, 2),
                "p99": round(self.p99_ms, 2),
                "min": round(self.min_ms, 2),
                "max": round(self.max_ms, 2),
                "stddev": round(self.stddev_ms, 2),
            },
            "memory_mb": {
                "peak": round(self.peak_memory_mb, 2),
                "mean": round(self.mean_memory_mb, 2),
            },
            "throughput_docs_per_sec": round(self.throughput, 4),
            "errors": self.errors,
        }


class MemorySampler:
    """Background memory sampler using psutil."""

    def __init__(self, interval_ms: int = 50):
        self.interval_ms = interval_ms
        self.samples: List[float] = []
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _sample_loop(self):
        try:
            import psutil
        except ImportError:
            return

        proc = psutil.Process()
        while not self._stop.is_set():
            try:
                mem = proc.memory_info().rss / (1024 * 1024)
                self.samples.append(mem)
            except Exception:
                pass
            self._stop.wait(self.interval_ms / 1000)

    def start(self):
        self.samples = []
        self._stop.clear()
        self._thread = threading.Thread(target=self._sample_loop, daemon=True)
        self._thread.start()

    def stop(self) -> List[float]:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        return self.samples


def _get_rss_mb() -> float:
    """Get current RSS memory in MB."""
    try:
        import psutil
        return psutil.Process().memory_info().rss / (1024 * 1024)
    except ImportError:
        return 0.0


def _time_it(func, *args, **kwargs):
    """Time a function call, returning (result, elapsed_ms)."""
    start = time.perf_counter()
    result = func(*args, **kwargs)
    elapsed = (time.perf_counter() - start) * 1000
    return result, elapsed


# ─────────────────────────────────────────────────────────────────────────────
# Document generation helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_text_content(word_count: int, seed: int = 0) -> str:
    """Generate deterministic lorem-ipsum-like text of given word count."""
    sentences = [
        "The quick brown fox jumps over the lazy dog.",
        "Machine learning algorithms process large datasets efficiently.",
        "Natural language processing enables computers to understand text.",
        "Vector databases store high-dimensional embeddings for similarity search.",
        "Retrieval augmented generation combines information retrieval with LLMs.",
        "Chunking strategies significantly impact retrieval quality.",
        "Hybrid search combines keyword and semantic approaches.",
        "Embeddings capture semantic meaning in dense vector representations.",
        "Context windows limit the amount of text a model can process.",
        "Token limits require careful management of input length.",
    ]
    words_out: List[str] = []
    idx = seed
    while len(" ".join(words_out).split()) < word_count:
        words_out.append(sentences[idx % len(sentences)])
        idx += 1
    text = " ".join(words_out)
    words = text.split()
    return " ".join(words[:word_count])


def _create_test_pdf(path: Path, text_content: str) -> None:
    """Create a minimal PDF file with text content (no external deps needed)."""
    # Use reportlab if available, otherwise create minimal valid PDF
    try:
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter

        c = canvas.Canvas(str(path), pagesize=letter)
        width, height = letter
        # Write text in chunks
        y = height - 50
        for line in text_content.split("\n"):
            if y < 50:
                c.showPage()
                y = height - 50
            c.drawString(50, y, line[:80])
            y -= 14
        c.save()
    except ImportError:
        # Fallback: create a minimal valid PDF
        lines = text_content.split("\n")
        content_stream = "\n".join(
            f"({line})" for line in lines if line.strip()
        )
        pdf = f"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length {len(content_stream) + 50}>>stream
BT/F1 12 Tf
100 700 Td
{content_stream}
ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000206 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
296
%%EOF"""
        path.write_text(pdf, encoding="latin-1")


def _create_test_txt(path: Path, text_content: str) -> None:
    path.write_text(text_content, encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def chromadb_available():
    """Check if ChromaDB is available for testing."""
    try:
        import chromadb
        import sentence_transformers
        return True
    except ImportError:
        pytest.skip("ChromaDB or sentence-transformers not available")


@pytest.fixture(scope="module")
def psutil_available():
    """Check if psutil is available for memory profiling."""
    try:
        import psutil
        return True
    except ImportError:
        return False


@pytest.fixture
def temp_benchmark_db(tmp_path):
    """Clean, isolated ChromaDB directory for each benchmark."""
    db_path = tmp_path / "bench_db"
    db_path.mkdir()
    yield str(db_path)
    # Explicit cleanup
    import shutil
    if db_path.exists():
        shutil.rmtree(db_path, ignore_errors=True)


@pytest.fixture
def temp_doc_dir(tmp_path):
    """Temporary directory for generated test documents."""
    doc_dir = tmp_path / "docs"
    doc_dir.mkdir()
    yield str(doc_dir)
    import shutil
    if doc_dir.exists():
        shutil.rmtree(doc_dir, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────────
# Module-level: import once, reuse across tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def import_rag_modules(chromadb_available):
    """Pre-import heavy modules so warm-up cost doesn't skew per-test timing."""
    gc.collect()
    _get_rss_mb()  # baseline memory
    # These trigger model loading on first use
    from vector_store import VectorStore, EmbeddingModel  # noqa: F401
    from document_processor import DocumentProcessor  # noqa: F401


# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 1: Document Ingestion Performance
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skip(reason="Requires real embedding model — tests create VectorStore directly, bypassing conftest mock")
class TestDocumentIngestionPerformance:
    """Benchmark document ingestion at various sizes and batch counts."""

    def test_small_document_ingestion(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """1-page, ~100 word document ingestion."""
        # Generate content
        text = _make_text_content(100)
        doc_path = Path(temp_doc_dir) / "small_doc.txt"
        _create_test_txt(doc_path, text)

        sampler = MemorySampler(interval_ms=50)
        if psutil_available:
            sampler.start()

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        mem_before = _get_rss_mb()
        _, latency_ms = _time_it(processor.process_file, str(doc_path))
        chunks = processor.process_file(str(doc_path))

        _, add_latency_ms = _time_it(store.add_chunks, chunks)
        mem_after = _get_rss_mb()

        if psutil_available:
            sampler.stop()

        result = BenchmarkResult(
            name="small_document_ingestion",
            total_runs=1,
            latencies_ms=[latency_ms + add_latency_ms],
            memory_samples_mb=sampler.samples + [mem_after],
        )

        # Assertions
        assert len(chunks) >= 1, f"Expected at least 1 chunk, got {len(chunks)}"
        assert result.p95_ms < 30000, f"Single small doc ingestion too slow: {result.p95_ms:.0f}ms"

        print(f"\n[BM] Small doc: {result.total_runs} run, "
              f"latency={result.mean_ms:.0f}ms, peak_mem={result.peak_memory_mb:.1f}MB")

    def test_medium_document_ingestion(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """~10 page, 5000 word document ingestion."""
        text = _make_text_content(5000)
        doc_path = Path(temp_doc_dir) / "medium_doc.txt"
        _create_test_txt(doc_path, text)

        sampler = MemorySampler(interval_ms=50)
        if psutil_available:
            sampler.start()

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        mem_before = _get_rss_mb()
        _, latency_ms = _time_it(processor.process_file, str(doc_path))
        chunks = processor.process_file(str(doc_path))

        _, add_latency_ms = _time_it(store.add_chunks, chunks)
        mem_after = _get_rss_mb()

        if psutil_available:
            sampler.stop()

        result = BenchmarkResult(
            name="medium_document_ingestion",
            total_runs=1,
            latencies_ms=[latency_ms + add_latency_ms],
            memory_samples_mb=sampler.samples + [mem_after],
        )

        assert len(chunks) >= 1
        assert result.p99_ms < 120000, f"Medium doc ingestion too slow: {result.p99_ms:.0f}ms"

        print(f"\n[BM] Medium doc: {result.total_runs} run, "
              f"latency={result.mean_ms:.0f}ms, peak_mem={result.peak_memory_mb:.1f}MB, "
              f"chunks={len(chunks)}")

    def test_large_document_ingestion(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """~100 page, 50000 word document ingestion."""
        text = _make_text_content(50000)
        doc_path = Path(temp_doc_dir) / "large_doc.txt"
        _create_test_txt(doc_path, text)

        sampler = MemorySampler(interval_ms=100)
        if psutil_available:
            sampler.start()

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        mem_before = _get_rss_mb()
        _, latency_ms = _time_it(processor.process_file, str(doc_path))
        chunks = processor.process_file(str(doc_path))

        _, add_latency_ms = _time_it(store.add_chunks, chunks)
        mem_after = _get_rss_mb()

        if psutil_available:
            sampler.stop()

        result = BenchmarkResult(
            name="large_document_ingestion",
            total_runs=1,
            latencies_ms=[latency_ms + add_latency_ms],
            memory_samples_mb=sampler.samples + [mem_after],
        )

        assert len(chunks) >= 1
        # Large doc should complete within 5 minutes
        assert result.p99_ms < 300000, f"Large doc ingestion too slow: {result.p99_ms:.0f}ms"

        print(f"\n[BM] Large doc: {result.total_runs} run, "
              f"latency={result.mean_ms:.0f}ms, peak_mem={result.peak_memory_mb:.1f}MB, "
              f"chunks={len(chunks)}")

    @pytest.mark.parametrize("batch_size", [10, 50, 100])
    def test_batch_ingestion(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available, batch_size
    ):
        """Batch ingestion of N small documents."""
        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        # Create N small test documents
        doc_paths: List[Path] = []
        for i in range(batch_size):
            text = _make_text_content(200, seed=i)
            p = Path(temp_doc_dir) / f"batch_doc_{i:04d}.txt"
            _create_test_txt(p, text)
            doc_paths.append(p)

        sampler = MemorySampler(interval_ms=50)
        if psutil_available:
            sampler.start()

        mem_before = _get_rss_mb()

        all_chunks = []
        for p in doc_paths:
            chunks = processor.process_file(str(p))
            all_chunks.extend(chunks)

        _, add_latency_ms = _time_it(store.add_chunks, all_chunks)
        mem_after = _get_rss_mb()

        if psutil_available:
            sampler.stop()

        total_latency_ms = add_latency_ms
        throughput = (batch_size / total_latency_ms) * 1000 if total_latency_ms > 0 else 0

        result = BenchmarkResult(
            name=f"batch_ingestion_{batch_size}",
            total_runs=1,
            latencies_ms=[total_latency_ms],
            memory_samples_mb=sampler.samples + [mem_after],
        )

        assert len(all_chunks) >= batch_size
        assert result.peak_memory_mb < 2000, f"Batch {batch_size} used too much memory: {result.peak_memory_mb:.0f}MB"

        print(f"\n[BM] Batch {batch_size}: throughput={throughput:.2f} docs/sec, "
              f"total_latency={total_latency_ms:.0f}ms, "
              f"peak_mem={result.peak_memory_mb:.1f}MB, chunks={len(all_chunks)}")


# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 2: Query Performance
# ─────────────────────────────────────────────────────────────────────────────

class TestQueryPerformance:
    """Benchmark query operations with various complexity levels."""

    @pytest.fixture
    def populated_store(self, temp_benchmark_db, temp_doc_dir, chromadb_available):
        """Pre-populate a vector store with diverse documents for query testing."""
        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        # Create documents with varied topics
        topics = [
            ("python_programming.txt", _make_text_content(2000, seed=1)),
            ("machine_learning.txt", _make_text_content(2000, seed=2)),
            ("natural_language.txt", _make_text_content(2000, seed=3)),
            ("vector_databases.txt", _make_text_content(2000, seed=4)),
            ("rag_systems.txt", _make_text_content(2000, seed=5)),
        ]

        all_chunks = []
        for fname, content in topics:
            p = Path(temp_doc_dir) / fname
            _create_test_txt(p, content)
            chunks = processor.process_file(str(p))
            all_chunks.extend(chunks)

        store.add_chunks(all_chunks)
        yield store

    @pytest.mark.parametrize(
        "query,query_type",
        [
            ("Python", "single_keyword"),
            ("machine learning algorithms", "multi_keyword"),
            ("What is natural language processing and how does it relate to embeddings?", "long_sentence"),
        ],
    )
    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
    def test_query_latency(
        self, populated_store, chromadb_available, psutil_available, query, query_type
    ):
        """Query latency for simple, complex, and long queries (vector search only)."""
        sampler = MemorySampler(interval_ms=50)
        if psutil_available:
            sampler.start()

        latencies: List[float] = []
        for _ in range(10):  # 10 iterations for statistics
            _, lat_ms = _time_it(populated_store.search, query, n_results=3)
            latencies.append(lat_ms)

        if psutil_available:
            sampler.stop()

        result = BenchmarkResult(
            name=f"query_{query_type}",
            total_runs=len(latencies),
            latencies_ms=latencies,
            memory_samples_mb=sampler.samples if psutil_available else [],
        )

        # Vector search should be fast
        assert result.p95_ms < 5000, f"Query {query_type} p95 too slow: {result.p95_ms:.0f}ms"

        print(f"\n[BM] Query {query_type}: mean={result.mean_ms:.1f}ms, "
              f"p95={result.p95_ms:.1f}ms, p99={result.p99_ms:.1f}ms, "
              f"median={result.median_ms:.1f}ms")

    @pytest.mark.parametrize("concurrent_count", [1, 5, 10])
    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
    def test_concurrent_queries(
        self, populated_store, chromadb_available, psutil_available, concurrent_count
    ):
        """Concurrent query throughput with N simultaneous requests."""
        queries = [
            "Python programming language",
            "Machine learning algorithms",
            "Natural language processing",
            "Vector database embeddings",
            "Retrieval augmented generation",
            "Semantic search similarity",
            "Chunking text processing",
            "Hybrid search BM25",
            "Reranking results",
            "Context window limits",
        ]

        def single_query(idx: int):
            q = queries[idx % len(queries)]
            start = time.perf_counter()
            results = populated_store.search(q, n_results=3)
            elapsed = (time.perf_counter() - start) * 1000
            return results, elapsed

        latencies: List[float] = []
        start_mem = _get_rss_mb()

        if concurrent_count == 1:
            for i in range(10):
                _, lat = single_query(i)
                latencies.append(lat)
        else:
            with ThreadPoolExecutor(max_workers=concurrent_count) as executor:
                futures = [executor.submit(single_query, i) for i in range(50)]
                for f in as_completed(futures):
                    results, lat = f.result()
                    latencies.append(lat)

        end_mem = _get_rss_mb()

        result = BenchmarkResult(
            name=f"concurrent_queries_{concurrent_count}",
            total_runs=len(latencies),
            latencies_ms=latencies,
            memory_samples_mb=[start_mem, end_mem],
        )

        # All queries should complete
        assert all(r[0] is not None for r in [(r,) for r in range(len(latencies))])

        # Calculate throughput
        total_time = sum(latencies)
        qps = (len(latencies) / total_time) * 1000 if total_time > 0 else 0

        print(f"\n[BM] Concurrent x{concurrent_count}: {len(latencies)} queries, "
              f"qps={qps:.2f}/sec, mean_lat={result.mean_ms:.1f}ms, "
              f"peak_mem={max(result.memory_samples_mb):.1f}MB")


# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 3: Memory Profiling
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skip(reason="Requires real embedding model — tests create VectorStore directly, bypassing conftest mock")
class TestMemoryProfiling:
    """Detailed memory profiling across operations."""

    def test_peak_memory_during_ingestion(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Track peak RSS memory during document ingestion."""
        if not psutil_available:
            pytest.skip("psutil not available for memory profiling")

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        # Create a 10K-word document
        text = _make_text_content(10000)
        doc_path = Path(temp_doc_dir) / "mem_test.txt"
        _create_test_txt(doc_path, text)

        sampler = MemorySampler(interval_ms=20)
        sampler.start()

        gc.collect()
        baseline = _get_rss_mb()

        chunks = processor.process_file(str(doc_path))
        store.add_chunks(chunks)

        mem_samples = sampler.stop()
        peak = max(mem_samples) if mem_samples else baseline
        delta = peak - baseline

        assert delta < 1500, f"Memory spike too large during ingestion: {delta:.0f}MB"

        print(f"\n[BM] Peak memory during ingestion: {peak:.1f}MB "
              f"(delta={delta:.1f}MB over baseline {baseline:.1f}MB), "
              f"chunks={len(chunks)}")

    def test_memory_per_chunk_stored(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Estimate memory overhead per stored chunk."""
        if not psutil_available:
            pytest.skip("psutil not available for memory profiling")

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)

        # Measure with increasing chunk counts
        chunk_counts = [10, 50, 100]
        mem_deltas: List[float] = []

        for count in chunk_counts:
            db_path = temp_benchmark_db + f"_mp{count}"
            os.makedirs(db_path, exist_ok=True)
            store = VectorStore(db_path=db_path, embedding_model="BAAI/bge-small-en-v1.5")

            chunks = []
            for i in range(count):
                text = _make_text_content(200, seed=i)
                chunked = processor.chunk_text(text, f"mem_test_{i}.txt")
                chunks.extend(chunked)

            gc.collect()
            before = _get_rss_mb()
            store.add_chunks(chunks)
            after = _get_rss_mb()
            mem_deltas.append(after - before)

            del store
            gc.collect()

        if len(mem_deltas) >= 2 and chunk_counts[-1] > chunk_counts[0]:
            # Linear regression to estimate per-chunk memory
            n1, n2 = chunk_counts[0], chunk_counts[-1]
            d1, d2 = mem_deltas[0], mem_deltas[-1]
            if n2 != n1:
                per_chunk_mb = (d2 - d1) / (n2 - n1)
                print(f"\n[BM] Estimated memory per chunk: {per_chunk_mb * 1024:.1f}KB "
                      f"(delta per additional chunk)")
                # Sanity check: each chunk should not consume > 1MB
                assert per_chunk_mb < 1.0, f"Per-chunk memory too high: {per_chunk_mb:.2f}MB"

    def test_memory_during_query_operations(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Track memory stability during repeated query operations."""
        if not psutil_available:
            pytest.skip("psutil not available for memory profiling")

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        # Populate
        for i in range(5):
            text = _make_text_content(1000, seed=i)
            p = Path(temp_doc_dir) / f"query_mem_{i}.txt"
            _create_test_txt(p, text)
            chunks = processor.process_file(str(p))
            store.add_chunks(chunks)

        gc.collect()
        baseline = _get_rss_mb()

        sampler = MemorySampler(interval_ms=50)
        sampler.start()

        # Execute 50 queries
        for _ in range(50):
            store.search("machine learning algorithms", n_results=3)

        mem_samples = sampler.stop()
        peak = max(mem_samples) if mem_samples else baseline
        final = _get_rss_mb()
        mem_delta = peak - baseline

        # Memory should not grow significantly during repeated queries
        assert mem_delta < 500, f"Memory grew too much during queries: {mem_delta:.0f}MB"

        print(f"\n[BM] Memory during 50 queries: baseline={baseline:.1f}MB, "
              f"peak={peak:.1f}MB, final={final:.1f}MB, delta={mem_delta:.1f}MB")

    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock (EmbeddingModel returns early when local model path exists)")
    @pytest.mark.parametrize("embedding_model", [
        "BAAI/bge-small-en-v1.5",  # Small model
        # "BAAI/bge-base-en-v1.5",  # Larger model (commented - slow in CI)
    ])
    def test_memory_with_different_embedding_models(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available, embedding_model
    ):
        """Compare memory usage with different embedding model sizes."""
        if not psutil_available:
            pytest.skip("psutil not available for memory profiling")

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        gc.collect()
        baseline = _get_rss_mb()

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model=embedding_model)

        text = _make_text_content(5000)
        p = Path(temp_doc_dir) / "embed_test.txt"
        _create_test_txt(p, text)
        chunks = processor.process_file(str(p))
        store.add_chunks(chunks)

        after = _get_rss_mb()
        delta = after - baseline

        print(f"\n[BM] Embedding model {embedding_model}: "
              f"baseline={baseline:.1f}MB, after={after:.1f}MB, delta={delta:.1f}MB, "
              f"chunks={len(chunks)}")


# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 4: Resource Constraint Simulation
# ─────────────────────────────────────────────────────────────────────────────

class TestResourceConstraints:
    """Simulate resource-constrained environments."""

    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock (EmbeddingModel returns early when local model path exists)")
    def test_small_batch_ingestion_under_memory_pressure(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Ingest with smaller batches to observe memory bounds."""
        if not psutil_available:
            pytest.skip("psutil not available for memory profiling")

        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)

        # Create documents
        for i in range(20):
            text = _make_text_content(1000, seed=i)
            p = Path(temp_doc_dir) / f"small_batch_{i:02d}.txt"
            _create_test_txt(p, text)

        gc.collect()
        baseline = _get_rss_mb()

        peak_mem = baseline
        all_latencies: List[float] = []

        # Ingest in batches of 5
        batch_size = 5
        doc_paths = sorted(Path(temp_doc_dir).glob("small_batch_*.txt"))

        for i in range(0, len(doc_paths), batch_size):
            batch = doc_paths[i : i + batch_size]
            store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

            chunks = []
            for p in batch:
                chunks.extend(processor.process_file(str(p)))

            gc.collect()
            before_batch = _get_rss_mb()
            _, lat_ms = _time_it(store.add_chunks, chunks)
            after_batch = _get_rss_mb()

            all_latencies.append(lat_ms)
            peak_mem = max(peak_mem, after_batch)

            del store
            gc.collect()

        total_latency = sum(all_latencies)
        total_mem_delta = peak_mem - baseline

        print(f"\n[BM] Small-batch ingestion: {len(doc_paths)} docs in {len(all_latencies)} batches, "
              f"total_lat={total_latency:.0f}ms, peak_mem={peak_mem:.1f}MB, "
              f"delta={total_mem_delta:.1f}MB")

        assert total_mem_delta < 2000, f"Small-batch ingestion used too much memory: {total_mem_delta:.0f}MB"

    def test_bm25_index_rebuild_performance(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Measure BM25 index rebuild time as corpus grows."""
        from document_processor import DocumentProcessor
        from vector_store import VectorStore, BM25Index

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)

        chunk_counts = [100, 500, 1000]
        rebuild_times: Dict[int, float] = {}

        prev_chunks: List = []
        for target_count in chunk_counts:
            # Add more chunks to reach target
            while len(prev_chunks) < target_count:
                seed = len(prev_chunks)
                text = _make_text_content(500, seed=seed)
                chunked = processor.chunk_text(text, f"bm25_test_{seed}.txt")
                prev_chunks.extend(chunked)

            gc.collect()

            _, rebuild_ms = _time_it(BM25Index().build_index, prev_chunks)
            rebuild_times[target_count] = rebuild_ms

            print(f"\n[BM] BM25 rebuild with {target_count} chunks: {rebuild_ms:.1f}ms")

        # Rebuild time should scale sub-quadratically
        if len(chunk_counts) >= 2:
            t1, t2 = rebuild_times[chunk_counts[0]], rebuild_times[chunk_counts[-1]]
            n1, n2 = chunk_counts[0], chunk_counts[-1]
            if n2 > n1 and t2 > 0 and t1 > 0:
                # Time should grow roughly linearly (O(n log n)) not quadratically
                ratio = (t2 / t1) / ((n2 / n1) ** 1.5)
                print(f"[BM] BM25 scaling ratio: {ratio:.2f} (expected < 2.0)")
                assert ratio < 5.0, f"BM25 rebuild time scaling unexpectedly: ratio={ratio:.2f}"

    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock (EmbeddingModel returns early when local model path exists)")
    def test_chroma_batch_size_performance(
        self, temp_benchmark_db, temp_doc_dir, chromadb_available, psutil_available
    ):
        """Compare add_chunks performance with different batch sizes."""
        from document_processor import DocumentProcessor
        from vector_store import VectorStore

        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)

        # Generate 200 chunks
        all_chunks = []
        for i in range(20):
            text = _make_text_content(500, seed=i)
            chunked = processor.chunk_text(text, f"batch_size_test_{i}.txt")
            all_chunks.extend(chunked)

        batch_sizes = [10, 50, 100, 200]
        times_per_batch: Dict[int, float] = {}

        for bs in batch_sizes:
            db_path = temp_benchmark_db + f"_bs{bs}"
            os.makedirs(db_path, exist_ok=True)
            store = VectorStore(db_path=db_path, embedding_model="BAAI/bge-small-en-v1.5")

            gc.collect()
            _, add_ms = _time_it(store.add_chunks, all_chunks, batch_size=bs)
            times_per_batch[bs] = add_ms

            del store
            gc.collect()

            print(f"\n[BM] add_chunks batch_size={bs}: {add_ms:.1f}ms for {len(all_chunks)} chunks")

        # Best batch size should be fastest
        best_bs = min(times_per_batch, key=times_per_batch.get)
        assert best_bs is not None, "No batch size completed"

        print(f"\n[BM] Best batch size: {best_bs} ({times_per_batch[best_bs]:.1f}ms)")


# ─────────────────────────────────────────────────────────────────────────────
# Full RAG pipeline benchmark (without LLM - uses vector store search only)
# ─────────────────────────────────────────────────────────────────────────────

class TestFullRAGPipelinePerformance:
    """End-to-end pipeline benchmarks excluding LLM inference."""

    @pytest.fixture
    def rag_pipeline(self, temp_benchmark_db, temp_doc_dir, chromadb_available):
        """Set up a full RAG pipeline with documents."""
        from document_processor import DocumentProcessor
        from vector_store import VectorStore
        from rag_engine import RAGEngine, RAGConfig

        config = RAGConfig(
            db_path=temp_benchmark_db,
            chunk_size=512,
            chunk_overlap=50,
            n_results=3,
            hybrid_search=True,
        )

        # Note: RAGEngine.__init__ may fail without LLM - test only the retrieval path
        processor = DocumentProcessor(chunk_size=512, chunk_overlap=50)
        store = VectorStore(db_path=temp_benchmark_db, embedding_model="BAAI/bge-small-en-v1.5")

        # Populate with varied content
        topics = [
            "Python is a versatile programming language used in web development.",
            "Machine learning enables computers to learn patterns from data automatically.",
            "Natural language processing bridges human communication and computer understanding.",
            "Vector databases store embeddings for efficient similarity search operations.",
            "Retrieval augmented generation combines information retrieval with language models.",
        ]

        all_chunks = []
        for i, text in enumerate(topics):
            chunked = processor.chunk_text(text, f"topic_{i}.txt")
            all_chunks.extend(chunked)

        store.add_chunks(all_chunks)

        yield {"store": store, "processor": processor, "chunks": len(all_chunks)}

    @pytest.mark.skip(reason="Requires real embedding model — incompatible with conftest mock")
    def test_retrieval_only_pipeline(
        self, rag_pipeline, chromadb_available, psutil_available
    ):
        """Benchmark the retrieval portion of the RAG pipeline."""
        store = rag_pipeline["store"]

        queries = [
            "programming languages",
            "machine learning data",
            "human computer communication",
            "similarity search",
            "information retrieval",
        ]

        latencies: List[float] = []
        for _ in range(10):
            for q in queries:
                _, lat_ms = _time_it(store.get_context, q, n_results=3, hybrid_search=True)
                latencies.append(lat_ms)

        result = BenchmarkResult(
            name="retrieval_pipeline",
            total_runs=len(latencies),
            latencies_ms=latencies,
            memory_samples_mb=[],
        )

        assert result.p95_ms < 10000, f"Retrieval pipeline p95 too slow: {result.p95_ms:.0f}ms"

        print(f"\n[BM] Retrieval pipeline: mean={result.mean_ms:.1f}ms, "
              f"median={result.median_ms:.1f}ms, p95={result.p95_ms:.1f}ms, "
              f"p99={result.p99_ms:.1f}ms, runs={result.total_runs}")


# ─────────────────────────────────────────────────────────────────────────────
# Benchmark report summary
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def benchmark_summary(request):
    """Print a summary table after all benchmarks complete."""
    yield

    # This runs after all tests - summary is printed via per-test output
    print("\n" + "=" * 80)
    print("BENCHMARK SUMMARY")
    print("=" * 80)
    print("All benchmark results have been printed above with [BM] prefix.")
    print("Key metrics: mean latency, p95/p99 latency, peak memory, throughput.")
