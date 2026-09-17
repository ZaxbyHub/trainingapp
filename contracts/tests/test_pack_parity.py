#!/usr/bin/env python
"""test_pack_parity.py — cross-backend chunk-id parity proof (issue #70, AC1).

Installs contracts/fixtures/packs/versioned-a-1.0.0 through BOTH real
implementations and fails on any chunk-id mismatch:

  1. Python leg: the real C2 PackManager (pack_manager.py) against a real
     ChromaDB store in a temp dir; chunk ids come from the live collection.
  2. Node leg: this script spawns the frozen vitest subject
     (desktop/src/__tests__/c3-pack-parity.test.ts) with
       C3_PARITY_FIXTURE = absolute path of a fresh fixture copy,
       C3_PARITY_OUT     = absolute JSON dump path (parent pre-created),
     and the Node PackManager writes its chunk-id set there.

Chunk identity is a pure function of (doc_sha256, chunk_index,
normalized_text) — the embedders differ between the legs (deterministic
stubs), which is exactly why a mismatch would expose a chunking/normalization
drift. Run standalone (`python contracts/tests/test_pack_parity.py`) or under
pytest. Requires desktop/node_modules for the Node leg (CI has it); the Node
leg is skipped with a clear reason when it is absent.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

FIXTURE = REPO / "contracts" / "fixtures" / "packs" / "versioned-a-1.0.0"
DESKTOP = REPO / "desktop"


def _python_chunk_ids(workspace: Path) -> set:
    """Install the fixture with the real C2 PackManager; return chunk ids."""
    from pack_manager import PackManager  # noqa: E402
    from vector_store import VectorStore  # noqa: E402

    class StubEmbeddingModel:
        def __init__(self, model_name=None):
            self.model_name = model_name or "stub"

        def encode(self, texts):
            return [[0.1] * 384 for _ in texts]

        def encode_single(self, text):
            return [0.1] * 384

    with patch("vector_store.EmbeddingModel", StubEmbeddingModel):
        store = VectorStore(db_path=str(workspace / "py-db"), embedding_model="stub")
        manager = PackManager(store, packs_root=workspace / "py-packs")
        source = workspace / "fixture"
        shutil.copytree(FIXTURE, source)
        result = manager.install(source)
        assert result.chunks_added > 0, result
        return set(store.collection.get()["ids"])


def _node_chunk_ids(workspace: Path) -> set:
    """Spawn the frozen vitest parity leg; read the dumped chunk-id set."""
    if not (DESKTOP / "node_modules" / "better-sqlite3").exists():
        print("SKIP: desktop/node_modules absent — Node parity leg skipped")
        return None
    fixture = workspace / "fixture-node"
    shutil.copytree(FIXTURE, fixture)
    out_path = workspace / "node-ids" / "ids.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["C3_PARITY_FIXTURE"] = str(fixture)
    env["C3_PARITY_OUT"] = str(out_path)
    completed = subprocess.run(
        "npx vitest run src/__tests__/c3-pack-parity.test.ts --reporter=basic",
        shell=True,
        cwd=str(DESKTOP),
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "Node parity leg failed:\n"
            + completed.stdout[-4000:]
            + "\n"
            + completed.stderr[-2000:]
        )
    if not out_path.exists():
        raise AssertionError(
            f"Node leg wrote no dump at {out_path} (env propagation failed?)"
        )
    return set(json.loads(out_path.read_text(encoding="utf-8")))


def run_parity() -> None:
    """The AC1 proof: both installs of the same fixture agree on chunk ids."""
    workspace = Path(tempfile.mkdtemp(prefix="c3-parity-"))
    try:
        py_ids = _python_chunk_ids(workspace)
        print(f"[parity] python chunk ids ({len(py_ids)}): {sorted(py_ids)}")
        node_ids = _node_chunk_ids(workspace)
        if node_ids is None:
            # Node deps unavailable (local env); the frozen C1 check re-runs
            # this script where they exist (CI, worktrees with node_modules).
            return
        print(f"[parity] node chunk ids ({len(node_ids)}): {sorted(node_ids)}")
        assert py_ids == node_ids, (
            "cross-backend chunk-id parity FAILED: "
            f"python-only={sorted(py_ids - node_ids)} "
            f"node-only={sorted(node_ids - py_ids)}"
        )
        print("[parity] OK: python and Node installs produce identical chunk-id sets")
    finally:
        # chromadb keeps its .bin open past the leg — best-effort cleanup only
        # (the dir lives in the OS temp root, same as pytest's tmp_path).
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    """Standalone entry: the frozen check script (repro/check-c1.sh) owns the
    PASS/FAIL sentinel and derives it from this exit code — this script only
    diagnoses."""
    try:
        run_parity()
    except AssertionError as error:
        print(f"parity FAILED: {error}")
        return 1
    except Exception as error:  # noqa: BLE001 — the check needs one exit code
        print(f"parity ERROR: {type(error).__name__}: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# --- pytest surface (contracts/tests is outside pytest.ini testpaths; the
# CI step or a direct `pytest contracts/tests/test_pack_parity.py` uses this) ---
def test_pack_parity():  # noqa: D103 — the docstring lives on the module
    run_parity()
