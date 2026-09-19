"""Backend-agnostic conformance suite for the Document Q&A API contract.

Verifies a running server (or an in-process ASGI app) against the frozen
contract in contracts/api.openapi.yaml (issue #51). Exit 0 = conformant.

Usage (from the repository root):
    python contracts/tests/run_conformance.py --asgi api_server:app
    python contracts/tests/run_conformance.py --base-url http://127.0.0.1:8080
        [--safe]     skip destructive routes (DELETE /documents, /ingest*)

Modes:
- --base-url: real HTTP against ANY conforming backend (Python today, the
  Electron host from WS-B #61 later).
- --asgi <module>:attr: import the app, install a deterministic stub engine
  (no model weights needed) and drive it through ASGITransport. Also runs the
  asgi-only checks: cancelled-stream terminal shape and the contract-drift
  check that the app's own OpenAPI route set matches contracts/api.openapi.yaml.

Dependencies: httpx (and PyYAML for the drift check when available).
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "contracts" / "api.openapi.yaml"

sys.path.insert(0, str(REPO_ROOT))

import httpx  # noqa: E402


class _StubResult:
    question = "What is Python?"
    answer = "A programming language."
    sources = ["doc1.txt"]
    context_length = 100
    inference_time = 0.5


def _make_stub_engine(recorder: dict):
    class _StubLLM:
        pass

    class _StubEngine:
        llm = _StubLLM()

        def query(
            self,
            question,
            n_results=6,
            stream_callback=None,
            conversation_history=None,
            cancellation_event=None,
        ):
            recorder["query_calls"] += 1
            recorder["last_history"] = conversation_history
            recorder["last_cancellation_event"] = cancellation_event
            if stream_callback:
                for tok in ("Conformance ", "token ", "stream."):
                    stream_callback(tok)
            return _StubResult()

        def search_documents(self, query, n_results=5):
            return [("Conformance chunk", {"source": "doc1.txt"}, 0.9)]

        def get_all_documents(self):
            return []

        def clear_documents(self):
            return None

        def get_stats(self):
            return {
                "document_count": 0,
                "chunk_count": 0,
                "embedding_model": "stub",
                "llm": {"backend": "stub"},
                "documents": [],
            }

    return _StubEngine


class Conformance:
    def __init__(self, client: httpx.AsyncClient, asgi: bool):
        self.client = client
        self.asgi = asgi
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.skipped: list[str] = []

    def record(self, name: str, ok: bool, detail: str = ""):
        if ok:
            self.passed.append(name)
            print(f"  PASS {name}" + (f" — {detail}" if detail else ""))
        else:
            self.failed.append((name, detail))
            print(f"  FAIL {name} — {detail}")

    def skip(self, name: str, why: str):
        self.skipped.append(name)
        print(f"  SKIP {name} — {why}")

    async def get(self, path: str, **kw):
        return await self.client.get(path, **kw)

    async def post(self, path: str, **kw):
        return await self.client.post(path, **kw)

    # ---- checks -----------------------------------------------------------

    async def check_health(self):
        r = await self.get("/health")
        ok = r.status_code == 200
        body = {}
        if ok:
            body = r.json()
            ok = body.get("status") == "ok" and isinstance(
                body.get("engine_ready"), bool
            )
        self.record("health", ok, f"status={r.status_code} body={body}")

    async def check_auth_status(self):
        r = await self.get("/auth/status")
        ok = r.status_code == 200
        if ok:
            body = r.json()
            ok = (
                isinstance(body.get("enabled"), bool)
                and isinstance(body.get("jwt_available"), bool)
                and isinstance(body.get("methods"), list)
            )
            self.record("auth_status", ok, f"body={body}")
        else:
            self.record("auth_status", False, f"status={r.status_code}")

    async def check_auth_token_rejects_bad_key(self):
        r = await self.post("/auth/token", json={"api_key": "definitely-wrong"})
        # 401 when auth enabled; 503 when auth is disabled (endpoint refuses).
        ok = r.status_code in (401, 503)
        self.record(
            "auth_token_rejects_bad_key",
            ok,
            f"status={r.status_code} (401 or 503 expected)",
        )

    async def check_ask(self):
        history = [
            {"role": "user", "content": "What is Python?"},
            {"role": "assistant", "content": "A programming language."},
        ]
        r = await self.post(
            "/ask",
            json={"question": "What is Python?", "history": history},
        )
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            body = r.json()
            required = {
                "question",
                "answer",
                "sources",
                "context_length",
                "inference_time",
                # C5 (issue #72): grounded/general provenance is required on
                # every ask response since C5, on every backend.
                "grounding",
            }
            missing = required - set(body)
            ok = not missing
            detail += f" missing={sorted(missing)}" if missing else " all keys present"
        if ok:
            # C5: the value must be the contract enum, not just present.
            grounding_ok = body.get("grounding") in ("grounded", "general")
            detail += f" grounding={body.get('grounding')!r}"
            ok = grounding_ok
        self.record("ask", ok, detail)

    @staticmethod
    def parse_sse(raw: str):
        events = []
        for block in raw.replace("\r\n", "\n").split("\n\n"):
            block = block.strip()
            if not block:
                continue
            name, data = "message", None
            for line in block.splitlines():
                if line.startswith("event:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    data = line.split(":", 1)[1].strip()
            if data is not None:
                try:
                    data = json.loads(data)
                except (ValueError, TypeError):
                    # Surface malformed payloads to the checks instead of
                    # silently passing them through (PRR-011).
                    name = "malformed"
            events.append((name, data))
        return events

    SSE_BODY_CAP = 5 * 1024 * 1024

    async def read_capped_stream(self, resp):
        """Read an SSE response body with a hard byte cap (PRR-011)."""
        chunks, total = [], 0
        async for chunk in resp.aiter_bytes():
            total += len(chunk)
            if total > self.SSE_BODY_CAP:
                raise ValueError(f"SSE body exceeds {self.SSE_BODY_CAP} byte cap")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8", errors="replace")

    async def check_ask_stream(self):
        r = await self.post("/ask/stream", json={"question": "conformance?"})
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            ctype = r.headers.get("content-type", "")
            detail += f" ctype={ctype}"
            ok = ctype.startswith("text/event-stream")
        if ok:
            body = await self.read_capped_stream(r)
            events = self.parse_sse(body)
            tokens = [p for e, p in events if isinstance(p, dict) and "token" in p]
            terminals = [
                p
                for e, p in events
                if (
                    e == "error"
                    or (isinstance(p, dict) and ("done" in p or "error" in p))
                )
            ]
            done_ok = (
                len(terminals) == 1
                and isinstance(terminals[0], dict)
                and terminals[0].get("done") is True
                and "sources" in terminals[0]
                and "context_length" in terminals[0]
                # C5 (issue #72): terminal done events carry provenance.
                and terminals[0].get("grounding") in ("grounded", "general")
            )
            ok = len(tokens) >= 1 and done_ok
            malformed = sum(1 for e, _ in events if e == "malformed")
            ok = ok and malformed == 0
            detail += (
                f" tokens={len(tokens)} terminals={len(terminals)}"
                f" malformed={malformed}"
            )
        self.record("ask_stream", ok, detail)

    async def check_ask_stream_cancelled(self, recorder: dict):
        if not (self.asgi and recorder.get("cancel_engine") is not None):
            self.skip("ask_stream_cancelled", "requires --asgi stub (cancel_engine)")
            return
        r = await self.post("/ask/stream", json={"question": "cancel me"})
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            events = self.parse_sse(r.text)
            terminals = [
                p
                for e, p in events
                if isinstance(p, dict) and ("done" in p or "error" in p)
            ]
            ok = (
                len(terminals) == 1
                and terminals[0].get("done") is True
                and terminals[0].get("cancelled") is True
                and "sources" in terminals[0]
                and "context_length" in terminals[0]
                # C5 (issue #72): the schema requires grounding on EVERY
                # terminal done event, cancelled included — same enum
                # assertion as check_ask / check_ask_stream.
                and terminals[0].get("grounding") in ("grounded", "general")
            )
            detail += f" terminals={terminals!r:.200}"
        self.record("ask_stream_cancelled", ok, detail)

    async def check_search(self):
        r = await self.post("/search", json={"query": "conformance", "n_results": 3})
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            body = r.json()
            ok = isinstance(body, list) and all(
                isinstance(x, dict) and {"text", "source", "similarity"} <= set(x)
                for x in body
            )
        self.record("search", ok, detail)

    async def check_documents_list(self):
        r = await self.get("/documents")
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            body = r.json()
            ok = "documents" in body and "total" in body
        self.record("documents_list", ok, detail)

    async def check_documents_delete(self, safe: bool):
        if safe or not self.destructive_ok:
            self.skip(
                "documents_delete",
                "destructive DELETE skipped (non-destructive mode; pass --destructive)",
            )
            return
        r = await self.client.delete("/documents")
        ok = r.status_code == 200 and r.json().get("status") == "cleared"
        self.record("documents_delete", ok, f"status={r.status_code}")

    async def check_settings_roundtrip(self):
        r = await self.get("/settings")
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        original = None
        if ok:
            original = r.json()
            required = {
                "chunk_size",
                "chunk_overlap",
                "n_results",
                "min_similarity",
                "temperature",
                "max_tokens",
                "hybrid_search",
                "reranking_enabled",
                "context_truncation",
                "retrieval_window",
                "initial_retrieval_top_k",
                "rerank_top_k",
                # C4 (issue #71): mirror the OpenAPI SettingsResponse
                # required list so desktop-host drift cannot recur.
                "packs_recency_half_life_months",
                "packs_recency_floor_months",
                "packs_recency_floor",
            }
            missing = required - set(original)
            ok = not missing
            detail += (
                f" missing={sorted(missing)}"
                if missing
                else f" {len(required)} keys present"
            )
        if ok:
            target = 4 if original.get("n_results") != 4 else 5
            r2 = await self.client.put("/settings", json={"rag_n_results": target})
            ok2 = r2.status_code == 200 and r2.json().get("n_results") == target
            detail += f"; PUT rag_n_results={target} -> {r2.status_code}"
            ok = ok and ok2
            # restore
            await self.client.put(
                "/settings", json={"rag_n_results": original.get("n_results", 6)}
            )
        self.record("settings_roundtrip", ok, detail)

    async def check_stats(self):
        r = await self.get("/stats")
        ok = r.status_code == 200
        detail = f"status={r.status_code}"
        if ok:
            body = r.json()
            ok = {"document_count", "chunk_count", "embedding_model"} <= set(body)
        self.record("stats", ok, detail)

    async def check_contract_drift(self, app=None):
        """Spec paths must equal the app's live OpenAPI paths (asgi only)."""
        if not self.asgi or app is None:
            self.skip("contract_drift", "requires --asgi app object")
            return
        try:
            import yaml  # type: ignore
        except ImportError:
            self.skip("contract_drift", "PyYAML not installed")
            return
        spec = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
        spec_paths = set(spec.get("paths", {}).keys())
        live_paths = set(app.openapi()["paths"].keys())
        # "/" serves either the packaged web archive or a health JSON payload
        # (api_server root()); it is the archive mount point, documented
        # outside the API contract. Framework doc routes are likewise exempt.
        exempt = {"/", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
        missing = spec_paths - live_paths
        extra = {p for p in live_paths - spec_paths if p not in exempt}
        # Bidirectional freeze: an app route missing from the spec AND a spec
        # path missing from the app are both drift — either fails the check.
        ok = not missing and not extra
        detail = f"missing_from_app={sorted(missing)} extra_in_app={sorted(extra)}"
        self.record("contract_drift", ok, detail)


async def run(
    asgi_target: str | None, base_url: str | None, safe: bool, destructive: bool
) -> int:
    recorder: dict = {"query_calls": 0}
    app = None
    if asgi_target:
        module_name, _, attr = asgi_target.partition(":")
        module = importlib.import_module(module_name)
        app = getattr(module, attr)

        # Deterministic stub engine (no model weights). Also install a
        # QueryCancelled-raising twin for the cancelled-stream check.
        import llm_interface

        stub = _make_stub_engine(recorder)()
        module.engine = stub

        class CancelEngine(type(stub)):
            def query(self, *a, **kw):
                stream_callback = kw.get("stream_callback")
                if stream_callback:
                    stream_callback("partial ")
                raise llm_interface.QueryCancelled()

        recorder["cancel_engine"] = CancelEngine()

    transport = (
        httpx.ASGITransport(app=app) if asgi_target else httpx.AsyncHTTPTransport()
    )
    base = "http://conformance.local" if asgi_target else base_url
    results = Conformance(
        httpx.AsyncClient(transport=transport, base_url=base), bool(asgi_target)
    )
    # Destructive routes run only in-process (stub, nothing to lose) or when
    # the operator explicitly opts in for a remote server.
    results.destructive_ok = bool(asgi_target) or destructive

    print(
        f"Conformance target: {'asgi:' + asgi_target if asgi_target else base_url} safe={safe}"
    )

    async def _body():
        if asgi_target:
            # Swap the stub engine per-check where needed.
            await results.check_health()
            await results.check_auth_status()
            await results.check_auth_token_rejects_bad_key()
            await results.check_ask()
            await results.check_ask_stream()
            module.engine = recorder["cancel_engine"]
            await results.check_ask_stream_cancelled(recorder)
            module.engine = stub
            await results.check_search()
            await results.check_documents_list()
            await results.check_documents_delete(safe)
            await results.check_settings_roundtrip()
            await results.check_stats()
            await results.check_contract_drift(app)
        else:
            await results.check_health()
            await results.check_auth_status()
            await results.check_auth_token_rejects_bad_key()
            await results.check_ask()
            await results.check_ask_stream()
            results.skip("ask_stream_cancelled", "--base-url mode")
            await results.check_search()
            await results.check_documents_list()
            await results.check_documents_delete(safe)
            await results.check_settings_roundtrip()
            await results.check_stats()
            results.skip("contract_drift", "--base-url mode")

    if asgi_target:
        await _body()
    else:
        async with results.client:
            await _body()
    if asgi_target:
        await results.client.aclose()

    total = len(results.passed) + len(results.failed)
    print(
        f"CONFORMANCE: {'PASS' if not results.failed else 'FAIL'} "
        f"{len(results.passed)}/{total} checks passed, {len(results.skipped)} skipped"
    )
    for name, detail in results.failed:
        print(f"  failed: {name}: {detail}")
    return 0 if not results.failed else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--asgi", help="in-process target, e.g. api_server:app")
    group.add_argument("--base-url", help="running server base URL")
    ap.add_argument("--safe", action="store_true", help="skip destructive routes")
    ap.add_argument(
        "--destructive",
        action="store_true",
        help="allow destructive routes (DELETE /documents) in --base-url mode; "
        "default is to skip them so a conformance run never wipes a live server",
    )
    args = ap.parse_args()
    return asyncio.run(run(args.asgi, args.base_url, args.safe, args.destructive))


if __name__ == "__main__":
    sys.exit(main())
